use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::Arc,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use time::OffsetDateTime;
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use url::Url;

use crate::{
    config::MAX_ACTOR_CONNECTIONS,
    lifecycle::{ActorFrameResult, ControlLifecycle},
    service_auth::{ServiceSigningKey, mint_service_jwt},
    store::StoreError,
    websocket_client::authenticated_client_request,
};

const SUBSCRIBE_RECORDS_LXM: &str = "zone.stratos.sync.subscribeRecords";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const BASE_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
const MAX_ACTOR_FRAME_BYTES: usize = 32 * 1024;
const DEFAULT_MAX_CONNECTIONS: u16 = 8;
const MAX_TRACKED_ACTORS: usize = 4_096;
const ENROLLMENT_PAGE_SIZE: u16 = 128;
const IDLE_ROTATION_AFTER: Duration = Duration::from_secs(2);
const MAX_WORKER_LEASE: Duration = Duration::from_secs(15);
const MAX_FAILED_WORKER_LEASE: Duration = Duration::from_secs(15);
const CLOSE_TIMEOUT: Duration = Duration::from_millis(500);

/// Configures the fixed-resource actor subscription pool.
#[derive(Clone)]
pub struct ActorStreamConfig {
    pub service_url: String,
    pub service_did: String,
    pub feedgen_did: String,
    pub signing_key: ServiceSigningKey,
    pub retention: Duration,
    pub max_connections: u16,
}

impl ActorStreamConfig {
    pub fn with_defaults(
        service_url: String,
        service_did: String,
        feedgen_did: String,
        signing_key: ServiceSigningKey,
        retention: Duration,
    ) -> Self {
        Self {
            service_url,
            service_did,
            feedgen_did,
            signing_key,
            retention,
            max_connections: DEFAULT_MAX_CONNECTIONS,
        }
    }
}

#[derive(Debug)]
pub enum ActorPoolError {
    InvalidConfiguration,
    CapacityExceeded,
    Stopped,
    Store(StoreError),
}

impl fmt::Display for ActorPoolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Feedgen NG actor subscriptions are unavailable")
    }
}

impl std::error::Error for ActorPoolError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActorPoolStats {
    pub active: usize,
    pub waiting: usize,
    pub max_connections: u16,
}

/// Owns bounded actor subscriptions and reconnects each actor from its durable cursor.
pub struct ActorPool {
    lifecycle: Arc<ControlLifecycle>,
    service_did: String,
    failures: watch::Sender<u64>,
    commands: mpsc::Sender<PoolCommand>,
    manager: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ActorPool {
    pub fn start(
        config: ActorStreamConfig,
        lifecycle: Arc<ControlLifecycle>,
    ) -> Result<Arc<Self>, ActorPoolError> {
        validate_config(&config)?;
        let (commands, receiver) = mpsc::channel(32);
        let (failures, _) = watch::channel(0_u64);
        let pool = Arc::new(Self {
            lifecycle: Arc::clone(&lifecycle),
            service_did: config.service_did.clone(),
            failures: failures.clone(),
            commands,
            manager: tokio::sync::Mutex::new(None),
        });
        let manager = tokio::spawn(run_manager(config, lifecycle, failures, receiver));
        *pool
            .manager
            .try_lock()
            .expect("actor pool manager lock is uncontended during startup") = Some(manager);
        Ok(pool)
    }

    /// Replaces the desired workers with the current durable enrollment set.
    pub async fn sync_from_store(&self) -> Result<ActorPoolStats, ActorPoolError> {
        let mut after_did = None;
        let mut actors = BTreeSet::new();
        loop {
            let page = self
                .lifecycle
                .list_actor_enrollments_page(after_did.as_deref(), ENROLLMENT_PAGE_SIZE)
                .map_err(ActorPoolError::Store)?;
            if page.is_empty() {
                break;
            }
            for actor in &page {
                if actors.len() == MAX_TRACKED_ACTORS {
                    return Err(ActorPoolError::CapacityExceeded);
                }
                actors.insert(actor.did.clone());
            }
            after_did = page.last().map(|actor| actor.did.clone());
        }
        self.replace(actors).await
    }

    /// Starts or stops one worker after its enrollment has been durably updated.
    pub async fn sync_actor(&self, did: &str) -> Result<ActorPoolStats, ActorPoolError> {
        let enrolled = self
            .lifecycle
            .actor_sync_state(&self.service_did, did)
            .map_err(ActorPoolError::Store)?
            .is_some();
        let (reply, result) = oneshot::channel();
        self.commands
            .send(PoolCommand::SetActor {
                did: did.to_owned(),
                enrolled,
                reply,
            })
            .await
            .map_err(|_| ActorPoolError::Stopped)?;
        result.await.map_err(|_| ActorPoolError::Stopped)?
    }

    pub async fn stats(&self) -> Result<ActorPoolStats, ActorPoolError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(PoolCommand::Stats { reply })
            .await
            .map_err(|_| ActorPoolError::Stopped)?;
        result.await.map_err(|_| ActorPoolError::Stopped)
    }

    /// Signals that an actor failed to keep its durable projection current.
    pub fn failure_receiver(&self) -> watch::Receiver<u64> {
        self.failures.subscribe()
    }

    /// Stops workers and waits for every frame already admitted by the lifecycle.
    pub async fn stop(&self) {
        let (reply, result) = oneshot::channel();
        if self
            .commands
            .send(PoolCommand::Stop { reply })
            .await
            .is_ok()
        {
            let _ = result.await;
        }
        if let Some(manager) = self.manager.lock().await.take() {
            let _ = manager.await;
        }
    }

    async fn replace(&self, actors: BTreeSet<String>) -> Result<ActorPoolStats, ActorPoolError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(PoolCommand::Replace { actors, reply })
            .await
            .map_err(|_| ActorPoolError::Stopped)?;
        result.await.map_err(|_| ActorPoolError::Stopped)?
    }
}

enum PoolCommand {
    Replace {
        actors: BTreeSet<String>,
        reply: oneshot::Sender<Result<ActorPoolStats, ActorPoolError>>,
    },
    SetActor {
        did: String,
        enrolled: bool,
        reply: oneshot::Sender<Result<ActorPoolStats, ActorPoolError>>,
    },
    Stats {
        reply: oneshot::Sender<ActorPoolStats>,
    },
    Stop {
        reply: oneshot::Sender<()>,
    },
}

struct ActiveWorker {
    id: u64,
    shutdown: watch::Sender<bool>,
}

struct WorkerFinished {
    did: String,
    id: u64,
}

#[derive(Default)]
struct Rotation {
    last_started: BTreeMap<String, u64>,
    next_id: u64,
}

async fn run_manager(
    config: ActorStreamConfig,
    lifecycle: Arc<ControlLifecycle>,
    failures: watch::Sender<u64>,
    mut commands: mpsc::Receiver<PoolCommand>,
) {
    let (finished, mut workers) = mpsc::unbounded_channel::<WorkerFinished>();
    let mut desired = BTreeSet::new();
    let mut active = BTreeMap::new();
    let mut rotation = Rotation::default();
    let mut stopping: Option<oneshot::Sender<()>> = None;

    loop {
        if stopping.is_some() && active.is_empty() {
            if let Some(reply) = stopping.take() {
                let _ = reply.send(());
            }
            return;
        }
        tokio::select! {
            Some(completion) = workers.recv() => {
                if active.get(&completion.did).is_some_and(|worker: &ActiveWorker| worker.id == completion.id) {
                    active.remove(&completion.did);
                }
                start_waiting_workers(&config, &lifecycle, &failures, &finished, &desired, &mut active, &mut rotation);
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    stop_workers(&active);
                    return;
                };
                match command {
                    PoolCommand::Replace { actors, reply } => {
                        if actors.len() > MAX_TRACKED_ACTORS {
                            let _ = reply.send(Err(ActorPoolError::CapacityExceeded));
                            continue;
                        }
                        desired = actors;
                        rotation.last_started.retain(|did, _| desired.contains(did));
                        stop_removed_workers(&active, &desired);
                        start_waiting_workers(&config, &lifecycle, &failures, &finished, &desired, &mut active, &mut rotation);
                        let _ = reply.send(Ok(stats_for(&desired, &active, config.max_connections)));
                    }
                    PoolCommand::SetActor { did, enrolled, reply } => {
                        if enrolled {
                            if desired.len() == MAX_TRACKED_ACTORS && !desired.contains(&did) {
                                let _ = reply.send(Err(ActorPoolError::CapacityExceeded));
                                continue;
                            }
                            desired.insert(did);
                        } else {
                            desired.remove(&did);
                            rotation.last_started.remove(&did);
                            if let Some(worker) = active.get(&did) {
                                let _ = worker.shutdown.send(true);
                            }
                        }
                        start_waiting_workers(&config, &lifecycle, &failures, &finished, &desired, &mut active, &mut rotation);
                        let _ = reply.send(Ok(stats_for(&desired, &active, config.max_connections)));
                    }
                    PoolCommand::Stats { reply } => {
                        let _ = reply.send(stats_for(&desired, &active, config.max_connections));
                    }
                    PoolCommand::Stop { reply } => {
                        desired.clear();
                        stop_workers(&active);
                        stopping = Some(reply);
                    }
                }
            }
        }
    }
}

fn stats_for(
    desired: &BTreeSet<String>,
    active: &BTreeMap<String, ActiveWorker>,
    max_connections: u16,
) -> ActorPoolStats {
    ActorPoolStats {
        active: active.len(),
        waiting: desired.len().saturating_sub(active.len()),
        max_connections,
    }
}

fn stop_workers(active: &BTreeMap<String, ActiveWorker>) {
    for worker in active.values() {
        let _ = worker.shutdown.send(true);
    }
}

fn stop_removed_workers(active: &BTreeMap<String, ActiveWorker>, desired: &BTreeSet<String>) {
    for (did, worker) in active {
        if !desired.contains(did) {
            let _ = worker.shutdown.send(true);
        }
    }
}

fn start_waiting_workers(
    config: &ActorStreamConfig,
    lifecycle: &Arc<ControlLifecycle>,
    failures: &watch::Sender<u64>,
    finished: &mpsc::UnboundedSender<WorkerFinished>,
    desired: &BTreeSet<String>,
    active: &mut BTreeMap<String, ActiveWorker>,
    rotation: &mut Rotation,
) {
    while active.len() < usize::from(config.max_connections) {
        let Some(did) = next_waiting_actor(desired, active, &rotation.last_started) else {
            return;
        };
        rotation.next_id = rotation.next_id.saturating_add(1);
        let id = rotation.next_id;
        rotation.last_started.insert(did.clone(), id);
        let (shutdown, receiver) = watch::channel(false);
        active.insert(did.clone(), ActiveWorker { id, shutdown });
        let config = config.clone();
        let lifecycle = Arc::clone(lifecycle);
        let failures = failures.clone();
        let finished = finished.clone();
        tokio::spawn(async move {
            run_actor_worker(config, lifecycle, failures, did.clone(), receiver).await;
            let _ = finished.send(WorkerFinished { did, id });
        });
    }
}

fn next_waiting_actor(
    desired: &BTreeSet<String>,
    active: &BTreeMap<String, ActiveWorker>,
    last_started: &BTreeMap<String, u64>,
) -> Option<String> {
    desired
        .iter()
        .filter(|did| !active.contains_key(*did))
        .min_by_key(|did| last_started.get(*did).copied().unwrap_or(0))
        .cloned()
}

async fn run_actor_worker(
    config: ActorStreamConfig,
    lifecycle: Arc<ControlLifecycle>,
    failures: watch::Sender<u64>,
    did: String,
    mut shutdown: watch::Receiver<bool>,
) {
    if actor_subscription_url(&config.service_url, &did, None).is_err() {
        return;
    }
    let mut attempt = 0_u32;
    let mut failure_deadline = None;
    while !*shutdown.borrow() {
        let result = if let Some(deadline) = failure_deadline {
            tokio::select! {
                result = run_actor_connection(&config, &lifecycle, &did, &mut shutdown) => result,
                _ = tokio::time::sleep_until(deadline) => return,
            }
        } else {
            run_actor_connection(&config, &lifecycle, &did, &mut shutdown).await
        };
        if *shutdown.borrow()
            || matches!(
                result,
                Ok(ActorFrameResult::NotEnrolled | ActorFrameResult::Ignored)
            )
        {
            return;
        }
        failures.send_modify(|count| *count = count.saturating_add(1));
        attempt = attempt.saturating_add(1);
        let deadline = *failure_deadline
            .get_or_insert_with(|| tokio::time::Instant::now() + MAX_FAILED_WORKER_LEASE);
        tokio::select! {
            _ = tokio::time::sleep(reconnect_delay(attempt)) => {}
            _ = tokio::time::sleep_until(deadline) => return,
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

async fn run_actor_connection(
    config: &ActorStreamConfig,
    lifecycle: &ControlLifecycle,
    did: &str,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<ActorFrameResult, ActorPoolError> {
    let Some(sync_state) = lifecycle
        .actor_sync_state(&config.service_did, did)
        .map_err(ActorPoolError::Store)?
    else {
        return Ok(ActorFrameResult::NotEnrolled);
    };
    let url = actor_subscription_url(&config.service_url, did, sync_state.cursor)?;
    let now = OffsetDateTime::now_utc();
    let token = mint_service_jwt(
        &config.signing_key,
        &config.feedgen_did,
        &config.service_did,
        SUBSCRIBE_RECORDS_LXM,
        now.unix_timestamp().max(0) as u64,
    )
    .map_err(|_| ActorPoolError::InvalidConfiguration)?;
    let request = authenticated_client_request(&url, &token)
        .map_err(|_| ActorPoolError::InvalidConfiguration)?;
    let websocket_config = WebSocketConfig::default()
        .read_buffer_size(4 * 1024)
        .write_buffer_size(4 * 1024)
        .max_write_buffer_size(8 * 1024)
        .max_message_size(Some(MAX_ACTOR_FRAME_BYTES))
        .max_frame_size(Some(MAX_ACTOR_FRAME_BYTES));
    let connection = tokio::select! {
        changed = shutdown.changed() => {
            if changed.is_err() || *shutdown.borrow() {
                return Ok(ActorFrameResult::NotEnrolled);
            }
            return Err(ActorPoolError::Stopped);
        }
        result = timeout(CONNECT_TIMEOUT, connect_async_with_config(request, Some(websocket_config), true)) => result,
    };
    let (mut socket, _) = connection
        .map_err(|_| ActorPoolError::Stopped)?
        .map_err(|_| ActorPoolError::Stopped)?;
    let lease_deadline = tokio::time::Instant::now() + MAX_WORKER_LEASE;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(IDLE_ROTATION_AFTER) => {
                let _ = timeout(CLOSE_TIMEOUT, socket.close(None)).await;
                return Ok(ActorFrameResult::Ignored);
            }
            _ = tokio::time::sleep_until(lease_deadline) => {
                let _ = timeout(CLOSE_TIMEOUT, socket.close(None)).await;
                return Ok(ActorFrameResult::Ignored);
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = timeout(CLOSE_TIMEOUT, socket.close(None)).await;
                    return Ok(ActorFrameResult::NotEnrolled);
                }
            }
            message = socket.next() => {
                let message = message.ok_or(ActorPoolError::Stopped)?
                    .map_err(|_| ActorPoolError::Stopped)?;
                match message {
                    Message::Binary(frame) => {
                        let retained_at = retention_deadline(OffsetDateTime::now_utc(), config.retention)?;
                        match lifecycle.apply_actor_frame(&frame, &config.service_did, did, &retained_at) {
                            Ok(ActorFrameResult::Applied | ActorFrameResult::Ignored) => {}
                            Ok(ActorFrameResult::NotEnrolled) => return Ok(ActorFrameResult::NotEnrolled),
                            Err(_) => return Err(ActorPoolError::Stopped),
                        }
                    }
                    Message::Ping(payload) => socket.send(Message::Pong(payload)).await.map_err(|_| ActorPoolError::Stopped)?,
                    Message::Close(_) => return Err(ActorPoolError::Stopped),
                    Message::Pong(_) => {}
                    Message::Text(_) | Message::Frame(_) => return Err(ActorPoolError::Stopped),
                }
            }
        }
    }
}

fn validate_config(config: &ActorStreamConfig) -> Result<(), ActorPoolError> {
    if !(1..=MAX_ACTOR_CONNECTIONS).contains(&config.max_connections) || config.retention.is_zero()
    {
        return Err(ActorPoolError::InvalidConfiguration);
    }
    actor_subscription_url(&config.service_url, &config.feedgen_did, None).map(|_| ())
}

fn actor_subscription_url(
    service_url: &str,
    did: &str,
    cursor: Option<u64>,
) -> Result<Url, ActorPoolError> {
    crate::identifier::Did::parse(did.to_owned())
        .map_err(|_| ActorPoolError::InvalidConfiguration)?;
    let mut url = Url::parse(service_url).map_err(|_| ActorPoolError::InvalidConfiguration)?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => return Err(ActorPoolError::InvalidConfiguration),
    };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ActorPoolError::InvalidConfiguration);
    }
    let base_path = url.path().trim_end_matches('/').to_owned();
    url.set_scheme(scheme)
        .map_err(|_| ActorPoolError::InvalidConfiguration)?;
    url.set_path(&format!("{base_path}/xrpc/{SUBSCRIBE_RECORDS_LXM}"));
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("did", did);
        if let Some(cursor) = cursor {
            query.append_pair("cursor", &cursor.to_string());
        }
    }
    Ok(url)
}

fn reconnect_delay(attempt: u32) -> Duration {
    BASE_RECONNECT_DELAY
        .saturating_mul(2_u32.saturating_pow(attempt.saturating_sub(1)))
        .min(MAX_RECONNECT_DELAY)
}

fn retention_deadline(now: OffsetDateTime, retention: Duration) -> Result<String, ActorPoolError> {
    let seconds =
        i64::try_from(retention.as_secs()).map_err(|_| ActorPoolError::InvalidConfiguration)?;
    let deadline = now
        .checked_add(time::Duration::seconds(seconds))
        .ok_or(ActorPoolError::InvalidConfiguration)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        deadline.year(),
        u8::from(deadline.month()),
        deadline.day(),
        deadline.hour(),
        deadline.minute(),
        deadline.second(),
        deadline.millisecond(),
    ))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::{Arc, Mutex},
        time::Duration,
    };

    use time::OffsetDateTime;

    use crate::{
        lifecycle::ControlLifecycle,
        readiness::FeedReadinessGate,
        service::ProjectionReader,
        store::{ActorEnrollment, EncryptedStore, StorageKey},
    };

    use super::{
        ActiveWorker, ActorPool, ActorPoolError, ActorStreamConfig, actor_subscription_url,
        next_waiting_actor, reconnect_delay, retention_deadline, run_actor_worker,
    };

    #[test]
    fn completed_workers_yield_to_actors_that_have_not_synced() {
        let desired = BTreeSet::from([
            "did:plc:a".to_owned(),
            "did:plc:b".to_owned(),
            "did:plc:c".to_owned(),
        ]);
        let mut started = BTreeMap::new();
        let active = BTreeMap::new();
        assert_eq!(
            next_waiting_actor(&desired, &active, &started).as_deref(),
            Some("did:plc:a")
        );
        started.insert("did:plc:a".to_owned(), 1);
        assert_eq!(
            next_waiting_actor(&desired, &active, &started).as_deref(),
            Some("did:plc:b")
        );
        started.insert("did:plc:b".to_owned(), 2);
        let (shutdown, _) = tokio::sync::watch::channel(false);
        let active = BTreeMap::from([("did:plc:c".to_owned(), ActiveWorker { id: 3, shutdown })]);
        assert_eq!(
            next_waiting_actor(&desired, &active, &started).as_deref(),
            Some("did:plc:a")
        );
    }

    #[test]
    fn actor_urls_preserve_the_service_base_path_and_durable_cursor() {
        assert_eq!(
            actor_subscription_url("https://stratos.example.test/base", "did:plc:faye", Some(7))
                .unwrap()
                .as_str(),
            "wss://stratos.example.test/base/xrpc/zone.stratos.sync.subscribeRecords?did=did%3Aplc%3Afaye&cursor=7"
        );
        assert!(matches!(
            actor_subscription_url("https://user@stratos.example.test", "did:plc:faye", None),
            Err(ActorPoolError::InvalidConfiguration)
        ));
    }

    #[test]
    fn retention_and_reconnect_limits_remain_bounded() {
        assert!(reconnect_delay(1) < reconnect_delay(2));
        assert_eq!(reconnect_delay(100), Duration::from_secs(60));
        assert_eq!(
            retention_deadline(
                OffsetDateTime::from_unix_timestamp(0).unwrap(),
                Duration::from_secs(60),
            )
            .unwrap(),
            "1970-01-01T00:01:00.000Z"
        );
    }

    #[test]
    fn rejects_actor_connection_limits_outside_the_resource_budget() {
        let config = ActorStreamConfig {
            service_url: "https://stratos.example.test".to_owned(),
            service_did: "did:web:stratos.example.test".to_owned(),
            feedgen_did: "did:web:feedgen.example.test".to_owned(),
            signing_key: crate::service_auth::ServiceSigningKey::from_hex(&"11".repeat(32))
                .unwrap(),
            retention: Duration::from_secs(60),
            max_connections: crate::config::MAX_ACTOR_CONNECTIONS.saturating_add(1),
        };
        let lifecycle = Arc::new(
            ControlLifecycle::for_authority(
                ProjectionReader::new(
                    EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
                ),
                Arc::new(Mutex::new(FeedReadinessGate::default())),
                "did:web:stratos.example.test",
            )
            .unwrap(),
        );
        assert!(matches!(
            ActorPool::start(config, lifecycle),
            Err(ActorPoolError::InvalidConfiguration)
        ));
    }

    #[tokio::test]
    async fn pool_queues_enrolled_actors_beyond_its_fixed_connection_budget() {
        let lifecycle = Arc::new(
            ControlLifecycle::for_authority(
                ProjectionReader::new(
                    EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
                ),
                Arc::new(Mutex::new(FeedReadinessGate::default())),
                "did:web:stratos.example.test",
            )
            .unwrap(),
        );
        for did in ["did:plc:faye", "did:plc:spike"] {
            lifecycle
                .reconcile_actor_enrollment(
                    did,
                    "1998-04-03T00:00:00.000Z",
                    Some(ActorEnrollment {
                        did: did.to_owned(),
                        boundaries: vec!["did:web:stratos.example.test/bebop".to_owned()],
                        observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                    }),
                )
                .unwrap();
        }
        let pool = ActorPool::start(
            ActorStreamConfig {
                service_url: "http://127.0.0.1:9".to_owned(),
                service_did: "did:web:stratos.example.test".to_owned(),
                feedgen_did: "did:web:feedgen.example.test".to_owned(),
                signing_key: crate::service_auth::ServiceSigningKey::from_hex(&"11".repeat(32))
                    .unwrap(),
                retention: Duration::from_secs(60),
                max_connections: 1,
            },
            lifecycle,
        )
        .unwrap();
        let mut failures = pool.failure_receiver();
        assert_eq!(
            pool.sync_from_store().await.unwrap(),
            super::ActorPoolStats {
                active: 1,
                waiting: 1,
                max_connections: 1,
            }
        );
        tokio::time::timeout(Duration::from_secs(1), failures.changed())
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_millis(100), pool.stop())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn failed_worker_releases_its_slot_after_the_retry_window() {
        let lifecycle = Arc::new(
            ControlLifecycle::for_authority(
                ProjectionReader::new(
                    EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
                ),
                Arc::new(Mutex::new(FeedReadinessGate::default())),
                "did:web:stratos.example.test",
            )
            .unwrap(),
        );
        lifecycle
            .reconcile_actor_enrollment(
                "did:plc:faye",
                "1998-04-03T00:00:00.000Z",
                Some(ActorEnrollment {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["did:web:stratos.example.test/bebop".to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        let config = ActorStreamConfig {
            service_url: "http://127.0.0.1:9".to_owned(),
            service_did: "did:web:stratos.example.test".to_owned(),
            feedgen_did: "did:web:feedgen.example.test".to_owned(),
            signing_key: crate::service_auth::ServiceSigningKey::from_hex(&"11".repeat(32))
                .unwrap(),
            retention: Duration::from_secs(60),
            max_connections: 1,
        };
        let (failures, _) = tokio::sync::watch::channel(0_u64);
        let (_shutdown, receiver) = tokio::sync::watch::channel(false);
        tokio::time::timeout(
            super::MAX_FAILED_WORKER_LEASE + Duration::from_secs(2),
            run_actor_worker(
                config,
                lifecycle,
                failures.clone(),
                "did:plc:faye".to_owned(),
                receiver,
            ),
        )
        .await
        .unwrap();
        assert!(*failures.borrow() > 0);
    }
}
