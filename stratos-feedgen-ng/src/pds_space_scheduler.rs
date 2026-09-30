use std::{
    collections::BTreeSet,
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
    pds_space_sync::{PdsSpaceSyncError, PdsSpaceSyncOutcome, PdsSpaceSynchronizer},
    telemetry::{FeedTelemetry, SpaceSyncOutcome},
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
    pub deferred: usize,
    pub rejected: usize,
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
            && self
                .last_pass
                .is_some_and(|pass| pass.membership_failures == 0 && pass.target_failures == 0)
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
                let healthy = completed.membership_failures == 0 && completed.target_failures == 0;
                telemetry.record_space_sync(
                    if healthy {
                        SpaceSyncOutcome::Ok
                    } else if completed.promoted != 0 || completed.deferred != 0 || completed.rejected != 0 {
                        SpaceSyncOutcome::Partial
                    } else {
                        SpaceSyncOutcome::Failed
                    },
                    started.elapsed(),
                    completed.promoted,
                    completed.target_failures,
                    completed.deferred,
                    completed.rejected,
                );
                status
                    .lock()
                    .expect("PDS space scheduler status poisoned")
                    .record(Instant::now(), completed);
                eprintln!(
                    "event=pds_space_sync_pass healthy={healthy} boundaries={} membership_failures={} targets={} promoted={} deferred={} rejected={} target_failures={}",
                    completed.boundaries,
                    completed.membership_failures,
                    completed.targets,
                    completed.promoted,
                    completed.deferred,
                    completed.rejected,
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
    let now = OffsetDateTime::now_utc();
    let observed_at = format_utc_millis(now);
    let Some(retained_at) = retention_deadline(now, retention) else {
        return PdsSpacePass {
            boundaries: boundaries.len(),
            membership_failures: boundaries.len(),
            ..PdsSpacePass::default()
        };
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
                continue;
            };
            target.generation = member_generation;
            pass.targets += 1;
            if workers.len() == MAX_TARGET_CONCURRENCY {
                record_target_result(&mut pass, workers.join_next().await);
            }
            let lifecycle = Arc::clone(&lifecycle);
            let synchronizer = Arc::clone(&synchronizer);
            let observed_at = observed_at.clone();
            let retained_at = retained_at.clone();
            workers.spawn(async move {
                synchronizer
                    .sync_target(&lifecycle, &target, &observed_at, &retained_at)
                    .await
            });
        }
    }
    while !workers.is_empty() {
        record_target_result(&mut pass, workers.join_next().await);
    }
    pass
}

fn record_target_result(
    pass: &mut PdsSpacePass,
    result: Option<
        Result<
            Result<PdsSpaceSyncOutcome, crate::pds_space_sync::PdsSpaceSyncError>,
            tokio::task::JoinError,
        >,
    >,
) {
    match result {
        Some(Ok(Ok(PdsSpaceSyncOutcome::Promoted))) => pass.promoted += 1,
        Some(Ok(Ok(PdsSpaceSyncOutcome::DeferredKeyResolution))) => pass.deferred += 1,
        Some(Ok(Ok(PdsSpaceSyncOutcome::RejectedCommit))) => pass.rejected += 1,
        Some(Ok(Err(error))) => {
            pass.target_failures += 1;
            eprintln!(
                "event=pds_space_target_failed kind={}",
                target_failure_kind(&error)
            );
        }
        Some(Err(_)) | None => {
            pass.target_failures += 1;
            eprintln!("event=pds_space_target_failed kind=task");
        }
    }
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

fn target_failure_kind(error: &PdsSpaceSyncError) -> &'static str {
    match error {
        PdsSpaceSyncError::Credential(_) => "credential",
        PdsSpaceSyncError::Host(_) => "host",
        PdsSpaceSyncError::Target(_) => "target",
        PdsSpaceSyncError::Stage(_) => "stage",
        PdsSpaceSyncError::Store(_) => "store",
        PdsSpaceSyncError::PageLimit => "page_limit",
        PdsSpaceSyncError::OperationLimit => "operation_limit",
        PdsSpaceSyncError::CursorStalled => "cursor_stalled",
        PdsSpaceSyncError::TargetCapacity => "target_capacity",
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
        collections::VecDeque,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    use async_trait::async_trait;
    use tokio::sync::oneshot;

    use crate::{
        credential_issuer::{
            CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
        },
        credential_manager::SpaceCredentialManager,
        lifecycle::ControlLifecycle,
        membership_reconciler::MembershipReconciler,
        pds_space_sync::{
            PdsSpaceSynchronizer, SpaceCommitVerificationPort, SpacePageReader, SpacePageSource,
        },
        readiness::FeedReadinessGate,
        service::ProjectionReader,
        space_commit::CommitVerification,
        space_credential::DpopKey,
        space_host::{SpaceHostError, SpaceHostPage},
        space_membership::{
            RepoCustody, SpaceMembershipClient, SpaceMembershipError, SpaceMembershipPage,
            SpaceRepoMember,
        },
        space_sync::SpacePage,
        store::{EncryptedStore, StorageKey},
    };

    use super::{PdsSpacePass, PdsSpaceScheduler, PdsSpaceSyncStatus, run_pass};

    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const DID: &str = "did:plc:fayevalentine";

    struct Issuer;

    #[async_trait]
    impl SpaceCredentialIssuer for Issuer {
        async fn mint(
            &self,
            _: &str,
            _: &DpopKey,
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
            Ok(SpaceMembershipPage {
                members: vec![SpaceRepoMember {
                    did: DID.to_owned(),
                    custody: RepoCustody::Pds,
                    host: Some("https://pds.example.test/".to_owned()),
                }],
                next_cursor: None,
            })
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

    struct EmptyPages;

    #[async_trait]
    impl SpacePageReader for EmptyPages {
        async fn list_page(
            &self,
            _: &crate::membership_reconciler::PdsPollTarget,
            _: Option<&str>,
            _: usize,
        ) -> Result<SpaceHostPage, SpaceHostError> {
            Ok(SpaceHostPage {
                page: SpacePage {
                    ops: Vec::new(),
                    next_cursor: None,
                },
                commit: None,
            })
        }
    }

    #[async_trait]
    impl SpacePageSource for EmptyPages {
        async fn connect(
            &self,
            _: &crate::membership_reconciler::PdsPollTarget,
            _: Arc<crate::space_credential::HeldSpaceCredential>,
        ) -> Result<Arc<dyn SpacePageReader>, SpaceHostError> {
            Ok(Arc::new(Self))
        }
    }

    struct VerifiedCommit;

    #[async_trait]
    impl SpaceCommitVerificationPort for VerifiedCommit {
        async fn verify(
            &self,
            _: &str,
            _: &str,
            _: Option<&serde_json::Value>,
        ) -> CommitVerification {
            CommitVerification::Verified
        }
    }

    fn fixed_now() -> u64 {
        1_000
    }

    fn lifecycle() -> Arc<ControlLifecycle> {
        Arc::new(ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
        ))
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
        }
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
    async fn refreshes_membership_before_promoting_an_authority_target() {
        let initial_credentials = credentials();
        let membership = Arc::new(MembershipReconciler::new(
            Arc::new(MembershipPages(Mutex::new(
                [Ok(SpaceMembershipPage {
                    members: vec![SpaceRepoMember {
                        did: DID.to_owned(),
                        custody: RepoCustody::Pds,
                        host: Some("https://pds.example.test/".to_owned()),
                    }],
                    next_cursor: None,
                })]
                .into(),
            ))),
            Arc::clone(&initial_credentials),
        ));
        let synchronizer = Arc::new(PdsSpaceSynchronizer::new(
            Arc::new(EmptyPages),
            initial_credentials,
            Arc::new(VerifiedCommit),
        ));
        let lifecycle = lifecycle();

        let pass = run_pass(
            Arc::clone(&lifecycle),
            membership,
            synchronizer,
            &[BOUNDARY.to_owned()].into_iter().collect(),
            &retention(),
        )
        .await;

        assert_eq!(pass.promoted, 1);
        assert_eq!(pass.membership_failures, 0);
        assert_eq!(
            lifecycle.pds_space_cursor(BOUNDARY, SPACE, DID).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn stale_enumeration_does_not_restore_a_revoked_member() {
        let lifecycle = lifecycle();
        lifecycle
            .replace_pds_space_members(
                BOUNDARY,
                vec![crate::store::PdsSpaceMember {
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
        let synchronizer = Arc::new(PdsSpaceSynchronizer::new(
            Arc::new(EmptyPages),
            initial_credentials,
            Arc::new(VerifiedCommit),
        ));
        let task_lifecycle = Arc::clone(&lifecycle);
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
                vec![crate::store::PdsSpaceMember {
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
        let membership = Arc::new(MembershipReconciler::new(
            Arc::new(MembershipPages(Mutex::new(
                [Ok(SpaceMembershipPage {
                    members: vec![SpaceRepoMember {
                        did: DID.to_owned(),
                        custody: RepoCustody::Pds,
                        host: Some("https://pds.example.test/".to_owned()),
                    }],
                    next_cursor: None,
                })]
                .into(),
            ))),
            Arc::clone(&credentials),
        ));
        let synchronizer = Arc::new(PdsSpaceSynchronizer::new(
            Arc::new(EmptyPages),
            credentials,
            Arc::new(VerifiedCommit),
        ));
        let recovered = run_pass(
            Arc::clone(&lifecycle),
            membership,
            synchronizer,
            &[BOUNDARY.to_owned()].into_iter().collect(),
            &retention(),
        )
        .await;
        assert_eq!(recovered.membership_failures, 0);
        assert_eq!(recovered.targets, 1);
        assert_eq!(recovered.promoted, 1);
    }

    #[tokio::test]
    async fn stop_completes_without_waiting_for_the_poll_interval() {
        let lifecycle = lifecycle();
        let credentials = credentials();
        let membership = Arc::new(MembershipReconciler::new(
            Arc::new(MembershipPages(Mutex::new(VecDeque::new()))),
            Arc::clone(&credentials),
        ));
        let synchronizer = Arc::new(PdsSpaceSynchronizer::new(
            Arc::new(EmptyPages),
            credentials,
            Arc::new(VerifiedCommit),
        ));
        let scheduler =
            PdsSpaceScheduler::start(lifecycle, membership, synchronizer, Vec::new(), retention());

        tokio::time::timeout(Duration::from_millis(100), scheduler.stop())
            .await
            .expect("scheduler stop should interrupt its sleep");
    }
}
