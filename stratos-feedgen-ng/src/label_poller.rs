use std::{sync::Arc, time::Duration};

use time::OffsetDateTime;
use tokio::{sync::watch, task::JoinHandle};

use crate::{
    actor_stream::ActorPool,
    authority::{AuthorityClient, AuthorityError, LabelLogClient},
    lifecycle::ControlLifecycle,
    moderation_label::LabelSubject,
    store::ActorEnrollment,
    telemetry::{FeedTelemetry, LabelPollOutcome},
};

/// Bounds how long a takedown can stay unenforced after the authority records it.
pub const LABEL_POLL_INTERVAL: Duration = Duration::from_secs(10);
const MAX_LABEL_PAGES_PER_CYCLE: usize = 50;
const REINSTATING_ACCOUNTS_PER_CYCLE: u16 = 64;
// An operator hold keeps a negated member out and the authority emits no event
// when it lifts, so re-checking has to stop at some point.
const MAX_REINSTATEMENT_ATTEMPTS: u32 = 6;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LabelCycle {
    CaughtUp,
    PageCapReached,
    Failed(LabelPollOutcome),
}

/// What a label poller needs to stop and restart the workers of whole accounts.
#[derive(Clone)]
pub struct AccountEnforcement {
    pub actors: Arc<ActorPool>,
    pub authority: Arc<dyn AuthorityClient>,
}

/// Follows the authority label log independently of the service session.
pub struct LabelPoller {
    shutdown: watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl LabelPoller {
    pub fn start(
        client: Arc<dyn LabelLogClient>,
        accounts: AccountEnforcement,
        lifecycle: Arc<ControlLifecycle>,
        telemetry: Arc<FeedTelemetry>,
    ) -> Self {
        Self::start_with_interval(client, accounts, lifecycle, telemetry, LABEL_POLL_INTERVAL)
    }

    pub fn start_with_interval(
        client: Arc<dyn LabelLogClient>,
        accounts: AccountEnforcement,
        lifecycle: Arc<ControlLifecycle>,
        telemetry: Arc<FeedTelemetry>,
        interval: Duration,
    ) -> Self {
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(run_forever(
            client, accounts, lifecycle, telemetry, interval, receiver,
        ));
        Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
        }
    }

    pub async fn stop(&self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}

async fn run_forever(
    client: Arc<dyn LabelLogClient>,
    accounts: AccountEnforcement,
    lifecycle: Arc<ControlLifecycle>,
    telemetry: Arc<FeedTelemetry>,
    interval: Duration,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = run_cycle(&lifecycle, client.as_ref(), &accounts, &telemetry) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

async fn run_cycle(
    lifecycle: &ControlLifecycle,
    client: &dyn LabelLogClient,
    accounts: &AccountEnforcement,
    telemetry: &FeedTelemetry,
) -> LabelCycle {
    // Before the pages, so a negation is acted on one cycle after it is seen.
    reinstate_accounts(lifecycle, accounts).await;
    let result = poll_to_caught_up(lifecycle, client, accounts, telemetry).await;
    if let LabelCycle::Failed(outcome) = result {
        telemetry.record_label_poll(outcome);
        eprintln!("{}", failure_line(outcome));
    }
    result
}

async fn poll_to_caught_up(
    lifecycle: &ControlLifecycle,
    client: &dyn LabelLogClient,
    accounts: &AccountEnforcement,
    telemetry: &FeedTelemetry,
) -> LabelCycle {
    let mut cursor = match lifecycle.label_cursor() {
        Ok(cursor) => cursor,
        Err(_) => return LabelCycle::Failed(LabelPollOutcome::Store),
    };
    for _ in 0..MAX_LABEL_PAGES_PER_CYCLE {
        let now = OffsetDateTime::now_utc();
        let page = match client
            .query_labels(cursor, now.unix_timestamp().max(0) as u64)
            .await
        {
            Ok(page) => page,
            Err(error) => return LabelCycle::Failed(outcome_for(&error)),
        };
        // The lexicon permits short or empty pages while more remain, so only a
        // response that does not advance the cursor proves the log is drained.
        if page.cursor == cursor {
            lifecycle.mark_labels_current();
            telemetry.record_label_poll(LabelPollOutcome::CaughtUp);
            return LabelCycle::CaughtUp;
        }
        let effects = match lifecycle.apply_label_page(&page, &format_utc_millis(now)) {
            Ok(effects) => effects,
            Err(_) => return LabelCycle::Failed(LabelPollOutcome::Store),
        };
        for subject in &effects.taken_down {
            if let LabelSubject::Account { did } = subject
                && accounts.actors.sync_actor(did).await.is_err()
            {
                eprintln!("{}", enforcement_failure_line("worker_stop"));
            }
        }
        cursor = page.cursor;
        telemetry.record_label_poll(LabelPollOutcome::Ok);
    }
    LabelCycle::PageCapReached
}

async fn reinstate_accounts(lifecycle: &ControlLifecycle, accounts: &AccountEnforcement) {
    let pending = match lifecycle.reinstating_accounts(REINSTATING_ACCOUNTS_PER_CYCLE) {
        Ok(pending) => pending,
        Err(_) => {
            eprintln!("{}", enforcement_failure_line("store"));
            return;
        }
    };
    for (did, attempts) in pending {
        let now = OffsetDateTime::now_utc();
        let resolution = match accounts
            .authority
            .resolve_enrollment(&did, now.unix_timestamp().max(0) as u64)
            .await
        {
            Ok(resolution) => resolution,
            // An unreachable authority says nothing about the hold, so it costs no attempt.
            Err(_) => {
                eprintln!("{}", enforcement_failure_line("authority"));
                continue;
            }
        };
        let outcome = if resolution.enrolled {
            let observed_at = format_utc_millis(now);
            readmit_account(
                lifecycle,
                accounts,
                &did,
                &observed_at,
                resolution.boundaries,
            )
            .await
        } else {
            keep_account_out(lifecycle, &did, attempts)
        };
        if let Err(kind) = outcome {
            eprintln!("{}", enforcement_failure_line(kind));
        }
    }
}

async fn readmit_account(
    lifecycle: &ControlLifecycle,
    accounts: &AccountEnforcement,
    did: &str,
    observed_at: &str,
    boundaries: Vec<String>,
) -> Result<(), &'static str> {
    let enrollment = ActorEnrollment {
        did: did.to_owned(),
        boundaries,
        observed_at: observed_at.to_owned(),
    };
    lifecycle
        .reconcile_actor_enrollment(did, observed_at, Some(enrollment))
        .map_err(|_| "enrollment")?;
    lifecycle.finish_reinstatement(did).map_err(|_| "store")?;
    accounts
        .actors
        .sync_actor(did)
        .await
        .map_err(|_| "worker_start")?;
    Ok(())
}

fn keep_account_out(
    lifecycle: &ControlLifecycle,
    did: &str,
    attempts: u32,
) -> Result<(), &'static str> {
    lifecycle
        .record_reinstatement_attempt(did)
        .map_err(|_| "store")?;
    if attempts.saturating_add(1) >= MAX_REINSTATEMENT_ATTEMPTS {
        lifecycle.finish_reinstatement(did).map_err(|_| "store")?;
    }
    Ok(())
}

fn enforcement_failure_line(kind: &'static str) -> String {
    format!("event=account_label_enforcement_failed kind={kind}")
}

fn failure_line(outcome: LabelPollOutcome) -> String {
    format!("event=label_poll_failed kind={}", outcome.label())
}

fn outcome_for(error: &AuthorityError) -> LabelPollOutcome {
    match error {
        AuthorityError::Authentication => LabelPollOutcome::Authentication,
        AuthorityError::Unavailable => LabelPollOutcome::Unavailable,
        AuthorityError::InvalidConfiguration
        | AuthorityError::InvalidRequest
        | AuthorityError::ResponseTooLarge
        | AuthorityError::InvalidResponse => LabelPollOutcome::Rejected,
    }
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
    use std::{
        collections::BTreeMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{AccountEnforcement, LabelCycle, LabelPoller, failure_line, run_cycle};
    use crate::{
        actor_stream::{ActorPool, ActorStreamConfig},
        authority::HttpAuthorityClient,
        feed_service::{FeedQuery, FeedServiceError},
        feeds::{FeedDescription, FeedRegistry},
        lifecycle::ControlLifecycle,
        readiness::{FeedReadinessGate, ReconciliationOutcome},
        service::ProjectionReader,
        service_auth::ServiceSigningKey,
        service_event::{EnrollmentAction, EnrollmentEvent},
        store::{ActorEnrollment, ActorPage, EncryptedStore, ProjectionPost, StorageKey},
        telemetry::{FeedTelemetry, LabelPollOutcome},
    };

    const AUTHORITY_DID: &str = "did:web:stratos.example.test";
    const SPIKE_POST: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1";
    const FAYE_POST: &str = "at://did:plc:faye/zone.stratos.feed.post/redtail";

    struct Responder {
        address: std::net::SocketAddr,
        routes: Arc<Mutex<BTreeMap<u64, Vec<u8>>>>,
        requests: Arc<Mutex<Vec<u64>>>,
        resolution: Arc<Mutex<Vec<u8>>>,
        resolve_calls: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Responder {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Responder {
        fn set_routes(&self, routes: impl IntoIterator<Item = (u64, Vec<u8>)>) {
            *self.routes.lock().unwrap() = routes.into_iter().collect();
        }

        fn requested_cursors(&self) -> Vec<u64> {
            self.requests.lock().unwrap().clone()
        }

        fn set_enrolled(&self, did: &str, enrolled: bool) {
            let boundaries = if enrolled { r#"["bebop"]"# } else { "[]" };
            *self.resolution.lock().unwrap() = http_response(
                "200 OK",
                format!(r#"{{"did":"{did}","enrolled":{enrolled},"boundaries":{boundaries}}}"#)
                    .as_bytes(),
            );
        }

        fn resolve_call_count(&self) -> usize {
            self.resolve_calls.load(Ordering::SeqCst)
        }
    }

    async fn respond_by_cursor(routes: impl IntoIterator<Item = (u64, Vec<u8>)>) -> Responder {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let routes = Arc::new(Mutex::new(routes.into_iter().collect::<BTreeMap<_, _>>()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let resolution = Arc::new(Mutex::new(http_response("404 Not Found", b"{}")));
        let resolve_calls = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let routes = Arc::clone(&routes);
            let requests = Arc::clone(&requests);
            let resolution = Arc::clone(&resolution);
            let resolve_calls = Arc::clone(&resolve_calls);
            async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else {
                        return;
                    };
                    let mut head = Vec::new();
                    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                        let mut chunk = [0; 4096];
                        let Ok(read) = stream.read(&mut chunk).await else {
                            break;
                        };
                        if read == 0 {
                            break;
                        }
                        head.extend_from_slice(&chunk[..read]);
                    }
                    let head = String::from_utf8_lossy(&head).into_owned();
                    let request_line = head.lines().next().unwrap_or_default();
                    if request_line.contains("resolveEnrollments") {
                        resolve_calls.fetch_add(1, Ordering::SeqCst);
                        let response = resolution.lock().unwrap().clone();
                        let _ = stream.write_all(&response).await;
                        let _ = stream.shutdown().await;
                        continue;
                    }
                    let cursor = request_line
                        .split(['?', '&', ' '])
                        .find_map(|part| part.strip_prefix("cursor="))
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                    requests.lock().unwrap().push(cursor);
                    let response = routes
                        .lock()
                        .unwrap()
                        .get(&cursor)
                        .cloned()
                        .unwrap_or_else(|| http_response("404 Not Found", b"{}"));
                    let _ = stream.write_all(&response).await;
                    let _ = stream.shutdown().await;
                }
            }
        });
        Responder {
            address,
            routes,
            requests,
            resolution,
            resolve_calls,
            task,
        }
    }

    fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn label_page(cursor: u64, labels: &[(u64, &str)]) -> Vec<u8> {
        let labels = labels
            .iter()
            .map(|(seq, uri)| {
                format!(
                    r##"{{"seq":{seq},"subject":{{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"{uri}"}},"val":"!takedown","createdAt":"1998-04-03T00:00:00Z"}}"##
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        http_response(
            "200 OK",
            format!(r#"{{"cursor":"{cursor}","labels":[{labels}]}}"#).as_bytes(),
        )
    }

    fn client(responder: &Responder) -> Arc<HttpAuthorityClient> {
        Arc::new(
            HttpAuthorityClient::new(
                &format!("http://{}", responder.address),
                AUTHORITY_DID,
                "did:web:feedgen.example.test",
                ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap(),
            )
            .unwrap(),
        )
    }

    fn lifecycle_with(
        telemetry: Arc<FeedTelemetry>,
    ) -> (Arc<ControlLifecycle>, Arc<Mutex<FeedReadinessGate>>) {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::for_authority_with_telemetry(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::clone(&readiness),
            AUTHORITY_DID,
            telemetry,
        )
        .unwrap();
        (Arc::new(lifecycle), readiness)
    }

    fn reconcile_session(lifecycle: &ControlLifecycle) {
        lifecycle
            .apply_viewer_authorization(
                crate::authorization::ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    expires_at: u64::MAX,
                },
                1,
            )
            .unwrap();
        lifecycle.session_established();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
    }

    fn serve_feed(lifecycle: &ControlLifecycle) -> Result<(), FeedServiceError> {
        let feeds = FeedRegistry::new([FeedDescription {
            id: "bebop".to_owned(),
            boundary: "bebop".to_owned(),
            display_name: None,
            description: None,
        }])
        .unwrap();
        lifecycle
            .serve_viewer_feed(
                "did:plc:faye",
                &feeds,
                FeedQuery {
                    feed_id: "bebop",
                    cursor: None,
                    limit: 50,
                    now: 2,
                    as_of: "1998-04-03T00:00:00.000Z",
                    blob_base_url: "https://feedgen.example.test",
                },
            )
            .map(|_| ())
    }

    fn two_pages_then_no_progress() -> Vec<(u64, Vec<u8>)> {
        vec![
            (0, label_page(2, &[(1, SPIKE_POST), (2, FAYE_POST)])),
            // An empty page that still advances proves more may remain.
            (2, label_page(4, &[])),
            (4, label_page(4, &[])),
        ]
    }

    #[tokio::test]
    async fn catches_up_across_pages_and_opens_the_gate() {
        let responder = respond_by_cursor(two_pages_then_no_progress()).await;
        let (lifecycle, readiness) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));
        reconcile_session(&lifecycle);
        assert!(matches!(
            serve_feed(&lifecycle),
            Err(FeedServiceError::FeedNotReady)
        ));

        let cycle = run_cycle(
            &lifecycle,
            client(&responder).as_ref(),
            &enforcement(&responder, &lifecycle),
            &FeedTelemetry::disabled(),
        )
        .await;

        assert_eq!(cycle, LabelCycle::CaughtUp);
        assert_eq!(lifecycle.label_cursor().unwrap(), 4);
        assert_eq!(responder.requested_cursors(), [0, 2, 4]);
        assert!(readiness.lock().unwrap().is_ready());
        assert!(serve_feed(&lifecycle).is_ok());
    }

    #[tokio::test]
    async fn a_rejected_page_leaves_the_cursor_and_the_gate_alone() {
        // A label sequence beyond the page cursor is structurally invalid.
        let malformed = http_response(
            "200 OK",
            format!(
                r##"{{"cursor":"2","labels":[{{"seq":9,"subject":{{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"{SPIKE_POST}"}},"val":"!takedown","createdAt":"1998-04-03T00:00:00Z"}}]}}"##
            )
            .as_bytes(),
        );
        let responder =
            respond_by_cursor([(0, label_page(1, &[(1, SPIKE_POST)])), (1, malformed)]).await;
        let (lifecycle, readiness) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));
        reconcile_session(&lifecycle);

        let cycle = run_cycle(
            &lifecycle,
            client(&responder).as_ref(),
            &enforcement(&responder, &lifecycle),
            &FeedTelemetry::disabled(),
        )
        .await;

        assert_eq!(cycle, LabelCycle::Failed(LabelPollOutcome::Rejected));
        assert_eq!(lifecycle.label_cursor().unwrap(), 1);
        assert_eq!(responder.requested_cursors(), [0, 1]);
        assert!(!readiness.lock().unwrap().is_ready());
    }

    #[tokio::test]
    async fn an_unavailable_authority_keeps_the_cursor_and_the_next_cycle_catches_up() {
        let responder =
            respond_by_cursor([(0, http_response("500 Internal Server Error", b"{}"))]).await;
        let (lifecycle, readiness) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));
        reconcile_session(&lifecycle);
        let label_client = client(&responder);
        let accounts = enforcement(&responder, &lifecycle);

        let failed = run_cycle(
            &lifecycle,
            label_client.as_ref(),
            &accounts,
            &FeedTelemetry::disabled(),
        )
        .await;

        assert_eq!(failed, LabelCycle::Failed(LabelPollOutcome::Unavailable));
        assert_eq!(lifecycle.label_cursor().unwrap(), 0);
        assert!(!readiness.lock().unwrap().is_ready());

        responder.set_routes(two_pages_then_no_progress());
        let recovered = run_cycle(
            &lifecycle,
            label_client.as_ref(),
            &accounts,
            &FeedTelemetry::disabled(),
        )
        .await;

        assert_eq!(recovered, LabelCycle::CaughtUp);
        assert_eq!(lifecycle.label_cursor().unwrap(), 4);
        assert!(readiness.lock().unwrap().is_ready());
    }

    #[tokio::test]
    async fn a_page_cap_stops_the_cycle_without_claiming_currency() {
        let routes = (0..=super::MAX_LABEL_PAGES_PER_CYCLE as u64)
            .map(|cursor| (cursor, label_page(cursor + 1, &[])))
            .collect::<Vec<_>>();
        let responder = respond_by_cursor(routes).await;
        let (lifecycle, readiness) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));
        reconcile_session(&lifecycle);

        let cycle = run_cycle(
            &lifecycle,
            client(&responder).as_ref(),
            &enforcement(&responder, &lifecycle),
            &FeedTelemetry::disabled(),
        )
        .await;

        assert_eq!(cycle, LabelCycle::PageCapReached);
        assert_eq!(
            lifecycle.label_cursor().unwrap(),
            super::MAX_LABEL_PAGES_PER_CYCLE as u64
        );
        assert!(!readiness.lock().unwrap().is_ready());
    }

    #[tokio::test]
    async fn the_running_poller_recovers_after_a_failed_cycle_and_stops_cleanly() {
        let responder =
            respond_by_cursor([(0, http_response("500 Internal Server Error", b"{}"))]).await;
        let (lifecycle, readiness) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));
        reconcile_session(&lifecycle);
        // A short injected interval keeps the test off the production 10 s cadence.
        let poller = LabelPoller::start_with_interval(
            client(&responder),
            enforcement(&responder, &lifecycle),
            Arc::clone(&lifecycle),
            Arc::new(FeedTelemetry::disabled()),
            Duration::from_millis(20),
        );
        wait_for_requests(&responder, 1).await;
        assert!(!readiness.lock().unwrap().is_ready());

        responder.set_routes(two_pages_then_no_progress());
        for _ in 0..200 {
            if readiness.lock().unwrap().is_ready() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(readiness.lock().unwrap().is_ready());

        tokio::time::timeout(Duration::from_secs(2), poller.stop())
            .await
            .expect("stop joins the poller task");
        let settled = responder.requested_cursors().len();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(responder.requested_cursors().len(), settled);
    }

    async fn wait_for_requests(responder: &Responder, count: usize) {
        for _ in 0..200 {
            if responder.requested_cursors().len() >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("responder saw fewer than {count} requests");
    }

    #[tokio::test]
    async fn logs_and_metrics_carry_only_static_outcomes() {
        let exporter = InMemoryMetricExporter::default();
        let provider = SdkMeterProvider::builder()
            .with_reader(PeriodicReader::builder(exporter.clone()).build())
            .build();
        let telemetry = Arc::new(FeedTelemetry::enabled(&provider));
        let responder = respond_by_cursor(two_pages_then_no_progress()).await;
        let (lifecycle, _readiness) = lifecycle_with(Arc::clone(&telemetry));
        let label_client = client(&responder);
        let accounts = enforcement(&responder, &lifecycle);
        assert_eq!(
            run_cycle(&lifecycle, label_client.as_ref(), &accounts, &telemetry).await,
            LabelCycle::CaughtUp
        );
        responder.set_routes([(4, http_response("500 Internal Server Error", b"{}"))]);
        assert_eq!(
            run_cycle(&lifecycle, label_client.as_ref(), &accounts, &telemetry).await,
            LabelCycle::Failed(LabelPollOutcome::Unavailable)
        );

        provider.force_flush().unwrap();
        let metrics = format!("{:?}", exporter.get_finished_metrics().unwrap());
        assert!(metrics.contains("stratos.feedgen.label_poll"));
        for outcome in ["ok", "caught_up", "unavailable"] {
            assert!(metrics.contains(outcome), "missing outcome {outcome}");
        }
        for outcome in [
            LabelPollOutcome::Ok,
            LabelPollOutcome::CaughtUp,
            LabelPollOutcome::Unavailable,
            LabelPollOutcome::Authentication,
            LabelPollOutcome::Rejected,
            LabelPollOutcome::Store,
        ] {
            let line = failure_line(outcome);
            assert_eq!(
                line,
                format!("event=label_poll_failed kind={}", outcome.label())
            );
            assert!(!line.contains("did:") && !line.contains("at://"));
        }
        for forbidden in [
            "did:plc",
            "spikespiegel",
            "faye",
            "at://",
            "bebop1",
            "redtail",
        ] {
            assert!(!metrics.contains(forbidden), "metrics leaked {forbidden}");
        }
    }

    const SPIKE: &str = "did:plc:spikespiegel";
    const AFTER_TAKEDOWN: &str = "2100-01-01T00:00:00.000Z";
    const BEFORE_RETENTION_ENDS: &str = "1998-04-03T12:00:00.000Z";

    fn account_page(cursor: u64, labels: &[(u64, &str, bool)]) -> Vec<u8> {
        let labels = labels
            .iter()
            .map(|(seq, did, neg)| {
                format!(
                    r##"{{"seq":{seq},"subject":{{"$type":"zone.stratos.moderation.defs#accountSubject","did":"{did}"}},"val":"!takedown","neg":{neg},"createdAt":"1998-04-03T00:00:00Z"}}"##
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        http_response(
            "200 OK",
            format!(r#"{{"cursor":"{cursor}","labels":[{labels}]}}"#).as_bytes(),
        )
    }

    fn enforcement(responder: &Responder, lifecycle: &Arc<ControlLifecycle>) -> AccountEnforcement {
        let actors = ActorPool::start(
            ActorStreamConfig {
                service_url: "http://127.0.0.1:9".to_owned(),
                service_did: AUTHORITY_DID.to_owned(),
                feedgen_did: "did:web:feedgen.example.test".to_owned(),
                signing_key: ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap(),
                retention: Duration::from_secs(60),
                max_connections: 1,
            },
            Arc::clone(lifecycle),
        )
        .unwrap();
        AccountEnforcement {
            actors,
            authority: client(responder),
        }
    }

    fn spike_post(name: &str) -> ProjectionPost {
        ProjectionPost {
            uri: format!("at://{SPIKE}/zone.stratos.feed.post/{name}"),
            author_did: SPIKE.to_owned(),
            cid: "bafyreia".to_owned(),
            sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
            indexed_at: "1998-04-03T00:00:00.000Z".to_owned(),
            retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
            record_json: b"{}".to_vec(),
            blob_refs_json: b"[]".to_vec(),
            boundaries: vec!["bebop".to_owned()],
        }
    }

    fn store_with_spike_posts(mut store: EncryptedStore) -> EncryptedStore {
        store
            .reconcile_actor_enrollment(
                SPIKE,
                "1998-04-03T00:00:00.000Z",
                Some(ActorEnrollment {
                    did: SPIKE.to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        store
            .apply_actor_page(ActorPage {
                authority_did: AUTHORITY_DID.to_owned(),
                actor_did: SPIKE.to_owned(),
                sequence: 3,
                upserts: vec![spike_post("bebop1"), spike_post("bebop2")],
                deletes: Vec::new(),
                updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
            })
            .unwrap();
        store
    }

    fn memory_store_with_spike_posts() -> EncryptedStore {
        store_with_spike_posts(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        )
    }

    struct Scene {
        responder: Responder,
        lifecycle: Arc<ControlLifecycle>,
        label_client: Arc<HttpAuthorityClient>,
        accounts: AccountEnforcement,
    }

    impl Scene {
        async fn with_store(store: EncryptedStore) -> Self {
            let responder = respond_by_cursor([]).await;
            let lifecycle = Arc::new(
                ControlLifecycle::for_authority_with_telemetry(
                    ProjectionReader::new(store),
                    Arc::new(Mutex::new(FeedReadinessGate::default())),
                    AUTHORITY_DID,
                    Arc::new(FeedTelemetry::disabled()),
                )
                .unwrap(),
            );
            reconcile_session(&lifecycle);
            lifecycle.mark_labels_current();
            let accounts = enforcement(&responder, &lifecycle);
            accounts.actors.sync_from_store().await.unwrap();
            Self {
                label_client: client(&responder),
                responder,
                lifecycle,
                accounts,
            }
        }

        async fn enrolled_with_two_posts() -> Self {
            Self::with_store(memory_store_with_spike_posts()).await
        }

        async fn cycle(&self) -> LabelCycle {
            run_cycle(
                &self.lifecycle,
                self.label_client.as_ref(),
                &self.accounts,
                &FeedTelemetry::disabled(),
            )
            .await
        }

        async fn takedown(&self) {
            self.responder.set_routes([
                (0, account_page(1, &[(1, SPIKE, false)])),
                (1, account_page(1, &[])),
            ]);
            assert_eq!(self.cycle().await, LabelCycle::CaughtUp);
        }

        fn announce_negation(&self) {
            self.responder.set_routes([
                (1, account_page(2, &[(2, SPIKE, true)])),
                (2, account_page(2, &[])),
            ]);
        }

        fn is_enrolled(&self) -> bool {
            self.lifecycle
                .actor_sync_state(AUTHORITY_DID, SPIKE)
                .unwrap()
                .is_some()
        }

        fn feeds() -> FeedRegistry {
            FeedRegistry::new([FeedDescription {
                id: "bebop".to_owned(),
                boundary: "bebop".to_owned(),
                display_name: None,
                description: None,
            }])
            .unwrap()
        }

        fn visible_posts(&self) -> usize {
            self.lifecycle
                .serve_viewer_feed(
                    "did:plc:faye",
                    &Self::feeds(),
                    FeedQuery {
                        feed_id: "bebop",
                        cursor: None,
                        limit: 50,
                        now: 2,
                        as_of: BEFORE_RETENTION_ENDS,
                        blob_base_url: "https://feedgen.example.test",
                    },
                )
                .unwrap()
                .1
        }

        fn blob_route_finds_the_post(&self) -> bool {
            self.lifecycle
                .prepare_viewer_blob(
                    "did:plc:faye",
                    &Self::feeds(),
                    &spike_post("bebop1").uri,
                    2,
                    BEFORE_RETENTION_ENDS,
                )
                .unwrap()
                .is_some()
        }

        async fn pool_runs_the_actor(&self, running: bool) -> bool {
            for _ in 0..200 {
                let stats = self.accounts.actors.stats().await.unwrap();
                if (stats.active + stats.waiting == 1) == running {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            false
        }

        fn replayed_enroll(&self, observed_at: &str) -> Result<bool, crate::store::StoreError> {
            self.lifecycle
                .apply_enrollment_event(EnrollmentEvent {
                    did: SPIKE.to_owned(),
                    action: EnrollmentAction::Enroll,
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: observed_at.to_owned(),
                })
                .map(|reconciliation| reconciliation.enrolled)
        }
    }

    #[tokio::test]
    async fn an_account_takedown_removes_the_posts_and_stops_the_worker() {
        let scene = Scene::enrolled_with_two_posts().await;
        assert_eq!(scene.visible_posts(), 2);
        assert!(scene.blob_route_finds_the_post());
        assert!(scene.pool_runs_the_actor(true).await);

        scene.takedown().await;

        assert_eq!(scene.visible_posts(), 0);
        assert_eq!(
            scene
                .lifecycle
                .actor_sync_state(AUTHORITY_DID, SPIKE)
                .unwrap(),
            None
        );
        assert!(scene.pool_runs_the_actor(false).await);
    }

    #[tokio::test]
    async fn a_replayed_enroll_does_not_readmit_a_taken_down_account() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;

        assert!(!scene.replayed_enroll(AFTER_TAKEDOWN).unwrap());
        assert!(!scene.replayed_enroll(AFTER_TAKEDOWN).unwrap());

        assert!(!scene.is_enrolled());
        assert_eq!(scene.visible_posts(), 0);
    }

    #[tokio::test]
    async fn reconciliation_does_not_readmit_a_taken_down_account() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;

        let reconciliation = scene
            .lifecycle
            .reconcile_actor_enrollment(
                SPIKE,
                AFTER_TAKEDOWN,
                Some(ActorEnrollment {
                    did: SPIKE.to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: AFTER_TAKEDOWN.to_owned(),
                }),
            )
            .unwrap();

        assert!(!reconciliation.enrolled);
        assert!(!scene.is_enrolled());
        assert_eq!(scene.visible_posts(), 0);
    }

    #[tokio::test]
    async fn a_negated_account_is_readmitted_on_a_later_cycle_and_replays_from_the_start() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;
        scene.responder.set_enrolled(SPIKE, true);
        scene.announce_negation();

        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);
        assert!(!scene.is_enrolled());
        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);

        let state = scene
            .lifecycle
            .actor_sync_state(AUTHORITY_DID, SPIKE)
            .unwrap()
            .expect("the member is enrolled again");
        assert_eq!(state.cursor, None);
        assert_eq!(
            state.boundaries,
            ["did:web:stratos.example.test/bebop".to_owned()]
        );
        assert!(scene.lifecycle.reinstating_accounts(10).unwrap().is_empty());
        assert!(scene.pool_runs_the_actor(true).await);
    }

    #[tokio::test]
    async fn a_negation_is_not_resolved_during_the_cycle_that_sees_it() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;
        scene.responder.set_enrolled(SPIKE, true);
        scene.announce_negation();

        scene.cycle().await;
        assert_eq!(scene.responder.resolve_call_count(), 0);

        scene.cycle().await;
        assert_eq!(scene.responder.resolve_call_count(), 1);
    }

    #[tokio::test]
    async fn a_held_member_is_readmitted_once_the_authority_reports_enrolment() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;
        scene.responder.set_enrolled(SPIKE, false);
        scene.announce_negation();
        scene.cycle().await;

        scene.cycle().await;
        scene.cycle().await;
        assert!(!scene.is_enrolled());
        assert_eq!(
            scene.lifecycle.reinstating_accounts(10).unwrap(),
            [(SPIKE.to_owned(), 2)]
        );

        scene.responder.set_enrolled(SPIKE, true);
        scene.cycle().await;

        assert!(scene.is_enrolled());
        assert!(scene.lifecycle.reinstating_accounts(10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_retries_for_a_held_member_stop_after_the_attempt_cap() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;
        scene.responder.set_enrolled(SPIKE, false);
        scene.announce_negation();
        scene.cycle().await;

        for _ in 1..super::MAX_REINSTATEMENT_ATTEMPTS {
            scene.cycle().await;
        }
        assert_eq!(
            scene.lifecycle.reinstating_accounts(10).unwrap(),
            [(SPIKE.to_owned(), super::MAX_REINSTATEMENT_ATTEMPTS - 1)]
        );

        scene.cycle().await;
        assert!(scene.lifecycle.reinstating_accounts(10).unwrap().is_empty());
        let calls = scene.responder.resolve_call_count();
        scene.cycle().await;
        assert_eq!(scene.responder.resolve_call_count(), calls);
        assert!(!scene.is_enrolled());
    }

    #[tokio::test]
    async fn an_unreachable_authority_costs_no_reinstatement_attempt() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;
        scene.announce_negation();
        scene.cycle().await;
        // The responder has no resolution configured, so every call is an error.
        for _ in 0..super::MAX_REINSTATEMENT_ATTEMPTS + 1 {
            scene.cycle().await;
        }
        assert_eq!(
            scene.lifecycle.reinstating_accounts(10).unwrap(),
            [(SPIKE.to_owned(), 0)]
        );

        scene.responder.set_enrolled(SPIKE, true);
        scene.cycle().await;
        assert!(scene.is_enrolled());
    }

    #[tokio::test]
    async fn the_takedown_outlives_a_restart() {
        let path = std::env::temp_dir().join(format!(
            "stratos-feedgen-ng-poller-restart-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let key = StorageKey::from_bytes([7; 32]);
        let scene = Scene::with_store(store_with_spike_posts(
            EncryptedStore::open(&path, key).unwrap(),
        ))
        .await;
        scene.takedown().await;
        scene.accounts.actors.stop().await;
        drop(scene);

        let reopened = ControlLifecycle::for_authority(
            ProjectionReader::new(
                EncryptedStore::open(&path, StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            AUTHORITY_DID,
        )
        .unwrap();
        let replay = reopened
            .apply_enrollment_event(EnrollmentEvent {
                did: SPIKE.to_owned(),
                action: EnrollmentAction::Enroll,
                boundaries: vec!["bebop".to_owned()],
                observed_at: AFTER_TAKEDOWN.to_owned(),
            })
            .unwrap();

        assert!(!replay.enrolled);
        assert!(
            reopened
                .actor_sync_state(AUTHORITY_DID, SPIKE)
                .unwrap()
                .is_none()
        );
        drop(reopened);
        let _ = std::fs::remove_file(&path);
    }
}
