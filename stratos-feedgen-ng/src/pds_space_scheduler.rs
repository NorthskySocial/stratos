use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use time::OffsetDateTime;
use tokio::{sync::watch, task::JoinSet};

use crate::{
    config::ProjectionRetention,
    lifecycle::ControlLifecycle,
    membership_reconciler::{MembershipReconciler, MembershipReconciliationError},
    pds_space_sync::{FailureReason, PdsSpaceSynchronizer, VerifiedSyncOutcome},
    telemetry::{FeedTelemetry, SpaceSyncCounts, SpaceSyncOutcome},
};

const DEFAULT_INTERVAL: Duration = Duration::from_secs(30);
const MAX_STATUS_AGE: Duration = Duration::from_secs(90);
const MAX_TARGET_CONCURRENCY: usize = 4;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdsSpacePass {
    pub boundaries: usize,
    pub membership_failures: usize,
    pub targets: usize,
    pub promoted: usize,
    pub unchanged: usize,
    pub replaced: usize,
    pub cleared: usize,
    pub deferred: usize,
    pub target_failures: usize,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PdsSpaceSyncStatus {
    last_pass: Option<PdsSpacePass>,
    last_completed: Option<Instant>,
    running: bool,
}

impl PdsSpaceSyncStatus {
    pub fn last_pass(&self) -> Option<PdsSpacePass> {
        self.last_pass
    }

    pub fn is_healthy(&self) -> bool {
        self.is_healthy_at(Instant::now())
    }

    fn is_healthy_at(&self, now: Instant) -> bool {
        self.running
            && self
                .last_completed
                .is_some_and(|completed| now.duration_since(completed) <= MAX_STATUS_AGE)
            && self.last_pass.as_ref().is_some_and(pass_is_healthy)
    }

    fn mark_running(&mut self) {
        self.running = true;
    }

    fn record(&mut self, now: Instant, pass: PdsSpacePass) {
        self.last_pass = Some(pass);
        self.last_completed = Some(now);
    }

    fn mark_stopped(&mut self) {
        self.running = false;
    }
}

/// A pass is healthy when no membership listing and no target failed. A target
/// that was deferred or retried is not a failure.
fn pass_is_healthy(pass: &PdsSpacePass) -> bool {
    pass.membership_failures == 0 && pass.target_failures == 0
}

struct SchedulerTaskGuard {
    status: Arc<Mutex<PdsSpaceSyncStatus>>,
}

impl SchedulerTaskGuard {
    fn start(status: Arc<Mutex<PdsSpaceSyncStatus>>) -> Self {
        status
            .lock()
            .expect("PDS space scheduler status poisoned")
            .mark_running();
        Self { status }
    }
}

impl Drop for SchedulerTaskGuard {
    fn drop(&mut self) {
        self.status
            .lock()
            .expect("PDS space scheduler status poisoned")
            .mark_stopped();
    }
}

/// Periodically refreshes authority-derived PDS membership and runs bounded target syncs.
pub struct PdsSpaceScheduler {
    shutdown: watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    status: Arc<Mutex<PdsSpaceSyncStatus>>,
}

impl PdsSpaceScheduler {
    pub fn start(
        lifecycle: Arc<ControlLifecycle>,
        membership: Arc<MembershipReconciler>,
        synchronizer: Arc<PdsSpaceSynchronizer>,
        boundaries: impl IntoIterator<Item = String>,
        retention: ProjectionRetention,
    ) -> Self {
        Self::start_with_telemetry(
            lifecycle,
            membership,
            synchronizer,
            boundaries,
            retention,
            Arc::new(FeedTelemetry::disabled()),
        )
    }

    pub fn start_with_telemetry(
        lifecycle: Arc<ControlLifecycle>,
        membership: Arc<MembershipReconciler>,
        synchronizer: Arc<PdsSpaceSynchronizer>,
        boundaries: impl IntoIterator<Item = String>,
        retention: ProjectionRetention,
        telemetry: Arc<FeedTelemetry>,
    ) -> Self {
        let boundaries = boundaries.into_iter().collect::<BTreeSet<_>>();
        let (shutdown, receiver) = watch::channel(false);
        let status = Arc::new(Mutex::new(PdsSpaceSyncStatus::default()));
        let task = tokio::spawn(run_forever(
            lifecycle,
            membership,
            synchronizer,
            boundaries,
            retention,
            receiver,
            Arc::clone(&status),
            telemetry,
        ));
        Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
            status,
        }
    }

    pub fn status(&self) -> Arc<Mutex<PdsSpaceSyncStatus>> {
        Arc::clone(&self.status)
    }

    pub async fn stop(&self) {
        let _ = self.shutdown.send(true);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}

#[allow(clippy::too_many_arguments)] // Runtime wiring keeps each bounded adapter explicit.
async fn run_forever(
    lifecycle: Arc<ControlLifecycle>,
    membership: Arc<MembershipReconciler>,
    synchronizer: Arc<PdsSpaceSynchronizer>,
    boundaries: BTreeSet<String>,
    retention: ProjectionRetention,
    mut shutdown: watch::Receiver<bool>,
    status: Arc<Mutex<PdsSpaceSyncStatus>>,
    telemetry: Arc<FeedTelemetry>,
) {
    let _task = SchedulerTaskGuard::start(Arc::clone(&status));
    loop {
        let started = Instant::now();
        let pass = run_pass(
            Arc::clone(&lifecycle),
            Arc::clone(&membership),
            Arc::clone(&synchronizer),
            &boundaries,
            &retention,
        );
        tokio::select! {
            completed = pass => {
                let healthy = pass_is_healthy(&completed);
                let progressed = completed.promoted
                    + completed.unchanged
                    + completed.replaced
                    + completed.cleared
                    + completed.deferred
                    != 0;
                telemetry.record_space_sync(
                    if healthy {
                        SpaceSyncOutcome::Ok
                    } else if progressed {
                        SpaceSyncOutcome::Partial
                    } else {
                        SpaceSyncOutcome::Failed
                    },
                    started.elapsed(),
                    SpaceSyncCounts {
                        promoted: completed.promoted,
                        unchanged: completed.unchanged,
                        replaced: completed.replaced,
                        cleared: completed.cleared,
                        deferred: completed.deferred,
                        failed: completed.target_failures,
                    },
                );
                status
                    .lock()
                    .expect("PDS space scheduler status poisoned")
                    .record(Instant::now(), completed);
                eprintln!(
                    "event=pds_space_sync_pass healthy={healthy} boundaries={} membership_failures={} targets={} promoted={} unchanged={} replaced={} cleared={} deferred={} target_failures={}",
                    completed.boundaries,
                    completed.membership_failures,
                    completed.targets,
                    completed.promoted,
                    completed.unchanged,
                    completed.replaced,
                    completed.cleared,
                    completed.deferred,
                    completed.target_failures,
                );
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(DEFAULT_INTERVAL) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

async fn run_pass(
    lifecycle: Arc<ControlLifecycle>,
    membership: Arc<MembershipReconciler>,
    synchronizer: Arc<PdsSpaceSynchronizer>,
    boundaries: &BTreeSet<String>,
    retention: &ProjectionRetention,
) -> PdsSpacePass {
    let (pass, reasons) =
        collect_pass(lifecycle, membership, synchronizer, boundaries, retention).await;
    if let Some(line) = reasons.log_line() {
        eprintln!("{line}");
    }
    pass
}

/// Failed targets of one cycle, counted by the reason each failed.
#[derive(Debug, Default)]
struct TargetFailureReasons(BTreeMap<&'static str, usize>);

impl TargetFailureReasons {
    fn record(&mut self, reason: FailureReason) {
        *self.0.entry(reason.as_str()).or_default() += 1;
    }

    fn log_line(&self) -> Option<String> {
        if self.0.is_empty() {
            return None;
        }
        let counts = self
            .0
            .iter()
            .map(|(reason, count)| format!("{reason}={count}"))
            .collect::<Vec<_>>()
            .join(" ");
        Some(format!("event=pds_space_target_failures {counts}"))
    }
}

async fn collect_pass(
    lifecycle: Arc<ControlLifecycle>,
    membership: Arc<MembershipReconciler>,
    synchronizer: Arc<PdsSpaceSynchronizer>,
    boundaries: &BTreeSet<String>,
    retention: &ProjectionRetention,
) -> (PdsSpacePass, TargetFailureReasons) {
    let mut reasons = TargetFailureReasons::default();
    let now = OffsetDateTime::now_utc();
    let observed_at = format_utc_millis(now);
    let Some(retained_at) = retention_deadline(now, retention) else {
        let pass = PdsSpacePass {
            boundaries: boundaries.len(),
            membership_failures: boundaries.len(),
            ..PdsSpacePass::default()
        };
        return (pass, reasons);
    };
    let mut pass = PdsSpacePass {
        boundaries: boundaries.len(),
        ..PdsSpacePass::default()
    };
    let mut workers = JoinSet::new();
    for boundary in boundaries {
        let generation = match lifecycle.pds_boundary_generation(boundary) {
            Ok(generation) => generation,
            Err(_) => {
                pass.membership_failures += 1;
                continue;
            }
        };
        let snapshot = match membership.discover(boundary).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                pass.membership_failures += 1;
                eprintln!(
                    "event=pds_space_membership_failed kind={}",
                    membership_failure_kind(&error),
                );
                continue;
            }
        };
        let generations = match lifecycle.replace_pds_space_members_at_generation(
            boundary,
            snapshot.members,
            &observed_at,
            generation,
        ) {
            Ok(generations) => generations,
            Err(_) => {
                pass.membership_failures += 1;
                eprintln!("event=pds_space_membership_failed kind=store");
                continue;
            }
        };
        for mut target in snapshot.targets {
            let Some(member_generation) = generations.get(&target.did).copied() else {
                pass.target_failures += 1;
                reasons.record(FailureReason::MemberGeneration);
                continue;
            };
            target.generation = member_generation;
            pass.targets += 1;
            if workers.len() == MAX_TARGET_CONCURRENCY {
                record_target_result(&mut pass, &mut reasons, workers.join_next().await);
            }
            let lifecycle = Arc::clone(&lifecycle);
            let synchronizer = Arc::clone(&synchronizer);
            let retained_at = retained_at.clone();
            workers.spawn(async move {
                synchronizer
                    .sync_target(&lifecycle, &target, &retained_at)
                    .await
            });
        }
    }
    while !workers.is_empty() {
        record_target_result(&mut pass, &mut reasons, workers.join_next().await);
    }
    (pass, reasons)
}

fn record_target_result(
    pass: &mut PdsSpacePass,
    reasons: &mut TargetFailureReasons,
    result: Option<Result<VerifiedSyncOutcome, tokio::task::JoinError>>,
) {
    match result {
        Some(Ok(VerifiedSyncOutcome::Promoted)) => pass.promoted += 1,
        Some(Ok(VerifiedSyncOutcome::Unchanged)) => pass.unchanged += 1,
        Some(Ok(VerifiedSyncOutcome::Replaced)) => pass.replaced += 1,
        Some(Ok(VerifiedSyncOutcome::Cleared)) => pass.cleared += 1,
        Some(Ok(VerifiedSyncOutcome::Deferred)) => pass.deferred += 1,
        // The next cycle starts again; it is neither a count nor a failure.
        Some(Ok(VerifiedSyncOutcome::Retry)) => {}
        Some(Ok(VerifiedSyncOutcome::Failed(reason))) => record_failure(pass, reasons, reason),
        Some(Err(_)) | None => record_failure(pass, reasons, FailureReason::Task),
    }
}

fn record_failure(
    pass: &mut PdsSpacePass,
    reasons: &mut TargetFailureReasons,
    reason: FailureReason,
) {
    pass.target_failures += 1;
    reasons.record(reason);
    eprintln!("{}", target_failure_line(reason));
}

fn target_failure_line(reason: FailureReason) -> String {
    format!("event=pds_space_target_failed kind={}", reason.as_str())
}

fn membership_failure_kind(error: &MembershipReconciliationError) -> &'static str {
    match error {
        MembershipReconciliationError::Credential(_) => "credential",
        MembershipReconciliationError::Membership(_) => "membership",
        MembershipReconciliationError::DuplicateMember => "duplicate_member",
        MembershipReconciliationError::CursorStalled => "cursor_stalled",
        MembershipReconciliationError::PageLimit => "page_limit",
        MembershipReconciliationError::Store(_) => "store",
    }
}

fn retention_deadline(now: OffsetDateTime, retention: &ProjectionRetention) -> Option<String> {
    let seconds = i64::try_from(retention.max_age.as_secs()).ok()?;
    now.checked_add(time::Duration::seconds(seconds))
        .map(format_utc_millis)
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
        collections::{BTreeSet, VecDeque},
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use async_trait::async_trait;
    use serde_json::{Value, json};
    use tokio::sync::oneshot;

    use crate::{
        credential_issuer::{
            CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
        },
        credential_manager::SpaceCredentialManager,
        lifecycle::ControlLifecycle,
        membership_reconciler::MembershipReconciler,
        pds_space_sync::{
            FailureReason, PdsSpaceSynchronizer, VerifiedSyncOutcome,
            test_host::{
                ArchiveStep, HostRepo, PageStep, StaticKemKeys, TestClock, TestHost, TestSource,
            },
        },
        readiness::FeedReadinessGate,
        service::ProjectionReader,
        space_http_signature::SpaceHttpSignatureKey,
        space_membership::{
            RepoCustody, SpaceMembershipClient, SpaceMembershipError, SpaceMembershipPage,
            SpaceRepoMember,
        },
        store::{EncryptedStore, PdsSpaceMember, StorageKey},
    };

    use super::{
        PdsSpacePass, PdsSpaceScheduler, PdsSpaceSyncStatus, TargetFailureReasons, collect_pass,
        pass_is_healthy, record_target_result, run_pass,
    };

    const AUTHORITY: &str = "did:web:stratos.example.test";
    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const SPACE: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop";
    const DID: &str = "did:plc:fayevalentine";
    const PDS: &str = "https://pds.example.test/";
    const POST: &str = "zone.stratos.feed.post";

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

    struct MembershipPages(Mutex<VecDeque<Result<SpaceMembershipPage, SpaceMembershipError>>>);

    struct PausedMembershipPage {
        started: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }

    #[async_trait]
    impl SpaceMembershipClient for PausedMembershipPage {
        async fn list(
            &self,
            _: &str,
            _: &crate::space_credential::HeldSpaceCredential,
            _: Option<&str>,
            _: usize,
        ) -> Result<SpaceMembershipPage, SpaceMembershipError> {
            let release = self.release.lock().unwrap().take().unwrap();
            self.started
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(())
                .unwrap();
            release.await.unwrap();
            Ok(pds_members(&[DID]))
        }
    }

    #[async_trait]
    impl SpaceMembershipClient for MembershipPages {
        async fn list(
            &self,
            _: &str,
            _: &crate::space_credential::HeldSpaceCredential,
            _: Option<&str>,
            _: usize,
        ) -> Result<SpaceMembershipPage, SpaceMembershipError> {
            self.0
                .lock()
                .expect("membership pages poisoned")
                .pop_front()
                .unwrap_or(Err(SpaceMembershipError::Unavailable))
        }
    }

    fn pds_members(dids: &[&str]) -> SpaceMembershipPage {
        SpaceMembershipPage {
            members: dids
                .iter()
                .map(|did| SpaceRepoMember {
                    did: (*did).to_owned(),
                    custody: RepoCustody::Pds,
                    host: Some(PDS.to_owned()),
                })
                .collect(),
            next_cursor: None,
        }
    }

    fn membership_listing(
        dids: &[&str],
        passes: usize,
        credentials: &Arc<SpaceCredentialManager>,
    ) -> Arc<MembershipReconciler> {
        Arc::new(MembershipReconciler::new(
            Arc::new(MembershipPages(Mutex::new(
                (0..passes).map(|_| Ok(pds_members(dids))).collect(),
            ))),
            Arc::clone(credentials),
        ))
    }

    fn fixed_now() -> u64 {
        1_000
    }

    fn lifecycle() -> Arc<ControlLifecycle> {
        Arc::new(
            ControlLifecycle::for_authority(
                ProjectionReader::new(
                    EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
                ),
                Arc::new(Mutex::new(FeedReadinessGate::default())),
                AUTHORITY,
            )
            .unwrap(),
        )
    }

    fn credentials() -> Arc<SpaceCredentialManager> {
        Arc::new(SpaceCredentialManager::with_clock(
            Arc::new(Issuer),
            fixed_now,
        ))
    }

    fn retention() -> crate::config::ProjectionRetention {
        crate::config::ProjectionRetention {
            max_age: Duration::from_secs(60),
            max_bytes: 1_024,
            space_write_reserve_bytes: 512,
        }
    }

    fn post(text: &str) -> Value {
        json!({ "$type": POST, "text": text, "createdAt": "1998-04-03T00:00:00.000Z" })
    }

    /// The in-process host of the synchronizer's tests behind the real
    /// synchronizer; it proves how a pass flows, not the cryptography.
    struct Pds {
        host: Arc<TestHost>,
        synchronizer: Arc<PdsSpaceSynchronizer>,
    }

    impl Pds {
        fn holding(dids: &[&str], credentials: &Arc<SpaceCredentialManager>) -> Self {
            let host = TestHost::serving(SPACE);
            for did in dids {
                let mut repo = HostRepo::new(1);
                repo.put(2, POST, "ein", post("Woof"));
                host.hold(did, repo);
            }
            let source = TestSource::new(StaticKemKeys::new());
            source.host_at(PDS, Arc::clone(&host));
            let synchronizer = Arc::new(PdsSpaceSynchronizer::with_clock(
                source,
                Arc::clone(credentials),
                TestClock::new(),
            ));
            Self { host, synchronizer }
        }
    }

    async fn pass_over(
        dids: &[&str],
        passes: usize,
        pds: &Pds,
        lifecycle: &Arc<ControlLifecycle>,
        credentials: &Arc<SpaceCredentialManager>,
    ) -> Vec<(PdsSpacePass, TargetFailureReasons)> {
        let membership = membership_listing(dids, passes, credentials);
        let mut results = Vec::new();
        for _ in 0..passes {
            results.push(
                collect_pass(
                    Arc::clone(lifecycle),
                    Arc::clone(&membership),
                    Arc::clone(&pds.synchronizer),
                    &[BOUNDARY.to_owned()].into_iter().collect(),
                    &retention(),
                )
                .await,
            );
        }
        results
    }

    #[test]
    fn reports_an_incomplete_or_failed_pass_as_unhealthy() {
        let mut status = PdsSpaceSyncStatus::default();
        assert!(!status.is_healthy());

        status.mark_running();
        status.record(
            Instant::now(),
            PdsSpacePass {
                target_failures: 1,
                ..PdsSpacePass::default()
            },
        );

        assert!(!status.is_healthy());
        assert_eq!(status.last_pass().unwrap().target_failures, 1);
    }

    #[test]
    fn reports_a_stale_or_stopped_scheduler_as_unhealthy() {
        let mut status = PdsSpaceSyncStatus::default();
        let started = Instant::now();
        status.mark_running();
        status.record(started, PdsSpacePass::default());
        assert!(status.is_healthy_at(started + Duration::from_secs(1)));
        assert!(!status.is_healthy_at(started + super::MAX_STATUS_AGE + Duration::from_secs(1)));

        status.mark_stopped();
        assert!(!status.is_healthy_at(started + Duration::from_secs(1)));
    }

    #[tokio::test]
    async fn refreshes_membership_before_replacing_an_authority_target() {
        let credentials = credentials();
        let pds = Pds::holding(&[DID], &credentials);
        let lifecycle = lifecycle();

        let pass = run_pass(
            Arc::clone(&lifecycle),
            membership_listing(&[DID], 1, &credentials),
            Arc::clone(&pds.synchronizer),
            &[BOUNDARY.to_owned()].into_iter().collect(),
            &retention(),
        )
        .await;

        assert_eq!(pass.replaced, 1);
        assert_eq!(pass.promoted, 0);
        assert_eq!(pass.membership_failures, 0);
        let generation = lifecycle
            .pds_member_generation(BOUNDARY, DID)
            .unwrap()
            .unwrap();
        assert!(
            lifecycle
                .verified_space_base_at_generation(BOUNDARY, SPACE, DID, generation)
                .unwrap()
                .is_some(),
            "the member's repo was read after the membership listing named it"
        );
    }

    #[tokio::test]
    async fn stale_enumeration_does_not_restore_a_revoked_member() {
        let lifecycle = lifecycle();
        lifecycle
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: DID.to_owned(),
                }],
                "2026-09-22T00:00:00.000Z",
            )
            .unwrap();
        let old_generation = lifecycle
            .pds_member_generation(BOUNDARY, DID)
            .unwrap()
            .unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let initial_credentials = credentials();
        let membership = Arc::new(MembershipReconciler::new(
            Arc::new(PausedMembershipPage {
                started: Mutex::new(Some(started_tx)),
                release: Mutex::new(Some(release_rx)),
            }),
            Arc::clone(&initial_credentials),
        ));
        let pds = Pds::holding(&[DID], &initial_credentials);
        let task_lifecycle = Arc::clone(&lifecycle);
        let synchronizer = Arc::clone(&pds.synchronizer);
        let task = tokio::spawn(async move {
            run_pass(
                task_lifecycle,
                membership,
                synchronizer,
                &[BOUNDARY.to_owned()].into_iter().collect(),
                &retention(),
            )
            .await
        });
        started_rx.await.unwrap();
        lifecycle
            .replace_pds_space_members(BOUNDARY, Vec::new(), "2026-09-22T00:01:00.000Z")
            .unwrap();
        lifecycle
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: DID.to_owned(),
                }],
                "2026-09-22T00:02:00.000Z",
            )
            .unwrap();
        let fresh_generation = lifecycle
            .pds_member_generation(BOUNDARY, DID)
            .unwrap()
            .unwrap();
        assert_ne!(fresh_generation, old_generation);
        release_tx.send(()).unwrap();
        let pass = task.await.unwrap();
        assert_eq!(pass.membership_failures, 1);
        assert_eq!(pass.targets, 0);
        assert_eq!(
            lifecycle.pds_member_generation(BOUNDARY, DID).unwrap(),
            Some(fresh_generation)
        );

        let credentials = credentials();
        let recovered = run_pass(
            Arc::clone(&lifecycle),
            membership_listing(&[DID], 1, &credentials),
            Arc::clone(&pds.synchronizer),
            &[BOUNDARY.to_owned()].into_iter().collect(),
            &retention(),
        )
        .await;
        assert_eq!(recovered.membership_failures, 0);
        assert_eq!(recovered.targets, 1);
        assert_eq!(recovered.replaced, 1);
    }

    #[tokio::test]
    async fn stop_completes_without_waiting_for_the_poll_interval() {
        let lifecycle = lifecycle();
        let credentials = credentials();
        let membership = Arc::new(MembershipReconciler::new(
            Arc::new(MembershipPages(Mutex::new(VecDeque::new()))),
            Arc::clone(&credentials),
        ));
        let pds = Pds::holding(&[], &credentials);
        let scheduler = PdsSpaceScheduler::start(
            lifecycle,
            membership,
            pds.synchronizer,
            Vec::new(),
            retention(),
        );

        tokio::time::timeout(Duration::from_millis(100), scheduler.stop())
            .await
            .expect("scheduler stop should interrupt its sleep");
    }

    const SPIKE: &str = "did:plc:spikespiegel";
    const JET: &str = "did:plc:jetblack";
    const ED: &str = "did:plc:radicaledward";
    const VICIOUS: &str = "did:plc:viciousbebop";
    const HOSTILE_NAME: &str = "Hostile\nName\u{1b}[31m";

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pass_over_every_kind_of_outcome_counts_each_and_logs_one_reason_line() {
        let members = [SPIKE, JET, FAYE_DID, ED, VICIOUS];
        let credentials = credentials();
        let pds = Pds::holding(&members, &credentials);
        let lifecycle = lifecycle();
        let membership = membership_listing(&members, 2, &credentials);
        let boundaries: BTreeSet<String> = [BOUNDARY.to_owned()].into_iter().collect();

        let (first, first_reasons) = collect_pass(
            Arc::clone(&lifecycle),
            Arc::clone(&membership),
            Arc::clone(&pds.synchronizer),
            &boundaries,
            &retention(),
        )
        .await;
        assert_eq!((first.targets, first.replaced), (5, 5));
        assert_eq!(first_reasons.log_line(), None);

        pds.host.edit(JET, |repo| {
            repo.put(3, POST, "redtail", post("Cowboy Bebop"));
        });
        pds.host.script_pages(
            FAYE_DID,
            vec![PageStep::Refused {
                status: 400,
                code: Some("RepoTakendown"),
            }],
        );
        pds.host.script_pages(
            ED,
            vec![PageStep::Refused {
                status: 400,
                code: Some("RepoNotFound"),
            }],
        );
        pds.host.script_pages(
            VICIOUS,
            vec![PageStep::Refused {
                status: 400,
                code: Some(HOSTILE_NAME),
            }],
        );
        let (second, reasons) = collect_pass(
            Arc::clone(&lifecycle),
            membership,
            Arc::clone(&pds.synchronizer),
            &boundaries,
            &retention(),
        )
        .await;

        assert_eq!(
            second,
            PdsSpacePass {
                boundaries: 1,
                membership_failures: 0,
                targets: 5,
                promoted: 1,
                unchanged: 1,
                replaced: 0,
                cleared: 0,
                deferred: 0,
                target_failures: 3,
            }
        );
        assert_eq!(
            reasons.log_line().as_deref(),
            Some("event=pds_space_target_failures other=1 repo_not_found=1 repo_takendown=1")
        );
        assert!(!pass_is_healthy(&second), "a failed target is unhealthy");
    }

    const FAYE_DID: &str = DID;

    #[test]
    fn every_outcome_lands_in_its_own_count_and_only_a_failure_is_one() {
        let counted = |outcomes: &[VerifiedSyncOutcome]| {
            let mut pass = PdsSpacePass::default();
            let mut reasons = TargetFailureReasons::default();
            for outcome in outcomes {
                record_target_result(&mut pass, &mut reasons, Some(Ok(*outcome)));
            }
            (pass, reasons.log_line())
        };

        let (pass, line) = counted(&[
            VerifiedSyncOutcome::Promoted,
            VerifiedSyncOutcome::Unchanged,
            VerifiedSyncOutcome::Unchanged,
            VerifiedSyncOutcome::Replaced,
            VerifiedSyncOutcome::Cleared,
            VerifiedSyncOutcome::Deferred,
            VerifiedSyncOutcome::Retry,
        ]);
        assert_eq!(
            pass,
            PdsSpacePass {
                promoted: 1,
                unchanged: 2,
                replaced: 1,
                cleared: 1,
                deferred: 1,
                ..PdsSpacePass::default()
            }
        );
        assert_eq!(line, None, "none of these is a failure");
        assert!(pass_is_healthy(&pass));

        let (pass, line) = counted(&[
            VerifiedSyncOutcome::Failed(FailureReason::Digest),
            VerifiedSyncOutcome::Failed(FailureReason::Digest),
            VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown),
        ]);
        assert_eq!(pass.target_failures, 3);
        assert_eq!(
            line.as_deref(),
            Some("event=pds_space_target_failures digest=2 replacement_cooldown=1")
        );
        assert!(!pass_is_healthy(&pass));
    }

    #[test]
    fn a_pass_of_unchanged_and_retried_targets_is_healthy() {
        let mut pass = PdsSpacePass::default();
        let mut reasons = TargetFailureReasons::default();
        for outcome in [
            VerifiedSyncOutcome::Unchanged,
            VerifiedSyncOutcome::Unchanged,
            VerifiedSyncOutcome::Retry,
        ] {
            pass.targets += 1;
            record_target_result(&mut pass, &mut reasons, Some(Ok(outcome)));
        }
        let mut status = PdsSpaceSyncStatus::default();
        let now = Instant::now();
        status.mark_running();
        status.record(now, pass);

        assert_eq!(
            (pass.targets, pass.unchanged, pass.target_failures),
            (3, 2, 0)
        );
        assert!(status.is_healthy_at(now));
    }

    #[test]
    fn a_pass_reports_the_new_counts_and_no_rejected_count() {
        let keys: BTreeSet<String> = serde_json::to_value(PdsSpacePass::default())
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();

        assert_eq!(
            keys,
            [
                "boundaries",
                "membershipFailures",
                "targets",
                "promoted",
                "unchanged",
                "replaced",
                "cleared",
                "deferred",
                "targetFailures",
            ]
            .map(str::to_owned)
            .into_iter()
            .collect()
        );
    }

    #[tokio::test]
    async fn a_target_task_that_did_not_join_is_a_failure_under_its_own_word() {
        let task = tokio::spawn(std::future::pending::<VerifiedSyncOutcome>());
        task.abort();
        let mut pass = PdsSpacePass::default();
        let mut reasons = TargetFailureReasons::default();

        record_target_result(&mut pass, &mut reasons, Some(task.await));
        record_target_result(&mut pass, &mut reasons, None);

        assert_eq!(pass.target_failures, 2);
        assert_eq!(
            reasons.log_line().as_deref(),
            Some("event=pds_space_target_failures task=2")
        );
    }

    #[tokio::test]
    async fn a_cycle_with_two_invalid_space_mac_refusals_and_an_unknown_name_logs_one_counted_line()
    {
        let members = [SPIKE, JET, FAYE_DID];
        let credentials = credentials();
        let pds = Pds::holding(&members, &credentials);
        for (did, code) in [
            (SPIKE, "InvalidSpaceMac"),
            (JET, "InvalidSpaceMac"),
            (FAYE_DID, HOSTILE_NAME),
        ] {
            pds.host.script_archives(
                did,
                vec![ArchiveStep::Refused {
                    status: 400,
                    code: Some(code),
                }],
            );
        }

        let (pass, reasons) = pass_over(&members, 1, &pds, &lifecycle(), &credentials)
            .await
            .remove(0);

        assert_eq!(pass.targets, 3);
        assert_eq!(pass.target_failures, 3);
        assert_eq!(pass.replaced, 0);
        assert_eq!(
            reasons.log_line().as_deref(),
            Some("event=pds_space_target_failures invalid_space_mac=2 other=1")
        );
    }

    #[test]
    fn a_failed_targets_line_holds_its_fixed_word_and_nothing_a_host_sent() {
        let line = super::target_failure_line(FailureReason::RepoSuspended);
        assert_eq!(line, "event=pds_space_target_failed kind=repo_suspended");
        let other = super::target_failure_line(FailureReason::Other);
        assert_eq!(other, "event=pds_space_target_failed kind=other");
    }

    #[tokio::test]
    async fn a_cycle_without_failed_targets_logs_no_failure_line() {
        let credentials = credentials();
        let pds = Pds::holding(&[], &credentials);
        let (pass, reasons) = collect_pass(
            lifecycle(),
            membership_listing(&[], 1, &credentials),
            Arc::clone(&pds.synchronizer),
            &BTreeSet::new(),
            &retention(),
        )
        .await;
        assert_eq!(pass.target_failures, 0);
        assert_eq!(reasons.log_line(), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pass_where_every_target_needs_its_first_replacement_completes_them_all_one_archive_at_a_time()
     {
        let members: Vec<String> = (0..9)
            .map(|index| format!("did:plc:spacecowboy{index}"))
            .collect();
        let member_refs: Vec<&str> = members.iter().map(String::as_str).collect();
        let credentials = credentials();
        let pds = Pds::holding(&member_refs, &credentials);
        let lifecycle = lifecycle();

        let started = Instant::now();
        let (pass, reasons) = pass_over(&member_refs, 1, &pds, &lifecycle, &credentials)
            .await
            .remove(0);

        assert_eq!(pass.targets, 9);
        assert_eq!(pass.replaced, 9);
        assert_eq!(pass.target_failures, 0);
        assert_eq!(reasons.log_line(), None, "no target ran out of time");
        assert!(started.elapsed() < crate::config::SPACE_TARGET_DEADLINE);
        assert_eq!(pds.host.archives_requested(), 9);
        assert_eq!(pds.host.most_archives_in_flight(), 1);
        for did in &members {
            let generation = lifecycle
                .pds_member_generation(BOUNDARY, did)
                .unwrap()
                .unwrap();
            assert!(
                lifecycle
                    .verified_space_base_at_generation(BOUNDARY, SPACE, did, generation)
                    .unwrap()
                    .is_some(),
                "{did} has a verified base"
            );
        }
    }
}
