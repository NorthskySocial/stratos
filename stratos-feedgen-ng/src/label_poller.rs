use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

use time::OffsetDateTime;
use tokio::{sync::watch, task::JoinHandle};

use crate::{
    actor_stream::ActorPool,
    authority::{AuthorityClient, AuthorityError, LabelLogClient},
    blob_service::BlobService,
    credential_manager::boundary_to_space_uri,
    identifier::RecordUri,
    lifecycle::ControlLifecycle,
    moderation_label::{LabelPage, LabelSubject},
    store::ActorEnrollment,
    telemetry::{FeedTelemetry, LabelPollOutcome},
};

/// Bounds how long a takedown can stay unenforced after the authority records it.
pub const LABEL_POLL_INTERVAL: Duration = Duration::from_secs(10);
// Five missed polls tolerate a brief outage without serving on a log that may
// already hold a takedown.
pub const LABEL_MAX_STALENESS: Duration = LABEL_POLL_INTERVAL.saturating_mul(5);
/// How long one cycle may spend asking the authority about lifted account takedowns.
pub const ACCOUNT_REINSTATEMENT_BUDGET: Duration = LABEL_POLL_INTERVAL;
const MAX_LABEL_PAGES_PER_CYCLE: usize = 50;
const REINSTATING_ACCOUNTS_PER_CYCLE: u16 = 64;
const REINSTATING_RECORDS_PER_CYCLE: u16 = 64;
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
    pub reinstatement_budget: Duration,
}

/// What a label poller needs to drop cached blobs of removed records.
#[derive(Clone)]
pub struct RecordEnforcement {
    pub blobs: Arc<BlobService>,
}

#[derive(Clone, Copy, Debug)]
struct LabelTiming {
    poll_interval: Duration,
    max_staleness: Duration,
}

/// Follows the authority label log independently of the service session.
pub struct LabelPoller {
    shutdown: watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
    // A task of its own, so a stuck or dead poller cannot keep reads open.
    staleness_guard: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

impl LabelPoller {
    pub fn start(
        client: Arc<dyn LabelLogClient>,
        accounts: AccountEnforcement,
        records: RecordEnforcement,
        lifecycle: Arc<ControlLifecycle>,
        telemetry: Arc<FeedTelemetry>,
    ) -> Self {
        Self::start_with_timing(
            client,
            accounts,
            records,
            lifecycle,
            telemetry,
            LabelTiming {
                poll_interval: LABEL_POLL_INTERVAL,
                max_staleness: LABEL_MAX_STALENESS,
            },
        )
    }

    fn start_with_timing(
        client: Arc<dyn LabelLogClient>,
        accounts: AccountEnforcement,
        records: RecordEnforcement,
        lifecycle: Arc<ControlLifecycle>,
        telemetry: Arc<FeedTelemetry>,
        timing: LabelTiming,
    ) -> Self {
        let (shutdown, receiver) = watch::channel(false);
        let staleness_guard = tokio::spawn(guard_label_staleness(
            Arc::clone(&lifecycle),
            timing.max_staleness,
            receiver.clone(),
        ));
        let task = tokio::spawn(run_forever(
            client,
            accounts,
            records,
            lifecycle,
            telemetry,
            timing.poll_interval,
            receiver,
        ));
        Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
            staleness_guard: tokio::sync::Mutex::new(Some(staleness_guard)),
        }
    }

    pub async fn stop(&self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
        if let Some(guard) = self.staleness_guard.lock().await.take() {
            let _ = guard.await;
        }
    }
}

async fn guard_label_staleness(
    lifecycle: Arc<ControlLifecycle>,
    max_staleness: Duration,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if lifecycle.withdraw_stale_labels(Instant::now(), max_staleness) {
            eprintln!("event=label_log_stale");
        }
        // A catch-up can only move the deadline later, so sleeping until the
        // current one never sleeps past the real one.
        let wake_at = lifecycle
            .labels_fresh_until(max_staleness)
            .unwrap_or_else(|| Instant::now() + max_staleness);
        tokio::select! {
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(wake_at)) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

async fn run_forever(
    client: Arc<dyn LabelLogClient>,
    accounts: AccountEnforcement,
    records: RecordEnforcement,
    lifecycle: Arc<ControlLifecycle>,
    telemetry: Arc<FeedTelemetry>,
    interval: Duration,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = run_cycle(&lifecycle, client.as_ref(), &accounts, &records, &telemetry) => {}
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
    records: &RecordEnforcement,
    telemetry: &FeedTelemetry,
) -> LabelCycle {
    let mut failures = EnforcementFailures::default();
    // Before the pages, so a negation is acted on one cycle after it is seen.
    reinstate_accounts(lifecycle, accounts, &mut failures).await;
    reinstate_records(lifecycle, accounts, &mut failures).await;
    let result = poll_to_caught_up(
        lifecycle,
        client,
        accounts,
        records,
        telemetry,
        &mut failures,
    )
    .await;
    for line in failures.lines() {
        eprintln!("{line}");
    }
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
    records: &RecordEnforcement,
    telemetry: &FeedTelemetry,
    failures: &mut EnforcementFailures,
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
        if let Some(line) = skipped_subjects_line(&page) {
            eprintln!("{line}");
        }
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
                failures.record("worker_stop");
            }
        }
        for (author_did, cid) in &effects.removed_blobs {
            records.blobs.remove(author_did, cid);
        }
        cursor = page.cursor;
        telemetry.record_label_poll(LabelPollOutcome::Ok);
    }
    LabelCycle::PageCapReached
}

async fn reinstate_accounts(
    lifecycle: &ControlLifecycle,
    accounts: &AccountEnforcement,
    failures: &mut EnforcementFailures,
) {
    let pending = match lifecycle.reinstating_accounts(REINSTATING_ACCOUNTS_PER_CYCLE) {
        Ok(pending) => pending,
        Err(_) => {
            failures.record("store");
            return;
        }
    };
    // Each resolution can take a full request timeout, and the label pages wait
    // behind this phase, so it stops starting new ones once the budget is spent.
    let budget_ends = Instant::now() + accounts.reinstatement_budget;
    for (did, attempts) in pending {
        if Instant::now() >= budget_ends {
            break;
        }
        let now = OffsetDateTime::now_utc();
        let resolution = match accounts
            .authority
            .resolve_enrollment(&did, now.unix_timestamp().max(0) as u64)
            .await
        {
            Ok(resolution) => resolution,
            // An unreachable authority says nothing about the hold, so it costs no attempt.
            Err(_) => {
                failures.record("authority");
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
            failures.record(kind);
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

/// Where a negated record's author is re-read from, which depends on who hosts it.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum ReplayScope {
    StratosActor { did: String },
    PdsMember { boundary: String, did: String },
}

async fn reinstate_records(
    lifecycle: &ControlLifecycle,
    accounts: &AccountEnforcement,
    failures: &mut EnforcementFailures,
) {
    let pending = match lifecycle.reinstating_records(REINSTATING_RECORDS_PER_CYCLE) {
        Ok(pending) => pending,
        Err(_) => {
            failures.record("store");
            return;
        }
    };
    // One replay serves every negated record of the same author in this cycle.
    let mut replays: BTreeMap<ReplayScope, bool> = BTreeMap::new();
    for uri in pending {
        let scope = match replay_scope(lifecycle, &uri) {
            Ok(Some(scope)) => scope,
            Ok(None) => {
                if lifecycle.finish_reinstatement(&uri).is_err() {
                    failures.record("store");
                }
                continue;
            }
            Err(kind) => {
                failures.record(kind);
                continue;
            }
        };
        let replayed = match replays.get(&scope) {
            Some(replayed) => *replayed,
            None => {
                let replayed = match replay_author(lifecycle, accounts, &scope).await {
                    Ok(()) => true,
                    Err(kind) => {
                        failures.record(kind);
                        false
                    }
                };
                replays.insert(scope, replayed);
                replayed
            }
        };
        // A failed replay leaves the row, so the next cycle tries again.
        if replayed && lifecycle.finish_reinstatement(&uri).is_err() {
            failures.record("store");
        }
    }
}

/// `None` means nothing needs re-reading: the author is not held by this feed
/// generator, or is held back by an account takedown.
fn replay_scope(
    lifecycle: &ControlLifecycle,
    uri: &str,
) -> Result<Option<ReplayScope>, &'static str> {
    let Ok(parsed) = RecordUri::parse(uri) else {
        return Ok(None);
    };
    let did = parsed.author().as_str().to_owned();
    if lifecycle.is_account_taken_down(&did).map_err(|_| "store")? {
        return Ok(None);
    }
    match member_boundary(uri) {
        Some(boundary) => {
            let current = lifecycle
                .pds_member_generation(&boundary, &did)
                .map_err(|_| "store")?
                .is_some();
            Ok(current.then_some(ReplayScope::PdsMember { boundary, did }))
        }
        None if matches!(parsed, RecordUri::Repo { .. }) => {
            let enrolled = lifecycle.is_actor_enrolled(&did).map_err(|_| "store")?;
            Ok(enrolled.then_some(ReplayScope::StratosActor { did }))
        }
        None => Ok(None),
    }
}

async fn replay_author(
    lifecycle: &ControlLifecycle,
    accounts: &AccountEnforcement,
    scope: &ReplayScope,
) -> Result<(), &'static str> {
    match scope {
        ReplayScope::StratosActor { did } => accounts
            .actors
            .replay_actor(did)
            .await
            .map(|_| ())
            .map_err(|_| "replay"),
        ReplayScope::PdsMember { boundary, did } => lifecycle
            .reset_pds_member_space_state(boundary, did)
            .map_err(|_| "store"),
    }
}

/// The boundary a space-form record belongs to, when it is the one boundary
/// space type this feed generator syncs.
fn member_boundary(uri: &str) -> Option<String> {
    let space = RecordUri::parse(uri).ok()?.space()?;
    let boundary = format!("{}/{}", space.authority(), space.space_key());
    let expected = boundary_to_space_uri(&boundary).ok()?;
    (expected == space.to_string()).then_some(boundary)
}

/// Counts enforcement failures by kind, so a cycle logs each kind once.
#[derive(Default)]
struct EnforcementFailures(BTreeMap<&'static str, usize>);

impl EnforcementFailures {
    fn record(&mut self, kind: &'static str) {
        *self.0.entry(kind).or_default() += 1;
    }

    fn lines(&self) -> Vec<String> {
        self.0
            .iter()
            .map(|(kind, count)| {
                format!("event=label_enforcement_failed kind={kind} count={count}")
            })
            .collect()
    }
}

/// Carries the count only; a skipped subject is a string nobody vouched for.
fn skipped_subjects_line(page: &LabelPage) -> Option<String> {
    (page.skipped_subjects > 0).then(|| {
        format!(
            "event=label_subjects_skipped count={}",
            page.skipped_subjects
        )
    })
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
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
    use sha2::Digest;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{
        AccountEnforcement, LabelCycle, LabelPoller, LabelTiming, RecordEnforcement, failure_line,
        run_cycle, skipped_subjects_line,
    };
    use crate::{
        actor_stream::{ActorPool, ActorStreamConfig},
        authority::HttpAuthorityClient,
        blob_cache::{BlobCache, MAX_CACHE_BYTES},
        blob_service::BlobService,
        blob_upstream::HttpBlobUpstream,
        feed_service::{FeedQuery, FeedServiceError},
        feeds::{FeedDescription, FeedRegistry},
        lifecycle::ControlLifecycle,
        moderation_label::LabelPage,
        readiness::{FeedReadinessGate, ReconciliationOutcome},
        service::ProjectionReader,
        service_auth::ServiceSigningKey,
        service_event::{EnrollmentAction, EnrollmentEvent},
        store::{
            ActorEnrollment, ActorPage, EncryptedStore, PdsSpaceMember, ProjectionPost,
            SpaceStageMutation, SpaceStagePage, StorageKey,
        },
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
        resolution_delay: Arc<Mutex<Option<Duration>>>,
        endless_log: Arc<AtomicBool>,
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

        /// `None` holds every resolution open until the client gives up.
        fn delay_resolutions(&self, delay: Option<Duration>) {
            *self.resolution_delay.lock().unwrap() =
                Some(delay.unwrap_or(Duration::from_secs(3600)));
        }

        /// Every cursor without a route answers with one more page, so no cycle catches up.
        fn never_drain_the_log(&self) {
            self.endless_log.store(true, Ordering::SeqCst);
        }
    }

    async fn respond_by_cursor(routes: impl IntoIterator<Item = (u64, Vec<u8>)>) -> Responder {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let routes = Arc::new(Mutex::new(routes.into_iter().collect::<BTreeMap<_, _>>()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let resolution = Arc::new(Mutex::new(http_response("404 Not Found", b"{}")));
        let resolve_calls = Arc::new(AtomicUsize::new(0));
        let resolution_delay = Arc::new(Mutex::new(None::<Duration>));
        let endless_log = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let routes = Arc::clone(&routes);
            let requests = Arc::clone(&requests);
            let resolution = Arc::clone(&resolution);
            let resolve_calls = Arc::clone(&resolve_calls);
            let resolution_delay = Arc::clone(&resolution_delay);
            let endless_log = Arc::clone(&endless_log);
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
                        let delay = *resolution_delay.lock().unwrap();
                        // Answered apart from the accept loop, so a slow resolution
                        // does not hold up label pages.
                        tokio::spawn(async move {
                            if let Some(delay) = delay {
                                tokio::time::sleep(delay).await;
                            }
                            let _ = stream.write_all(&response).await;
                            let _ = stream.shutdown().await;
                        });
                        continue;
                    }
                    let cursor = request_line
                        .split(['?', '&', ' '])
                        .find_map(|part| part.strip_prefix("cursor="))
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                    requests.lock().unwrap().push(cursor);
                    let routed = routes.lock().unwrap().get(&cursor).cloned();
                    let response = match routed {
                        Some(response) => response,
                        None if endless_log.load(Ordering::SeqCst) => label_page(cursor + 1, &[]),
                        None => http_response("404 Not Found", b"{}"),
                    };
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
            resolution_delay,
            endless_log,
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
            &record_enforcement(),
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
    async fn a_takedown_of_an_unparseable_uri_does_not_stall_the_label_cursor() {
        const LEGACY_FAYE_POST: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop/did:plc:faye/zone.stratos.feed.post/redtail";
        let responder = respond_by_cursor([
            (
                0,
                label_page(3, &[(1, SPIKE_POST), (2, LEGACY_FAYE_POST), (3, FAYE_POST)]),
            ),
            (3, label_page(3, &[])),
        ])
        .await;
        let (lifecycle, readiness) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));
        reconcile_session(&lifecycle);

        let cycle = run_cycle(
            &lifecycle,
            client(&responder).as_ref(),
            &enforcement(&responder, &lifecycle),
            &record_enforcement(),
            &FeedTelemetry::disabled(),
        )
        .await;

        assert_eq!(cycle, LabelCycle::CaughtUp);
        assert_eq!(lifecycle.label_cursor().unwrap(), 3);
        assert!(readiness.lock().unwrap().is_ready());
    }

    #[test]
    fn logs_the_skipped_count_of_a_page_and_never_a_uri() {
        let page = |skipped_subjects| LabelPage {
            cursor: 1,
            labels: Vec::new(),
            skipped_subjects,
        };
        assert_eq!(skipped_subjects_line(&page(0)), None);
        assert_eq!(
            skipped_subjects_line(&page(3)).as_deref(),
            Some("event=label_subjects_skipped count=3")
        );
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
            &record_enforcement(),
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
            &record_enforcement(),
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
            &record_enforcement(),
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
            &record_enforcement(),
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
        let poller = LabelPoller::start_with_timing(
            client(&responder),
            enforcement(&responder, &lifecycle),
            record_enforcement(),
            Arc::clone(&lifecycle),
            Arc::new(FeedTelemetry::disabled()),
            LabelTiming {
                poll_interval: Duration::from_millis(20),
                max_staleness: super::LABEL_MAX_STALENESS,
            },
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
            run_cycle(
                &lifecycle,
                label_client.as_ref(),
                &accounts,
                &record_enforcement(),
                &telemetry
            )
            .await,
            LabelCycle::CaughtUp
        );
        responder.set_routes([(4, http_response("500 Internal Server Error", b"{}"))]);
        assert_eq!(
            run_cycle(
                &lifecycle,
                label_client.as_ref(),
                &accounts,
                &record_enforcement(),
                &telemetry
            )
            .await,
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
            reinstatement_budget: super::ACCOUNT_REINSTATEMENT_BUDGET,
        }
    }

    fn record_enforcement() -> RecordEnforcement {
        RecordEnforcement {
            blobs: Arc::new(
                BlobService::new(
                    Arc::new(Mutex::new(
                        BlobCache::new(MAX_CACHE_BYTES, Duration::from_secs(60)).unwrap(),
                    )),
                    Arc::new(
                        HttpBlobUpstream::new(
                            "http://127.0.0.1:9",
                            AUTHORITY_DID.to_owned(),
                            "did:web:feedgen.example.test".to_owned(),
                            ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap(),
                        )
                        .unwrap(),
                    ),
                    1,
                )
                .unwrap(),
            ),
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
                interactions: crate::store::InteractionChanges::default(),
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
                &record_enforcement(),
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

    const SPIKE_SECOND_POST: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop2";
    const SPACE_BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const SPACE: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop";
    const FAYE_VALENTINE: &str = "did:plc:fayevalentine";
    const FAYE_SPACE_POST: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";
    const FAYE_SECOND_SPACE_POST: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/redtail";
    const SWORDFISH_BYTES: &[u8] = b"swordfish";

    fn swordfish_cid() -> String {
        cid::Cid::new_v1(
            0x55,
            multihash::Multihash::<64>::wrap(0x12, &sha2::Sha256::digest(SWORDFISH_BYTES)).unwrap(),
        )
        .to_string()
    }

    fn spike_blob_post() -> ProjectionPost {
        ProjectionPost {
            blob_refs_json: format!(
                r#"[{{"cid":"{}","mimeType":"image/png"}}]"#,
                swordfish_cid()
            )
            .into_bytes(),
            ..spike_post("bebop1")
        }
    }

    fn store_with_spike_blob_post() -> EncryptedStore {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
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
        store.apply_actor_page(spike_blob_page()).unwrap();
        store
    }

    fn spike_blob_page() -> ActorPage {
        ActorPage {
            authority_did: AUTHORITY_DID.to_owned(),
            actor_did: SPIKE.to_owned(),
            sequence: 3,
            upserts: vec![spike_blob_post(), spike_post("bebop2")],
            deletes: Vec::new(),
            updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
            interactions: crate::store::InteractionChanges::default(),
        }
    }

    fn store_with_faye_space_posts() -> EncryptedStore {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .replace_pds_space_members(
                SPACE_BOUNDARY,
                vec![PdsSpaceMember {
                    did: FAYE_VALENTINE.to_owned(),
                }],
                "1998-04-03T00:00:00.000Z",
            )
            .unwrap();
        let upsert = |uri: &str| SpaceStageMutation::Upsert {
            uri: uri.to_owned(),
            cid: "bafyreia".to_owned(),
            sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
            indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
            record_json: br#"{"text":"Swordfish"}"#.to_vec(),
            blob_refs_json: b"[]".to_vec(),
        };
        store
            .stage_authorized_space_page(
                SpaceStagePage {
                    space_uri: SPACE.to_owned(),
                    actor_did: FAYE_VALENTINE.to_owned(),
                    boundary: SPACE_BOUNDARY.to_owned(),
                    next_cursor: None,
                    updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
                },
                vec![upsert(FAYE_SPACE_POST), upsert(FAYE_SECOND_SPACE_POST)],
            )
            .unwrap();
        store
            .promote_authorized_space_stage(
                SPACE_BOUNDARY,
                SPACE,
                FAYE_VALENTINE,
                "1998-04-04T00:00:00.000Z",
            )
            .unwrap();
        store
    }

    struct RecordScene {
        responder: Responder,
        lifecycle: Arc<ControlLifecycle>,
        label_client: Arc<HttpAuthorityClient>,
        accounts: AccountEnforcement,
        records: RecordEnforcement,
        boundary: &'static str,
    }

    impl RecordScene {
        async fn new(store: EncryptedStore, boundary: &'static str) -> Self {
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
            lifecycle
                .apply_viewer_authorization(
                    crate::authorization::ViewerAuthorization {
                        did: "did:plc:faye".to_owned(),
                        boundaries: vec![boundary.to_owned()],
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
            Self {
                label_client: client(&responder),
                accounts: enforcement(&responder, &lifecycle),
                records: record_enforcement(),
                responder,
                lifecycle,
                boundary,
            }
        }

        async fn cycle(&self) -> LabelCycle {
            run_cycle(
                &self.lifecycle,
                self.label_client.as_ref(),
                &self.accounts,
                &self.records,
                &FeedTelemetry::disabled(),
            )
            .await
        }

        async fn catch_up_on_an_empty_log(&self) {
            self.responder.set_routes([(0, label_page(0, &[]))]);
            assert_eq!(self.cycle().await, LabelCycle::CaughtUp);
        }

        async fn take_down(&self, uri: &str) {
            let from = self.lifecycle.label_cursor().unwrap();
            self.responder.set_routes([
                (from, label_page(from + 1, &[(from + 1, uri)])),
                (from + 1, label_page(from + 1, &[])),
            ]);
            assert_eq!(self.cycle().await, LabelCycle::CaughtUp);
        }

        fn feeds(&self) -> FeedRegistry {
            FeedRegistry::new([FeedDescription {
                id: "bebop".to_owned(),
                boundary: self.boundary.to_owned(),
                display_name: None,
                description: None,
            }])
            .unwrap()
        }

        fn feed_text(&self) -> Result<String, FeedServiceError> {
            self.lifecycle
                .serve_viewer_feed(
                    "did:plc:faye",
                    &self.feeds(),
                    FeedQuery {
                        feed_id: "bebop",
                        cursor: None,
                        limit: 50,
                        now: 2,
                        as_of: BEFORE_RETENTION_ENDS,
                        blob_base_url: "https://feedgen.example.test",
                    },
                )
                .map(|(bytes, _)| String::from_utf8(bytes).unwrap())
        }

        fn feed_lists(&self, uri: &str) -> bool {
            self.feed_text().unwrap().contains(uri)
        }

        fn prepare_blob(&self) -> Option<(crate::admission::ReadToken, crate::store::BlobPost)> {
            self.lifecycle
                .prepare_viewer_blob(
                    "did:plc:faye",
                    &self.feeds(),
                    SPIKE_POST,
                    2,
                    BEFORE_RETENTION_ENDS,
                )
                .unwrap()
        }

        fn cached_blob(&self) -> Option<Arc<[u8]>> {
            self.records
                .blobs
                .cache()
                .lock()
                .unwrap()
                .get(SPIKE, &swordfish_cid())
        }
    }

    #[tokio::test]
    async fn a_taken_down_stratos_post_leaves_the_feed_and_siblings_stay() {
        let scene = RecordScene::new(store_with_spike_blob_post(), "bebop").await;
        scene.catch_up_on_an_empty_log().await;
        assert!(scene.feed_lists(SPIKE_POST));

        scene.take_down(SPIKE_POST).await;

        assert!(!scene.feed_lists(SPIKE_POST));
        assert!(scene.feed_lists(SPIKE_SECOND_POST));
    }

    #[tokio::test]
    async fn a_taken_down_space_post_leaves_the_feed_and_siblings_stay() {
        let scene = RecordScene::new(store_with_faye_space_posts(), SPACE_BOUNDARY).await;
        scene.catch_up_on_an_empty_log().await;
        assert!(scene.feed_lists(FAYE_SPACE_POST));

        scene.take_down(FAYE_SPACE_POST).await;

        assert!(!scene.feed_lists(FAYE_SPACE_POST));
        assert!(scene.feed_lists(FAYE_SECOND_SPACE_POST));
    }

    #[tokio::test]
    async fn a_fresh_start_applies_labels_before_serving_and_refuses_the_post() {
        let scene = RecordScene::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            "bebop",
        )
        .await;
        assert!(matches!(
            scene.feed_text(),
            Err(FeedServiceError::FeedNotReady)
        ));

        scene.take_down(SPIKE_POST).await;
        scene.lifecycle.apply_actor_page(spike_blob_page()).unwrap();

        assert!(!scene.feed_lists(SPIKE_POST));
        assert!(scene.feed_lists(SPIKE_SECOND_POST));
    }

    #[tokio::test]
    async fn a_takedown_evicts_the_cached_blob_of_the_post() {
        let scene = RecordScene::new(store_with_spike_blob_post(), "bebop").await;
        scene.catch_up_on_an_empty_log().await;
        scene
            .records
            .blobs
            .cache()
            .lock()
            .unwrap()
            .put(SPIKE, &swordfish_cid(), SWORDFISH_BYTES.to_vec())
            .unwrap();
        assert!(scene.cached_blob().is_some());
        assert!(scene.prepare_blob().is_some());

        scene.take_down(SPIKE_POST).await;

        assert!(scene.cached_blob().is_none());
        assert!(scene.prepare_blob().is_none());
    }

    #[tokio::test]
    async fn a_blob_token_prepared_before_a_takedown_is_not_released() {
        let scene = RecordScene::new(store_with_spike_blob_post(), "bebop").await;
        scene.catch_up_on_an_empty_log().await;
        let (token, _) = scene
            .prepare_blob()
            .expect("the blob is served before takedown");

        scene.take_down(SPIKE_POST).await;

        assert!(scene.lifecycle.release_blob(token, (), 2).is_none());
    }

    use std::collections::VecDeque;

    use async_trait::async_trait;
    use serde_json::json;

    use crate::{
        credential_issuer::{
            CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
        },
        credential_manager::SpaceCredentialManager,
        membership_reconciler::PdsPollTarget,
        pds_space_sync::{
            PdsSpaceSynchronizer, SpaceCommitVerificationPort, SpacePageReader, SpacePageSource,
        },
        space_commit::CommitVerification,
        space_host::{SpaceHostError, SpaceHostPage},
        space_http_signature::SpaceHttpSignatureKey,
        space_sync::{POST_COLLECTION, SpacePage, SpaceRepoOp},
    };

    #[derive(Clone, Copy)]
    enum Sub<'a> {
        Record(&'a str),
        Account(&'a str),
    }

    fn label_log_page(cursor: u64, labels: &[(u64, Sub<'_>, bool)]) -> Vec<u8> {
        let labels = labels
            .iter()
            .map(|(seq, subject, neg)| {
                let subject = match subject {
                    Sub::Record(uri) => format!(
                        r##"{{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"{uri}"}}"##
                    ),
                    Sub::Account(did) => format!(
                        r##"{{"$type":"zone.stratos.moderation.defs#accountSubject","did":"{did}"}}"##
                    ),
                };
                format!(
                    r#"{{"seq":{seq},"subject":{subject},"val":"!takedown","neg":{neg},"createdAt":"1998-04-03T00:00:00Z"}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        http_response(
            "200 OK",
            format!(r#"{{"cursor":"{cursor}","labels":[{labels}]}}"#).as_bytes(),
        )
    }

    struct Issuer;

    #[async_trait]
    impl SpaceCredentialIssuer for Issuer {
        async fn mint(
            &self,
            _: &str,
            _: &SpaceHttpSignatureKey,
            _: u64,
        ) -> Result<IssuedSpaceCredential, CredentialMintError> {
            Ok(IssuedSpaceCredential {
                credential: "header.payload.signature".to_owned(),
                expires_at: CredentialExpiry::from_epoch_seconds(10_000),
            })
        }
    }

    #[derive(Clone)]
    struct HostPages {
        pages: Arc<Mutex<VecDeque<SpaceHostPage>>>,
        requested_cursors: Arc<Mutex<Vec<Option<String>>>>,
    }

    #[async_trait]
    impl SpacePageReader for HostPages {
        async fn list_page(
            &self,
            _: &PdsPollTarget,
            cursor: Option<&str>,
            _: usize,
        ) -> Result<SpaceHostPage, SpaceHostError> {
            self.requested_cursors
                .lock()
                .unwrap()
                .push(cursor.map(str::to_owned));
            self.pages
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(SpaceHostError::Unreachable)
        }
    }

    #[async_trait]
    impl SpacePageSource for HostPages {
        async fn connect(
            &self,
            _: &PdsPollTarget,
            _: Arc<crate::space_credential::HeldSpaceCredential>,
        ) -> Result<Arc<dyn SpacePageReader>, SpaceHostError> {
            Ok(Arc::new(self.clone()))
        }
    }

    struct Verified;

    #[async_trait]
    impl SpaceCommitVerificationPort for Verified {
        async fn verify(
            &self,
            _: &str,
            _: &str,
            _: Option<&serde_json::Value>,
        ) -> CommitVerification {
            CommitVerification::Verified
        }
    }

    fn listing(cursor: Option<&str>, rkeys: &[&str]) -> SpaceHostPage {
        SpaceHostPage {
            page: SpacePage {
                ops: rkeys
                    .iter()
                    .map(|rkey| SpaceRepoOp {
                        collection: POST_COLLECTION.to_owned(),
                        rkey: (*rkey).to_owned(),
                        cid: Some(
                            "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                        ),
                        value: Some(
                            json!({ "$type": POST_COLLECTION, "createdAt": "1998-04-03T00:00:00.000Z" }),
                        ),
                    })
                    .collect(),
                next_cursor: cursor.map(str::to_owned),
            },
            commit: None,
        }
    }

    fn fixed_credential_clock() -> u64 {
        1_000
    }

    const FAR_RETENTION: &str = "2100-01-01T00:00:00.000Z";

    fn faye_member() -> PdsSpaceMember {
        PdsSpaceMember {
            did: FAYE_VALENTINE.to_owned(),
        }
    }

    async fn sync_faye(
        lifecycle: &ControlLifecycle,
        pages: Vec<SpaceHostPage>,
    ) -> Vec<Option<String>> {
        let host = HostPages {
            pages: Arc::new(Mutex::new(pages.into())),
            requested_cursors: Arc::new(Mutex::new(Vec::new())),
        };
        let synchronizer = PdsSpaceSynchronizer::new(
            Arc::new(host.clone()),
            Arc::new(SpaceCredentialManager::with_clock(
                Arc::new(Issuer),
                fixed_credential_clock,
            )),
            Arc::new(Verified),
        );
        let target = PdsPollTarget {
            space_uri: SPACE.to_owned(),
            boundary: SPACE_BOUNDARY.to_owned(),
            did: FAYE_VALENTINE.to_owned(),
            host: "https://pds.example.test/".to_owned(),
            generation: lifecycle
                .pds_member_generation(SPACE_BOUNDARY, FAYE_VALENTINE)
                .unwrap()
                .expect("faye is a current member"),
        };
        let observed_at = super::format_utc_millis(time::OffsetDateTime::now_utc());
        let _ = synchronizer
            .sync_target(lifecycle, &target, &observed_at, FAR_RETENTION)
            .await;
        host.requested_cursors.lock().unwrap().clone()
    }

    impl RecordScene {
        fn publish(&self, labels: &[(Sub<'_>, bool)]) {
            let from = self.lifecycle.label_cursor().unwrap();
            let numbered = labels
                .iter()
                .enumerate()
                .map(|(index, (subject, neg))| (from + 1 + index as u64, *subject, *neg))
                .collect::<Vec<_>>();
            let to = from + labels.len() as u64;
            self.responder.set_routes([
                (from, label_log_page(to, &numbered)),
                (to, label_log_page(to, &[])),
            ]);
        }

        async fn publish_and_cycle(&self, labels: &[(Sub<'_>, bool)]) {
            self.publish(labels);
            assert_eq!(self.cycle().await, LabelCycle::CaughtUp);
        }

        fn replays(&self) -> u64 {
            self.accounts.actors.replays_completed()
        }

        fn spike_cursor(&self) -> Option<u64> {
            self.lifecycle
                .actor_sync_state(AUTHORITY_DID, SPIKE)
                .unwrap()
                .expect("spike is enrolled")
                .cursor
        }

        fn faye_space_cursor(&self) -> Option<String> {
            self.lifecycle
                .pds_space_cursor(SPACE_BOUNDARY, SPACE, FAYE_VALENTINE)
                .unwrap()
        }

        fn reinstating_records(&self) -> Vec<String> {
            self.lifecycle.reinstating_records(10).unwrap()
        }
    }

    async fn stratos_scene() -> RecordScene {
        let scene = RecordScene::new(memory_store_with_spike_posts(), "bebop").await;
        scene.accounts.actors.sync_from_store().await.unwrap();
        scene.catch_up_on_an_empty_log().await;
        scene
    }

    async fn pds_scene() -> RecordScene {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .replace_pds_space_members(
                SPACE_BOUNDARY,
                vec![faye_member()],
                "1998-04-03T00:00:00.000Z",
            )
            .unwrap();
        let scene = RecordScene::new(store, SPACE_BOUNDARY).await;
        scene.catch_up_on_an_empty_log().await;
        sync_faye(
            &scene.lifecycle,
            vec![
                listing(Some("c1"), &["swordfish", "redtail"]),
                listing(None, &[]),
            ],
        )
        .await;
        assert_eq!(scene.faye_space_cursor().as_deref(), Some("c1"));
        scene
    }

    #[tokio::test]
    async fn a_negated_stratos_post_returns_by_replay_while_another_takedown_stays_refused() {
        let scene = stratos_scene().await;
        scene
            .publish_and_cycle(&[
                (Sub::Record(SPIKE_POST), false),
                (Sub::Record(SPIKE_SECOND_POST), false),
            ])
            .await;
        assert!(!scene.feed_lists(SPIKE_POST));
        scene
            .publish_and_cycle(&[(Sub::Record(SPIKE_POST), true)])
            .await;
        assert_eq!(scene.spike_cursor(), Some(3));

        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);

        assert_eq!(scene.spike_cursor(), None);
        assert!(scene.reinstating_records().is_empty());
        scene
            .lifecycle
            .apply_actor_page(ActorPage {
                authority_did: AUTHORITY_DID.to_owned(),
                actor_did: SPIKE.to_owned(),
                sequence: 1,
                upserts: vec![spike_post("bebop1"), spike_post("bebop2")],
                deletes: Vec::new(),
                updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
                interactions: crate::store::InteractionChanges::default(),
            })
            .unwrap();
        assert!(scene.feed_lists(SPIKE_POST));
        assert!(!scene.feed_lists(SPIKE_SECOND_POST));
    }

    #[tokio::test]
    async fn a_negated_space_post_returns_after_the_next_listing_from_the_start() {
        let scene = pds_scene().await;
        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), false)])
            .await;
        assert!(!scene.feed_lists(FAYE_SPACE_POST));
        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), true)])
            .await;
        assert_eq!(scene.faye_space_cursor().as_deref(), Some("c1"));

        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);

        assert_eq!(scene.faye_space_cursor(), None);
        assert!(scene.reinstating_records().is_empty());
        let requested = sync_faye(
            &scene.lifecycle,
            vec![listing(None, &["swordfish", "redtail"])],
        )
        .await;
        assert_eq!(requested, [None]);
        assert!(scene.feed_lists(FAYE_SPACE_POST));
        assert!(scene.feed_lists(FAYE_SECOND_SPACE_POST));
    }

    #[tokio::test]
    async fn a_reset_member_is_listed_exactly_like_a_first_ingest() {
        let fresh = {
            let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
            store
                .replace_pds_space_members(
                    SPACE_BOUNDARY,
                    vec![faye_member()],
                    "1998-04-03T00:00:00.000Z",
                )
                .unwrap();
            RecordScene::new(store, SPACE_BOUNDARY).await
        };
        fresh.catch_up_on_an_empty_log().await;
        let first_ingest = sync_faye(
            &fresh.lifecycle,
            vec![listing(None, &["swordfish", "redtail"])],
        )
        .await;

        let scene = pds_scene().await;
        scene
            .publish_and_cycle(&[
                (Sub::Record(FAYE_SPACE_POST), false),
                (Sub::Record(FAYE_SECOND_SPACE_POST), false),
            ])
            .await;
        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), true)])
            .await;
        scene.cycle().await;
        let after_reset = sync_faye(
            &scene.lifecycle,
            vec![listing(None, &["swordfish", "redtail"])],
        )
        .await;

        assert_eq!(first_ingest, [None]);
        assert_eq!(after_reset, first_ingest);
        assert!(scene.feed_lists(FAYE_SPACE_POST));
        assert!(!scene.feed_lists(FAYE_SECOND_SPACE_POST));
    }

    #[tokio::test]
    async fn a_negation_seen_this_cycle_replays_only_on_the_next() {
        let scene = stratos_scene().await;
        scene
            .publish_and_cycle(&[(Sub::Record(SPIKE_POST), false)])
            .await;

        scene
            .publish_and_cycle(&[(Sub::Record(SPIKE_POST), true)])
            .await;
        assert_eq!(scene.replays(), 0);
        assert_eq!(scene.spike_cursor(), Some(3));
        assert_eq!(scene.reinstating_records(), [SPIKE_POST]);

        scene.cycle().await;
        assert_eq!(scene.replays(), 1);
        assert_eq!(scene.spike_cursor(), None);
    }

    #[tokio::test]
    async fn several_negated_posts_of_one_author_cost_one_replay() {
        let scene = stratos_scene().await;
        scene
            .publish_and_cycle(&[
                (Sub::Record(SPIKE_POST), false),
                (Sub::Record(SPIKE_SECOND_POST), false),
            ])
            .await;
        scene
            .publish_and_cycle(&[
                (Sub::Record(SPIKE_POST), true),
                (Sub::Record(SPIKE_SECOND_POST), true),
            ])
            .await;
        assert_eq!(scene.reinstating_records().len(), 2);

        scene.cycle().await;

        assert_eq!(scene.replays(), 1);
        assert!(scene.reinstating_records().is_empty());
    }

    #[tokio::test]
    async fn a_negated_post_of_an_account_under_takedown_is_not_replayed() {
        let scene = pds_scene().await;
        scene
            .publish_and_cycle(&[
                (Sub::Record(FAYE_SPACE_POST), false),
                (Sub::Account(FAYE_VALENTINE), false),
            ])
            .await;
        // A membership listing fetched before the hold can still name her.
        scene
            .lifecycle
            .replace_pds_space_members(
                SPACE_BOUNDARY,
                vec![faye_member()],
                "1998-04-03T00:00:00.000Z",
            )
            .unwrap();
        sync_faye(
            &scene.lifecycle,
            vec![listing(Some("c2"), &[]), listing(None, &[])],
        )
        .await;
        assert_eq!(scene.faye_space_cursor().as_deref(), Some("c2"));

        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), true)])
            .await;
        assert_eq!(scene.reinstating_records(), [FAYE_SPACE_POST]);

        scene.cycle().await;

        assert!(scene.reinstating_records().is_empty());
        assert_eq!(scene.faye_space_cursor().as_deref(), Some("c2"));
    }

    #[tokio::test]
    async fn a_negated_post_of_an_author_that_is_not_enrolled_is_finished_without_a_replay() {
        let scene = RecordScene::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            "bebop",
        )
        .await;
        scene.catch_up_on_an_empty_log().await;
        scene
            .publish_and_cycle(&[(Sub::Record(SPIKE_POST), false)])
            .await;
        scene
            .publish_and_cycle(&[(Sub::Record(SPIKE_POST), true)])
            .await;
        assert_eq!(scene.reinstating_records(), [SPIKE_POST]);

        scene.cycle().await;

        assert!(scene.reinstating_records().is_empty());
        assert_eq!(scene.replays(), 0);
    }

    #[tokio::test]
    async fn a_negated_space_post_of_a_non_member_is_finished() {
        let scene = RecordScene::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            SPACE_BOUNDARY,
        )
        .await;
        scene.catch_up_on_an_empty_log().await;
        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), false)])
            .await;
        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), true)])
            .await;
        assert_eq!(scene.reinstating_records(), [FAYE_SPACE_POST]);

        scene.cycle().await;

        assert!(scene.reinstating_records().is_empty());
    }

    #[tokio::test]
    async fn a_replay_that_cannot_run_is_retried_on_a_later_cycle() {
        let scene = stratos_scene().await;
        scene
            .publish_and_cycle(&[(Sub::Record(SPIKE_POST), false)])
            .await;
        scene
            .publish_and_cycle(&[(Sub::Record(SPIKE_POST), true)])
            .await;
        scene.accounts.actors.stop().await;

        scene.cycle().await;

        assert_eq!(scene.reinstating_records(), [SPIKE_POST]);
        assert_eq!(scene.spike_cursor(), Some(3));
    }

    #[test]
    fn a_space_record_maps_to_the_boundary_of_its_space() {
        assert_eq!(
            super::member_boundary(FAYE_SPACE_POST).as_deref(),
            Some(SPACE_BOUNDARY)
        );
        assert_eq!(super::member_boundary(SPIKE_POST), None);
        assert_eq!(
            super::member_boundary(
                "at:space/did:web:stratos.example.test/zone.stratos.space.other/bebop/did:plc:fayevalentine/zone.stratos.feed.post/swordfish"
            ),
            None
        );
    }

    #[test]
    fn a_negated_record_in_the_previous_spelling_has_nothing_to_replay() {
        const LEGACY_CREW_POST: &str = "at://did:web:bebop.example/space/zone.stratos.space.feed/crew/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";
        let (lifecycle, _readiness) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));

        assert_eq!(super::replay_scope(&lifecycle, LEGACY_CREW_POST), Ok(None));
    }

    #[test]
    fn member_boundary_follows_the_canonical_space_spelling() {
        const CREW_POST: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/crew/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";
        const OTHER_TYPE_POST: &str = "at:space/did:web:bebop.example/zone.stratos.space.chat/crew/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";
        const LEGACY_CREW_POST: &str = "at://did:web:bebop.example/space/zone.stratos.space.feed/crew/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";
        assert_eq!(
            super::member_boundary(CREW_POST).as_deref(),
            Some("did:web:bebop.example/crew")
        );
        assert_eq!(super::member_boundary(OTHER_TYPE_POST), None);
        assert_eq!(super::member_boundary(LEGACY_CREW_POST), None);
        assert_eq!(
            super::member_boundary("at://did:plc:fayevalentine/zone.stratos.feed.post/swordfish"),
            None
        );
    }

    struct StalenessScene {
        responder: Responder,
        lifecycle: Arc<ControlLifecycle>,
        accounts: AccountEnforcement,
        started: std::time::Instant,
    }

    impl StalenessScene {
        async fn caught_up() -> Self {
            let responder = respond_by_cursor(two_pages_then_no_progress()).await;
            let (lifecycle, _) = lifecycle_with(Arc::new(FeedTelemetry::disabled()));
            reconcile_session(&lifecycle);
            let accounts = enforcement(&responder, &lifecycle);
            let started = std::time::Instant::now();
            let mut scene = Self {
                responder,
                lifecycle,
                accounts,
                started,
            };
            assert_eq!(scene.cycle_at(Duration::ZERO).await, LabelCycle::CaughtUp);
            assert!(serve_feed(&scene.lifecycle).is_ok());
            scene
        }

        async fn cycle_at(&mut self, elapsed: Duration) -> LabelCycle {
            let stamp_before = self
                .lifecycle
                .labels_fresh_until(super::LABEL_MAX_STALENESS);
            let cycle = run_cycle(
                &self.lifecycle,
                client(&self.responder).as_ref(),
                &self.accounts,
                &record_enforcement(),
                &FeedTelemetry::disabled(),
            )
            .await;
            // A catch-up is stamped with the real clock, so the check runs at the
            // stated instant only after a cycle that left the stamp alone. A cycle
            // that moved it without catching up stays visible as reopened reads.
            let stamp_after = self
                .lifecycle
                .labels_fresh_until(super::LABEL_MAX_STALENESS);
            if cycle != LabelCycle::CaughtUp && stamp_after == stamp_before {
                self.lifecycle
                    .withdraw_stale_labels(self.started + elapsed, super::LABEL_MAX_STALENESS);
            }
            cycle
        }

        fn log_is_down(&self) {
            self.responder
                .set_routes([(4, http_response("500 Internal Server Error", b"{}"))]);
        }

        fn serves(&self) -> bool {
            serve_feed(&self.lifecycle).is_ok()
        }
    }

    #[tokio::test]
    async fn failures_shorter_than_the_bound_keep_feeds_open() {
        let mut scene = StalenessScene::caught_up().await;
        scene.log_is_down();

        let cycle = scene.cycle_at(super::LABEL_POLL_INTERVAL * 4).await;

        assert_eq!(cycle, LabelCycle::Failed(LabelPollOutcome::Unavailable));
        assert!(scene.serves());
    }

    #[tokio::test]
    async fn failures_past_the_bound_close_feeds() {
        let mut scene = StalenessScene::caught_up().await;
        scene.log_is_down();

        scene
            .cycle_at(super::LABEL_MAX_STALENESS + Duration::from_secs(1))
            .await;

        assert!(matches!(
            serve_feed(&scene.lifecycle),
            Err(FeedServiceError::FeedNotReady)
        ));
    }

    #[tokio::test]
    async fn a_catch_up_after_the_bound_reopens_feeds_without_a_restart() {
        let mut scene = StalenessScene::caught_up().await;
        scene.log_is_down();
        let outage = super::LABEL_MAX_STALENESS + Duration::from_secs(1);
        scene.cycle_at(outage).await;
        assert!(!scene.serves());

        scene.responder.set_routes([(4, label_page(4, &[]))]);
        let cycle = scene.cycle_at(outage + super::LABEL_POLL_INTERVAL).await;

        assert_eq!(cycle, LabelCycle::CaughtUp);
        assert!(scene.serves());
    }

    #[tokio::test]
    async fn a_backlog_page_after_the_bound_does_not_reopen_feeds_before_the_log_is_drained() {
        let mut scene = StalenessScene::caught_up().await;
        scene.log_is_down();
        let outage = super::LABEL_MAX_STALENESS + Duration::from_secs(1);
        scene.cycle_at(outage).await;
        assert!(!scene.serves());

        scene.responder.set_routes([
            (4, label_page(6, &[])),
            (6, http_response("500 Internal Server Error", b"{}")),
        ]);
        let cycle = scene.cycle_at(outage + super::LABEL_POLL_INTERVAL).await;
        assert_eq!(cycle, LabelCycle::Failed(LabelPollOutcome::Unavailable));
        assert_eq!(scene.lifecycle.label_cursor().unwrap(), 6);
        assert!(!scene.serves());

        scene.responder.set_routes([(6, label_page(6, &[]))]);
        let cycle = scene
            .cycle_at(outage + super::LABEL_POLL_INTERVAL * 2)
            .await;
        assert_eq!(cycle, LabelCycle::CaughtUp);
        assert!(scene.serves());
    }

    // Short enough that no test waits on the production bound.
    const TEST_STALENESS: Duration = Duration::from_millis(300);
    const TEST_POLL_INTERVAL: Duration = Duration::from_millis(20);
    // Room for scheduling on a loaded machine, still far below the 5 s request timeout.
    const SCHEDULING_SLACK: Duration = Duration::from_millis(700);
    const ED: &str = "did:plc:radicaledward";

    fn start_poller(
        responder: &Responder,
        lifecycle: &Arc<ControlLifecycle>,
        accounts: AccountEnforcement,
    ) -> LabelPoller {
        LabelPoller::start_with_timing(
            client(responder),
            accounts,
            record_enforcement(),
            Arc::clone(lifecycle),
            Arc::new(FeedTelemetry::disabled()),
            LabelTiming {
                poll_interval: TEST_POLL_INTERVAL,
                max_staleness: TEST_STALENESS,
            },
        )
    }

    async fn feeds_close_within(lifecycle: &ControlLifecycle, window: Duration) -> bool {
        let deadline = std::time::Instant::now() + window;
        while std::time::Instant::now() < deadline {
            if matches!(serve_feed(lifecycle), Err(FeedServiceError::FeedNotReady)) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    // The feeds can close while the first capped cycle is still reading, so
    // the second cycle is waited for rather than expected at that instant.
    async fn more_than_one_cycle_of_pages_is_read(responder: &Responder) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if responder.requested_cursors().len() > super::MAX_LABEL_PAGES_PER_CYCLE {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    async fn feeds_open_within(lifecycle: &ControlLifecycle, window: Duration) -> bool {
        let deadline = std::time::Instant::now() + window;
        while std::time::Instant::now() < deadline {
            if serve_feed(lifecycle).is_ok() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    async fn scene_with_a_reinstating_account() -> Scene {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.takedown().await;
        scene.announce_negation();
        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);
        assert_eq!(scene.lifecycle.reinstating_accounts(10).unwrap().len(), 1);
        assert!(serve_feed(&scene.lifecycle).is_ok());
        scene
    }

    #[tokio::test]
    async fn a_hung_reinstatement_and_an_unreachable_log_close_feeds_at_the_bound() {
        let scene = scene_with_a_reinstating_account().await;
        scene.responder.delay_resolutions(None);
        scene
            .responder
            .set_routes([(2, http_response("500 Internal Server Error", b"{}"))]);
        let pages_before = scene.responder.requested_cursors().len();

        let poller = start_poller(&scene.responder, &scene.lifecycle, scene.accounts.clone());
        tokio::time::sleep(TEST_STALENESS / 2).await;
        assert!(serve_feed(&scene.lifecycle).is_ok());

        assert!(
            feeds_close_within(&scene.lifecycle, TEST_STALENESS / 2 + SCHEDULING_SLACK).await,
            "feeds stayed open past the bound"
        );
        // The cycle is still waiting on its first resolution and has read no page.
        assert_eq!(scene.responder.resolve_call_count(), 1);
        assert_eq!(scene.responder.requested_cursors().len(), pages_before);
        poller.stop().await;
    }

    #[tokio::test]
    async fn sustained_page_cap_cycles_close_feeds_at_the_bound() {
        let scene = StalenessScene::caught_up().await;
        scene.responder.set_routes([]);
        scene.responder.never_drain_the_log();

        let poller = start_poller(&scene.responder, &scene.lifecycle, scene.accounts.clone());
        tokio::time::sleep(TEST_STALENESS / 2).await;
        assert!(serve_feed(&scene.lifecycle).is_ok());

        assert!(
            feeds_close_within(&scene.lifecycle, TEST_STALENESS / 2 + SCHEDULING_SLACK).await,
            "feeds stayed open past the bound"
        );
        assert!(
            more_than_one_cycle_of_pages_is_read(&scene.responder).await,
            "the poller stopped reading after its first capped cycle"
        );
        poller.stop().await;
    }

    #[tokio::test]
    async fn a_catch_up_reopens_feeds_the_bound_closed() {
        let scene = StalenessScene::caught_up().await;
        scene.log_is_down();
        let poller = start_poller(&scene.responder, &scene.lifecycle, scene.accounts.clone());
        assert!(feeds_close_within(&scene.lifecycle, TEST_STALENESS + SCHEDULING_SLACK).await);

        scene.responder.set_routes([(4, label_page(4, &[]))]);

        assert!(feeds_open_within(&scene.lifecycle, SCHEDULING_SLACK).await);
        poller.stop().await;
    }

    #[tokio::test]
    async fn a_slow_but_successful_cycle_does_not_flap() {
        let scene = scene_with_a_reinstating_account().await;
        // An unanswered resolution costs no attempt, so every cycle stays this slow.
        scene.responder.delay_resolutions(Some(TEST_STALENESS / 3));

        let poller = start_poller(&scene.responder, &scene.lifecycle, scene.accounts.clone());
        let watched_until = std::time::Instant::now() + TEST_STALENESS * 4;
        while std::time::Instant::now() < watched_until {
            assert!(serve_feed(&scene.lifecycle).is_ok(), "feeds flapped");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert!(scene.responder.resolve_call_count() >= 3);
        poller.stop().await;
    }

    #[tokio::test]
    async fn a_dead_poller_task_still_closes_feeds_at_the_bound() {
        let scene = StalenessScene::caught_up().await;
        let pages_before = scene.responder.requested_cursors().len();
        let poller = start_poller(&scene.responder, &scene.lifecycle, scene.accounts.clone());
        wait_for_requests(&scene.responder, pages_before + 1).await;

        poller
            .task
            .lock()
            .await
            .as_ref()
            .expect("the poller task runs")
            .abort();
        assert!(serve_feed(&scene.lifecycle).is_ok());

        assert!(
            feeds_close_within(&scene.lifecycle, TEST_STALENESS + SCHEDULING_SLACK).await,
            "feeds stayed open after the poller died"
        );
        poller.stop().await;
    }

    #[tokio::test]
    async fn the_account_phase_stops_at_its_budget_and_the_pages_are_still_read() {
        let scene = Scene::enrolled_with_two_posts().await;
        scene.responder.set_routes([
            (0, account_page(2, &[(1, SPIKE, false), (2, ED, false)])),
            (2, account_page(2, &[])),
        ]);
        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);
        scene.responder.set_routes([
            (2, account_page(4, &[(3, SPIKE, true), (4, ED, true)])),
            (4, account_page(4, &[])),
        ]);
        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);
        assert_eq!(scene.lifecycle.reinstating_accounts(10).unwrap().len(), 2);
        scene
            .responder
            .delay_resolutions(Some(Duration::from_millis(150)));
        let budgeted = AccountEnforcement {
            reinstatement_budget: Duration::from_millis(100),
            ..scene.accounts.clone()
        };
        let pages_before = scene.responder.requested_cursors().len();

        let cycle = run_cycle(
            &scene.lifecycle,
            scene.label_client.as_ref(),
            &budgeted,
            &record_enforcement(),
            &FeedTelemetry::disabled(),
        )
        .await;

        assert_eq!(cycle, LabelCycle::CaughtUp);
        assert_eq!(scene.responder.resolve_call_count(), 1);
        assert_eq!(scene.responder.requested_cursors().len(), pages_before + 1);
        assert_eq!(scene.lifecycle.reinstating_accounts(10).unwrap().len(), 2);
    }

    /// Lists like `HostPages`, but holds its first page until released.
    #[derive(Clone)]
    struct HeldHostPages {
        pages: HostPages,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        held: Arc<AtomicBool>,
    }

    #[async_trait]
    impl SpacePageReader for HeldHostPages {
        async fn list_page(
            &self,
            target: &PdsPollTarget,
            cursor: Option<&str>,
            limit: usize,
        ) -> Result<SpaceHostPage, SpaceHostError> {
            if !self.held.swap(true, Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            self.pages.list_page(target, cursor, limit).await
        }
    }

    #[async_trait]
    impl SpacePageSource for HeldHostPages {
        async fn connect(
            &self,
            _: &PdsPollTarget,
            _: Arc<crate::space_credential::HeldSpaceCredential>,
        ) -> Result<Arc<dyn SpacePageReader>, SpaceHostError> {
            Ok(Arc::new(self.clone()))
        }
    }

    #[tokio::test]
    async fn a_space_reset_wins_over_a_sync_already_in_flight() {
        let scene = pds_scene().await;
        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), false)])
            .await;
        scene
            .publish_and_cycle(&[(Sub::Record(FAYE_SPACE_POST), true)])
            .await;
        let held = HeldHostPages {
            pages: HostPages {
                pages: Arc::new(Mutex::new(
                    vec![listing(Some("c9"), &["swordfish", "redtail"])].into(),
                )),
                requested_cursors: Arc::new(Mutex::new(Vec::new())),
            },
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
            held: Arc::new(AtomicBool::new(false)),
        };
        let synchronizer = PdsSpaceSynchronizer::new(
            Arc::new(held.clone()),
            Arc::new(SpaceCredentialManager::with_clock(
                Arc::new(Issuer),
                fixed_credential_clock,
            )),
            Arc::new(Verified),
        );
        let target = PdsPollTarget {
            space_uri: SPACE.to_owned(),
            boundary: SPACE_BOUNDARY.to_owned(),
            did: FAYE_VALENTINE.to_owned(),
            host: "https://pds.example.test/".to_owned(),
            generation: scene
                .lifecycle
                .pds_member_generation(SPACE_BOUNDARY, FAYE_VALENTINE)
                .unwrap()
                .expect("faye is a current member"),
        };
        let in_flight = tokio::spawn({
            let lifecycle = Arc::clone(&scene.lifecycle);
            async move {
                let observed_at = super::format_utc_millis(time::OffsetDateTime::now_utc());
                synchronizer
                    .sync_target(&lifecycle, &target, &observed_at, FAR_RETENTION)
                    .await
            }
        });
        held.entered.notified().await;

        assert_eq!(scene.cycle().await, LabelCycle::CaughtUp);
        assert!(scene.reinstating_records().is_empty());
        held.release.notify_one();
        let outcome = in_flight.await.unwrap();

        assert_eq!(scene.faye_space_cursor(), None);
        assert!(
            matches!(
                outcome,
                Err(crate::pds_space_sync::PdsSpaceSyncError::Target(
                    crate::space_sync::SpaceSyncError::UnauthorizedTarget
                ))
            ),
            "{outcome:?}"
        );
        assert_eq!(
            held.pages.requested_cursors.lock().unwrap().clone(),
            [Some("c1".to_owned())]
        );
        assert!(
            scene
                .lifecycle
                .pds_member_generation(SPACE_BOUNDARY, FAYE_VALENTINE)
                .unwrap()
                .is_some(),
            "faye stays a member"
        );
        let next_pass = sync_faye(
            &scene.lifecycle,
            vec![listing(None, &["swordfish", "redtail"])],
        )
        .await;
        assert_eq!(next_pass, [None]);
        assert!(scene.feed_lists(FAYE_SPACE_POST));
    }

    #[test]
    fn a_cycle_logs_each_enforcement_failure_kind_once_with_a_count() {
        let mut failures = super::EnforcementFailures::default();
        for kind in ["authority", "store", "authority", "replay", "authority"] {
            failures.record(kind);
        }

        assert_eq!(
            failures.lines(),
            [
                "event=label_enforcement_failed kind=authority count=3",
                "event=label_enforcement_failed kind=replay count=1",
                "event=label_enforcement_failed kind=store count=1",
            ]
        );
        assert!(super::EnforcementFailures::default().lines().is_empty());
    }
}
