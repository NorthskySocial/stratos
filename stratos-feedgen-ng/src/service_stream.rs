use std::{
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use time::OffsetDateTime;
use tokio::{sync::watch, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use url::Url;

use crate::{
    actor_stream::ActorPool,
    authority::AuthorityClient,
    lifecycle::ControlLifecycle,
    reconciliation::{ReconciliationOptions, ReconciliationSummary, reconcile_current_session},
    service_auth::{ServiceSigningKey, mint_service_jwt},
    service_event::parse_enrollment_event,
    store::StoreError,
    telemetry::{FeedTelemetry, ReconciliationOutcome},
    websocket_client::authenticated_client_request,
};

const SUBSCRIBE_RECORDS_LXM: &str = "zone.stratos.sync.subscribeRecords";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const BASE_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
const MAX_SERVICE_FRAME_BYTES: usize = 32 * 1024;

#[derive(Clone)]
pub struct ServiceStreamConfig {
    pub service_url: String,
    pub service_did: String,
    pub feedgen_did: String,
    pub signing_key: ServiceSigningKey,
    pub reconciliation: ReconciliationOptions,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ServiceStreamError {
    InvalidConfiguration,
    Authentication,
    Connection,
    InvalidFrame,
    ReconciliationIncomplete,
}

impl fmt::Display for ServiceStreamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Feedgen NG service stream failed")
    }
}

impl std::error::Error for ServiceStreamError {}

pub struct ServiceStream {
    shutdown: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
    lifecycle: Arc<ControlLifecycle>,
    actors: Arc<ActorPool>,
}

impl ServiceStream {
    pub fn start(
        config: ServiceStreamConfig,
        lifecycle: Arc<ControlLifecycle>,
        authority: Arc<dyn AuthorityClient>,
        actors: Arc<ActorPool>,
    ) -> Result<Self, ServiceStreamError> {
        Self::start_with_telemetry(
            config,
            lifecycle,
            authority,
            actors,
            Arc::new(FeedTelemetry::disabled()),
        )
    }

    pub fn start_with_telemetry(
        config: ServiceStreamConfig,
        lifecycle: Arc<ControlLifecycle>,
        authority: Arc<dyn AuthorityClient>,
        actors: Arc<ActorPool>,
        telemetry: Arc<FeedTelemetry>,
    ) -> Result<Self, ServiceStreamError> {
        let subscription_url = subscription_url(&config.service_url)?;
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(run_forever(
            config,
            subscription_url,
            Arc::clone(&lifecycle),
            authority,
            Arc::clone(&actors),
            telemetry,
            receiver,
        ));
        Ok(Self {
            shutdown,
            task: Mutex::new(Some(task)),
            lifecycle,
            actors,
        })
    }

    pub async fn stop(&self) {
        let _ = self.shutdown.send(true);
        let task = self
            .task
            .lock()
            .expect("service stream lock poisoned")
            .take();
        if let Some(task) = task {
            let _ = task.await;
        }
        self.actors.stop().await;
        self.lifecycle.mark_unavailable();
    }
}

async fn run_forever(
    config: ServiceStreamConfig,
    subscription_url: Url,
    lifecycle: Arc<ControlLifecycle>,
    authority: Arc<dyn AuthorityClient>,
    actors: Arc<ActorPool>,
    telemetry: Arc<FeedTelemetry>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut attempt = 0_u32;
    let mut actor_failures = actors.failure_receiver();
    while !*shutdown.borrow() {
        let result = run_connection(
            &config,
            &subscription_url,
            &lifecycle,
            authority.as_ref(),
            actors.as_ref(),
            &mut actor_failures,
            &mut shutdown,
            telemetry.as_ref(),
        )
        .await;
        lifecycle.mark_unavailable();
        if *shutdown.borrow() {
            return;
        }
        match result {
            Ok(()) => attempt = 0,
            Err(error) => {
                eprintln!(
                    "event=service_stream_session_ended kind={}",
                    service_stream_error_kind(&error)
                );
                attempt = attempt.saturating_add(1);
            }
        }
        let delay = reconnect_delay(attempt);
        telemetry.record_reconnect("service");
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)] // Session inputs are distinct bounded runtime adapters.
async fn run_connection(
    config: &ServiceStreamConfig,
    subscription_url: &Url,
    lifecycle: &ControlLifecycle,
    authority: &dyn AuthorityClient,
    actors: &ActorPool,
    actor_failures: &mut watch::Receiver<u64>,
    shutdown: &mut watch::Receiver<bool>,
    telemetry: &FeedTelemetry,
) -> Result<(), ServiceStreamError> {
    let now = OffsetDateTime::now_utc();
    let token = mint_service_jwt(
        &config.signing_key,
        &config.feedgen_did,
        &config.service_did,
        SUBSCRIBE_RECORDS_LXM,
        now.unix_timestamp().max(0) as u64,
    )
    .map_err(|_| ServiceStreamError::Authentication)?;
    let request = authenticated_client_request(subscription_url, &token)
        .map_err(|_| ServiceStreamError::InvalidConfiguration)?;
    let websocket_config = WebSocketConfig::default()
        .read_buffer_size(4 * 1024)
        .write_buffer_size(4 * 1024)
        .max_write_buffer_size(8 * 1024)
        .max_message_size(Some(MAX_SERVICE_FRAME_BYTES))
        .max_frame_size(Some(MAX_SERVICE_FRAME_BYTES));
    let (mut socket, _) = timeout(
        CONNECT_TIMEOUT,
        connect_async_with_config(request, Some(websocket_config), true),
    )
    .await
    .map_err(|_| {
        eprintln!("event=service_stream_connect_failed kind=timeout");
        ServiceStreamError::Connection
    })?
    .map_err(|error| {
        eprintln!("event=service_stream_connect_failed kind=websocket error={error}");
        ServiceStreamError::Connection
    })?;

    lifecycle.session_established();
    let reconciliation_started = std::time::Instant::now();
    let summary = match reconcile_with_shutdown(
        lifecycle,
        authority,
        now.unix_timestamp().max(0) as u64,
        &format_utc_millis(now),
        config.reconciliation,
        shutdown,
    )
    .await
    {
        Ok(summary) => summary,
        Err(_) => {
            telemetry.record_reconciliation(
                ReconciliationOutcome::Failed,
                reconciliation_started.elapsed(),
            );
            return Err(ServiceStreamError::ReconciliationIncomplete);
        }
    };
    let Some(summary) = summary else {
        let _ = socket.close(None).await;
        return Ok(());
    };
    telemetry.record_reconciliation(
        if summary.errors == 0 && !summary.truncated {
            ReconciliationOutcome::Ok
        } else if summary.errors < summary.examined || summary.truncated {
            ReconciliationOutcome::Partial
        } else {
            ReconciliationOutcome::Failed
        },
        reconciliation_started.elapsed(),
    );
    if summary.errors != 0 || summary.truncated {
        return Err(ServiceStreamError::ReconciliationIncomplete);
    }
    actor_failures.borrow_and_update();
    let stats = actors.sync_from_store().await.map_err(|_| {
        eprintln!("event=service_actor_sync_failed kind=store");
        ServiceStreamError::ReconciliationIncomplete
    })?;
    telemetry.set_actor_pool(stats.active, stats.waiting, stats.max_connections);

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = socket.close(None).await;
                    return Ok(());
                }
            }
            _ = actor_failures.changed() => {
                eprintln!("event=service_stream_session_ended kind=actor_failure");
                return Err(ServiceStreamError::ReconciliationIncomplete);
            }
            message = socket.next() => {
                let message = message.ok_or_else(|| {
                    eprintln!("event=service_stream_session_ended kind=connection_closed");
                    ServiceStreamError::Connection
                })?
                    .map_err(|_| {
                        eprintln!("event=service_stream_session_ended kind=connection_error");
                        ServiceStreamError::Connection
                    })?;
                match message {
                    Message::Binary(frame) => {
                        if let Some(event) = parse_enrollment_event(&frame, &config.service_did)
                            .map_err(|_| {
                                eprintln!("event=service_stream_session_ended kind=invalid_enrollment_frame");
                                ServiceStreamError::InvalidFrame
                            })?
                        {
                            match lifecycle.apply_enrollment_event(event.clone()) {
                                Ok(_) => {}
                                Err(StoreError::StaleCursor) => {
                                    eprintln!("event=service_stale_enrollment_event_ignored");
                                    continue;
                                }
                                Err(StoreError::EnrollmentConflict) => {
                                    eprintln!("event=service_enrollment_conflict");
                                    return Err(ServiceStreamError::ReconciliationIncomplete);
                                }
                                Err(_) => {
                                    eprintln!("event=service_stream_session_ended kind=enrollment_store_error");
                                    return Err(ServiceStreamError::InvalidFrame);
                                }
                            }
                            let stats = actors
                                .sync_actor(&event.did)
                                .await
                                .map_err(|_| {
                                    eprintln!("event=service_stream_session_ended kind=actor_pool_error");
                                    ServiceStreamError::InvalidFrame
                                })?;
                            telemetry.set_actor_pool(
                                stats.active,
                                stats.waiting,
                                stats.max_connections,
                            );
                        }
                    }
                    Message::Ping(payload) => {
                        socket.send(Message::Pong(payload)).await.map_err(|_| ServiceStreamError::Connection)?;
                    }
                    Message::Close(_) => return Err(ServiceStreamError::Connection),
                    Message::Pong(_) => {}
                    Message::Text(_) | Message::Frame(_) => return Err(ServiceStreamError::InvalidFrame),
                }
            }
        }
    }
}

fn service_stream_error_kind(error: &ServiceStreamError) -> &'static str {
    match error {
        ServiceStreamError::InvalidConfiguration => "configuration",
        ServiceStreamError::Authentication => "authentication",
        ServiceStreamError::Connection => "connection",
        ServiceStreamError::InvalidFrame => "invalid_frame",
        ServiceStreamError::ReconciliationIncomplete => "reconciliation_incomplete",
    }
}

async fn reconcile_with_shutdown(
    lifecycle: &ControlLifecycle,
    authority: &dyn AuthorityClient,
    now: u64,
    observed_at: &str,
    options: ReconciliationOptions,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Option<ReconciliationSummary>, crate::store::StoreError> {
    loop {
        if *shutdown.borrow() {
            return Ok(None);
        }
        tokio::select! {
            result = reconcile_current_session(lifecycle, authority, now, observed_at, options) => {
                return result.map(Some);
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return Ok(None);
                }
            }
        }
    }
}

fn subscription_url(service_url: &str) -> Result<Url, ServiceStreamError> {
    let mut url = Url::parse(service_url).map_err(|_| ServiceStreamError::InvalidConfiguration)?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => return Err(ServiceStreamError::InvalidConfiguration),
    };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ServiceStreamError::InvalidConfiguration);
    }
    let base_path = url.path().trim_end_matches('/').to_owned();
    url.set_scheme(scheme)
        .map_err(|_| ServiceStreamError::InvalidConfiguration)?;
    url.set_path(&format!("{base_path}/xrpc/{SUBSCRIBE_RECORDS_LXM}"));
    Ok(url)
}

fn reconnect_delay(attempt: u32) -> Duration {
    BASE_RECONNECT_DELAY
        .saturating_mul(2_u32.saturating_pow(attempt.saturating_sub(1)))
        .min(MAX_RECONNECT_DELAY)
}

fn format_utc_millis(value: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use time::OffsetDateTime;
    use tokio::{sync::watch, time::timeout};

    use crate::{
        authority::{AuthorityClient, AuthorityError, EnrollmentResolution},
        lifecycle::ControlLifecycle,
        readiness::FeedReadinessGate,
        reconciliation::ReconciliationOptions,
        service::ProjectionReader,
        store::{ActorEnrollment, EncryptedStore, StorageKey, is_utc_timestamp},
    };

    use super::{
        MAX_RECONNECT_DELAY, format_utc_millis, reconcile_with_shutdown, reconnect_delay,
        subscription_url,
    };

    struct PendingAuthority;

    #[async_trait]
    impl AuthorityClient for PendingAuthority {
        async fn resolve_enrollment(
            &self,
            _: &str,
            _: u64,
        ) -> Result<EnrollmentResolution, AuthorityError> {
            std::future::pending().await
        }
    }

    #[test]
    fn derives_a_scoped_websocket_url_without_relaxing_origin_validation() {
        assert_eq!(
            subscription_url("https://stratos.example.test/base")
                .unwrap()
                .as_str(),
            "wss://stratos.example.test/base/xrpc/zone.stratos.sync.subscribeRecords"
        );
        assert!(subscription_url("https://user@stratos.example.test").is_err());
        assert!(subscription_url("file:///tmp/stratos").is_err());
    }

    #[test]
    fn bounds_reconnect_delay_and_formats_store_compatible_observation_times() {
        assert!(reconnect_delay(1) < reconnect_delay(2));
        assert_eq!(reconnect_delay(100), MAX_RECONNECT_DELAY);
        assert!(is_utc_timestamp(&format_utc_millis(
            OffsetDateTime::now_utc()
        )));
    }

    #[tokio::test]
    async fn shutdown_cancels_a_stalled_reconciliation() {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .reconcile_actor_enrollment(
                "did:plc:faye",
                "1998-04-03T00:00:00.000Z",
                Some(ActorEnrollment {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        let lifecycle = Arc::new(ControlLifecycle::new(
            ProjectionReader::new(store),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
        ));
        let authority = Arc::new(PendingAuthority);
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn({
            let lifecycle = Arc::clone(&lifecycle);
            let authority = Arc::clone(&authority);
            async move {
                let mut receiver = receiver.clone();
                reconcile_with_shutdown(
                    &lifecycle,
                    authority.as_ref(),
                    1,
                    "1998-04-03T00:00:01.000Z",
                    ReconciliationOptions::default(),
                    &mut receiver,
                )
                .await
            }
        });
        tokio::task::yield_now().await;
        shutdown.send(true).unwrap();
        assert!(
            timeout(std::time::Duration::from_millis(100), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .is_none()
        );
    }
}
