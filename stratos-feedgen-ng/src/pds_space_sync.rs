use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use async_trait::async_trait;

use crate::{
    credential_manager::{CredentialManagerError, SpaceCredentialManager},
    lifecycle::ControlLifecycle,
    membership_reconciler::PdsPollTarget,
    space_commit::{CommitVerification, SpaceCommitVerifier},
    space_credential::HeldSpaceCredential,
    space_host::{PinnedSpaceHostClient, SpaceCredentialProof, SpaceHostError, SpaceHostPage},
    space_sync::{MAX_SPACE_PAGE_OPS, SpaceSyncError, prepare_space_page},
    store::StoreError,
};

const MAX_SYNC_PAGES: usize = 1_000;
const MAX_SYNC_OPS: usize = 1_000;
const MAX_TARGET_LOCKS: usize = 4_096;

#[async_trait]
pub trait SpacePageReader: Send + Sync {
    async fn list_page(
        &self,
        target: &PdsPollTarget,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SpaceHostPage, SpaceHostError>;
}

#[async_trait]
pub trait SpacePageSource: Send + Sync {
    async fn connect(
        &self,
        target: &PdsPollTarget,
        credential: Arc<HeldSpaceCredential>,
    ) -> Result<Arc<dyn SpacePageReader>, SpaceHostError>;
}

pub struct PinnedSpacePageSource;

#[async_trait]
impl SpacePageSource for PinnedSpacePageSource {
    async fn connect(
        &self,
        target: &PdsPollTarget,
        credential: Arc<HeldSpaceCredential>,
    ) -> Result<Arc<dyn SpacePageReader>, SpaceHostError> {
        let proof: Arc<dyn SpaceCredentialProof> = credential;
        PinnedSpaceHostClient::connect(&target.host, proof)
            .await
            .map(|client| Arc::new(client) as Arc<dyn SpacePageReader>)
    }
}

#[async_trait]
impl SpacePageReader for PinnedSpaceHostClient {
    async fn list_page(
        &self,
        target: &PdsPollTarget,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SpaceHostPage, SpaceHostError> {
        self.list_repo_ops(&target.space_uri, &target.did, cursor, limit)
            .await
    }
}

#[async_trait]
pub trait SpaceCommitVerificationPort: Send + Sync {
    async fn verify(
        &self,
        space_uri: &str,
        author_did: &str,
        commit: Option<&serde_json::Value>,
    ) -> CommitVerification;
}

#[async_trait]
impl SpaceCommitVerificationPort for SpaceCommitVerifier {
    async fn verify(
        &self,
        space_uri: &str,
        author_did: &str,
        commit: Option<&serde_json::Value>,
    ) -> CommitVerification {
        Self::verify(self, space_uri, author_did, commit).await
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PdsSpaceSyncOutcome {
    Promoted,
    DeferredKeyResolution,
    RejectedCommit,
}

#[derive(Debug)]
pub enum PdsSpaceSyncError {
    Credential(CredentialManagerError),
    Host(SpaceHostError),
    Target(SpaceSyncError),
    Stage(SpaceSyncError),
    Store(StoreError),
    PageLimit,
    OperationLimit,
    CursorStalled,
    TargetCapacity,
}

impl std::fmt::Display for PdsSpaceSyncError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PDS space synchronization failed")
    }
}

impl std::error::Error for PdsSpaceSyncError {}

pub struct PdsSpaceSynchronizer {
    pages: Arc<dyn SpacePageSource>,
    credentials: Arc<SpaceCredentialManager>,
    commits: Arc<dyn SpaceCommitVerificationPort>,
    target_locks: Arc<Mutex<BTreeMap<String, Arc<TargetLock>>>>,
}

struct TargetLock {
    mutex: Arc<tokio::sync::Mutex<()>>,
    users: AtomicUsize,
}

struct TargetLease {
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
    key: String,
    lock: Arc<TargetLock>,
    locks: Arc<Mutex<BTreeMap<String, Arc<TargetLock>>>>,
}

impl Drop for TargetLease {
    fn drop(&mut self) {
        self.guard.take();
        if self.lock.users.fetch_sub(1, Ordering::AcqRel) != 1 {
            return;
        }
        let mut locks = self.locks.lock().expect("PDS target locks poisoned");
        if self.lock.users.load(Ordering::Acquire) == 0
            && locks
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.lock))
        {
            locks.remove(&self.key);
        }
    }
}

impl PdsSpaceSynchronizer {
    pub fn new(
        pages: Arc<dyn SpacePageSource>,
        credentials: Arc<SpaceCredentialManager>,
        commits: Arc<dyn SpaceCommitVerificationPort>,
    ) -> Self {
        Self {
            pages,
            credentials,
            commits,
            target_locks: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    /// Fetches bounded pages without holding the lifecycle's encrypted-store lock.
    pub async fn sync_target(
        &self,
        lifecycle: &ControlLifecycle,
        target: &PdsPollTarget,
        observed_at: &str,
        retained_at: &str,
    ) -> Result<PdsSpaceSyncOutcome, PdsSpaceSyncError> {
        let _lease = self.lock_target(target).await?;
        let credential = self
            .credentials
            .get(&target.boundary)
            .await
            .map_err(PdsSpaceSyncError::Credential)?;
        let reader = self
            .pages
            .connect(target, Arc::clone(&credential))
            .await
            .map_err(PdsSpaceSyncError::Host)?;
        let mut cursor = lifecycle
            .pds_space_cursor(&target.boundary, &target.space_uri, &target.did)
            .map_err(PdsSpaceSyncError::Store)?;
        let mut seen_cursors = cursor.iter().cloned().collect::<BTreeSet<_>>();
        let mut staged_ops = 0_usize;
        for _ in 0..MAX_SYNC_PAGES {
            let response = reader
                .list_page(target, cursor.as_deref(), MAX_SPACE_PAGE_OPS)
                .await
                .map_err(PdsSpaceSyncError::Host)?;
            staged_ops = staged_ops.saturating_add(response.page.ops.len());
            if staged_ops > MAX_SYNC_OPS {
                return Err(PdsSpaceSyncError::OperationLimit);
            }
            let terminal = response.page.next_cursor.is_none();
            let next_cursor = response.page.next_cursor.clone();
            if let Some(next_cursor) = &next_cursor
                && !seen_cursors.insert(next_cursor.clone())
            {
                return Err(PdsSpaceSyncError::CursorStalled);
            }
            let commit = response.commit;
            let prepared = lifecycle
                .pds_space_target_at_generation(
                    target.space_uri.clone(),
                    target.boundary.clone(),
                    target.did.clone(),
                    target.generation,
                )
                .map_err(PdsSpaceSyncError::Target)
                .and_then(|target| {
                    prepare_space_page(target, response.page, observed_at)
                        .map_err(PdsSpaceSyncError::Stage)
                })?;
            if let Err(error) = lifecycle.stage_pds_space_page(prepared) {
                if matches!(
                    error,
                    SpaceSyncError::Store(
                        StoreError::SpaceStageLimit | StoreError::ExpiredSpaceStage
                    )
                ) {
                    lifecycle
                        .discard_pds_space_stage(&target.boundary, &target.space_uri, &target.did)
                        .map_err(PdsSpaceSyncError::Store)?;
                    if matches!(error, SpaceSyncError::Store(StoreError::ExpiredSpaceStage)) {
                        eprintln!("event=space_stage_expired rejected_targets=1");
                    } else {
                        eprintln!("event=space_stage_limit rejected_targets=1");
                    }
                }
                return Err(PdsSpaceSyncError::Stage(error));
            }
            if !terminal {
                cursor = next_cursor;
                continue;
            }
            let verification = self
                .commits
                .verify(
                    &target.space_uri,
                    &target.did,
                    commit.as_ref().map(|commit| commit.as_value()),
                )
                .await;
            return match verification {
                CommitVerification::Verified => {
                    if let Err(error) = lifecycle.promote_pds_space_stage_at_generation(
                        &target.boundary,
                        &target.space_uri,
                        &target.did,
                        retained_at,
                        target.generation,
                    ) {
                        if matches!(
                            error,
                            StoreError::SpaceStageLimit | StoreError::ExpiredSpaceStage
                        ) {
                            lifecycle
                                .discard_pds_space_stage(
                                    &target.boundary,
                                    &target.space_uri,
                                    &target.did,
                                )
                                .map_err(PdsSpaceSyncError::Store)?;
                            eprintln!("event=space_stage_promotion_limit rejected_targets=1");
                        }
                        return Err(PdsSpaceSyncError::Store(error));
                    }
                    Ok(PdsSpaceSyncOutcome::Promoted)
                }
                CommitVerification::DeferredKeyResolution => {
                    Ok(PdsSpaceSyncOutcome::DeferredKeyResolution)
                }
                CommitVerification::Rejected(failure) => {
                    eprintln!("event=pds_space_commit_rejected reason={failure:?}");
                    lifecycle
                        .discard_pds_space_stage(&target.boundary, &target.space_uri, &target.did)
                        .map_err(PdsSpaceSyncError::Store)?;
                    Ok(PdsSpaceSyncOutcome::RejectedCommit)
                }
            };
        }
        Err(PdsSpaceSyncError::PageLimit)
    }

    async fn lock_target(&self, target: &PdsPollTarget) -> Result<TargetLease, PdsSpaceSyncError> {
        let key = format!("{}\0{}\0{}", target.boundary, target.space_uri, target.did);
        let lock = {
            let mut locks = self.target_locks.lock().expect("PDS target locks poisoned");
            if let Some(lock) = locks.get(&key) {
                lock.users.fetch_add(1, Ordering::AcqRel);
                Arc::clone(lock)
            } else {
                if locks.len() == MAX_TARGET_LOCKS {
                    return Err(PdsSpaceSyncError::TargetCapacity);
                }
                let lock = Arc::new(TargetLock {
                    mutex: Arc::new(tokio::sync::Mutex::new(())),
                    users: AtomicUsize::new(1),
                });
                locks.insert(key.clone(), Arc::clone(&lock));
                lock
            }
        };
        let mut lease = TargetLease {
            guard: None,
            key,
            lock,
            locks: Arc::clone(&self.target_locks),
        };
        lease.guard = Some(Arc::clone(&lease.lock.mutex).lock_owned().await);
        Ok(lease)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::oneshot;

    use crate::{
        credential_issuer::{
            CredentialExpiry, CredentialMintError, IssuedSpaceCredential, SpaceCredentialIssuer,
        },
        lifecycle::ControlLifecycle,
        membership_reconciler::PdsPollTarget,
        readiness::FeedReadinessGate,
        service::ProjectionReader,
        space_commit::CommitVerification,
        space_credential::DpopKey,
        space_host::{SpaceHostError, SpaceHostPage},
        space_sync::{POST_COLLECTION, SpacePage, SpaceRepoOp},
        store::{EncryptedStore, PdsSpaceMember, StorageKey},
    };

    use super::{
        PdsSpaceSyncError, PdsSpaceSyncOutcome, PdsSpaceSynchronizer, SpaceCommitVerificationPort,
        SpacePageReader, SpacePageSource,
    };

    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const DID: &str = "did:plc:fayevalentine";
    const NOW: &str = "2026-09-22T00:00:00.000Z";

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

    struct Pages(Arc<Mutex<VecDeque<SpaceHostPage>>>);

    #[async_trait]
    impl SpacePageReader for Pages {
        async fn list_page(
            &self,
            _: &PdsPollTarget,
            _: Option<&str>,
            _: usize,
        ) -> Result<SpaceHostPage, SpaceHostError> {
            self.0
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(SpaceHostError::Unreachable)
        }
    }

    #[async_trait]
    impl SpacePageSource for Pages {
        async fn connect(
            &self,
            _: &PdsPollTarget,
            _: Arc<crate::space_credential::HeldSpaceCredential>,
        ) -> Result<Arc<dyn SpacePageReader>, SpaceHostError> {
            Ok(Arc::new(Self(Arc::clone(&self.0))))
        }
    }

    struct Decision(CommitVerification);

    #[async_trait]
    impl SpaceCommitVerificationPort for Decision {
        async fn verify(
            &self,
            _: &str,
            _: &str,
            _: Option<&serde_json::Value>,
        ) -> CommitVerification {
            self.0.clone()
        }
    }

    #[derive(Clone)]
    struct PausedPages(Arc<PausedPageState>);

    struct PausedPageState {
        page: Mutex<Option<SpaceHostPage>>,
        started: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }

    #[async_trait]
    impl SpacePageSource for PausedPages {
        async fn connect(
            &self,
            _: &PdsPollTarget,
            _: Arc<crate::space_credential::HeldSpaceCredential>,
        ) -> Result<Arc<dyn SpacePageReader>, SpaceHostError> {
            Ok(Arc::new(self.clone()))
        }
    }

    #[async_trait]
    impl SpacePageReader for PausedPages {
        async fn list_page(
            &self,
            _: &PdsPollTarget,
            _: Option<&str>,
            _: usize,
        ) -> Result<SpaceHostPage, SpaceHostError> {
            let release = self
                .0
                .release
                .lock()
                .unwrap()
                .take()
                .ok_or(SpaceHostError::Unreachable)?;
            if let Some(started) = self.0.started.lock().unwrap().take() {
                let _ = started.send(());
            }
            release.await.map_err(|_| SpaceHostError::Unreachable)?;
            self.0
                .page
                .lock()
                .unwrap()
                .take()
                .ok_or(SpaceHostError::Unreachable)
        }
    }

    struct PausedDecision {
        started: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }

    #[async_trait]
    impl SpaceCommitVerificationPort for PausedDecision {
        async fn verify(
            &self,
            _: &str,
            _: &str,
            _: Option<&serde_json::Value>,
        ) -> CommitVerification {
            let release = self.release.lock().unwrap().take().unwrap();
            if let Some(started) = self.started.lock().unwrap().take() {
                let _ = started.send(());
            }
            let _ = release.await;
            CommitVerification::Verified
        }
    }

    fn fixed_now() -> u64 {
        1_000
    }

    fn target() -> PdsPollTarget {
        PdsPollTarget {
            space_uri: SPACE.to_owned(),
            boundary: BOUNDARY.to_owned(),
            did: DID.to_owned(),
            host: "https://pds.example.test/".to_owned(),
            generation: 0,
        }
    }

    fn page(cursor: Option<&str>) -> SpaceHostPage {
        SpaceHostPage {
            page: SpacePage {
                ops: vec![SpaceRepoOp {
                    collection: POST_COLLECTION.to_owned(),
                    rkey: "see-you".to_owned(),
                    cid: Some(
                        "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                    ),
                    value: Some(json!({ "$type": POST_COLLECTION, "createdAt": NOW })),
                }],
                next_cursor: cursor.map(str::to_owned),
            },
            commit: None,
        }
    }

    fn page_with_ops(cursor: Option<&str>, count: usize) -> SpaceHostPage {
        let mut page = page(cursor);
        page.page.ops = (0..count)
            .map(|index| SpaceRepoOp {
                collection: POST_COLLECTION.to_owned(),
                rkey: format!("post-{index}"),
                cid: Some("bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()),
                value: Some(json!({ "$type": POST_COLLECTION, "createdAt": NOW })),
            })
            .collect();
        page
    }

    fn lifecycle() -> ControlLifecycle {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: DID.to_owned(),
                }],
                NOW,
            )
            .unwrap();
        ControlLifecycle::new(
            ProjectionReader::new(store),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
        )
    }

    fn synchronizer(
        pages: Vec<SpaceHostPage>,
        decision: CommitVerification,
    ) -> PdsSpaceSynchronizer {
        synchronizer_with(
            Arc::new(Pages(Arc::new(Mutex::new(pages.into())))),
            Arc::new(Decision(decision)),
        )
    }

    fn synchronizer_with(
        pages: Arc<dyn SpacePageSource>,
        commits: Arc<dyn SpaceCommitVerificationPort>,
    ) -> PdsSpaceSynchronizer {
        PdsSpaceSynchronizer::new(
            pages,
            Arc::new(
                crate::credential_manager::SpaceCredentialManager::with_clock(
                    Arc::new(Issuer),
                    fixed_now,
                ),
            ),
            commits,
        )
    }

    fn revoke_and_readd(lifecycle: &ControlLifecycle) {
        lifecycle
            .replace_pds_space_members(BOUNDARY, Vec::new(), NOW)
            .unwrap();
        lifecycle
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: DID.to_owned(),
                }],
                NOW,
            )
            .unwrap();
    }

    #[tokio::test]
    async fn late_page_cannot_stage_after_remove_and_readd() {
        let lifecycle = Arc::new(lifecycle());
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let pages = PausedPages(Arc::new(PausedPageState {
            page: Mutex::new(Some(page(None))),
            started: Mutex::new(Some(started_tx)),
            release: Mutex::new(Some(release_rx)),
        }));
        let sync = synchronizer_with(
            Arc::new(pages),
            Arc::new(Decision(CommitVerification::Verified)),
        );
        let lifecycle_task = Arc::clone(&lifecycle);
        let task =
            tokio::spawn(
                async move { sync.sync_target(&lifecycle_task, &target(), NOW, NOW).await },
            );
        started_rx.await.unwrap();
        revoke_and_readd(&lifecycle);
        release_tx.send(()).unwrap();
        assert!(matches!(
            task.await.unwrap(),
            Err(PdsSpaceSyncError::Target(_))
        ));
        assert_eq!(
            lifecycle.pds_space_cursor(BOUNDARY, SPACE, DID).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn late_terminal_verification_cannot_promote_after_remove_and_readd() {
        let lifecycle = Arc::new(lifecycle());
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let decision = PausedDecision {
            started: Mutex::new(Some(started_tx)),
            release: Mutex::new(Some(release_rx)),
        };
        let sync = synchronizer_with(
            Arc::new(Pages(Arc::new(Mutex::new(vec![page(None)].into())))),
            Arc::new(decision),
        );
        let lifecycle_task = Arc::clone(&lifecycle);
        let task =
            tokio::spawn(
                async move { sync.sync_target(&lifecycle_task, &target(), NOW, NOW).await },
            );
        started_rx.await.unwrap();
        revoke_and_readd(&lifecycle);
        release_tx.send(()).unwrap();
        assert!(matches!(
            task.await.unwrap(),
            Err(PdsSpaceSyncError::Store(
                crate::store::StoreError::UnauthorizedSpaceMember
            ))
        ));
        assert_eq!(
            lifecycle.pds_space_cursor(BOUNDARY, SPACE, DID).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn promotes_only_after_a_verified_terminal_page() {
        let lifecycle = lifecycle();
        let synchronizer = synchronizer(
            vec![page(Some("next")), page(None)],
            CommitVerification::Verified,
        );
        let result = synchronizer
            .sync_target(&lifecycle, &target(), NOW, "2026-09-23T00:00:00.000Z")
            .await
            .unwrap();

        assert_eq!(result, PdsSpaceSyncOutcome::Promoted);
        assert_eq!(
            lifecycle.pds_space_cursor(BOUNDARY, SPACE, DID).unwrap(),
            Some("next".to_owned())
        );
        assert!(synchronizer.target_locks.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn releases_a_target_reservation_when_a_waiting_task_is_aborted() {
        let synchronizer = Arc::new(synchronizer(Vec::new(), CommitVerification::Verified));
        let first = synchronizer.lock_target(&target()).await.unwrap();
        let waiting = {
            let synchronizer = Arc::clone(&synchronizer);
            tokio::spawn(async move { synchronizer.lock_target(&target()).await })
        };
        let key = format!("{}\0{}\0{}", BOUNDARY, SPACE, DID);
        let mut reserved = false;
        for _ in 0..10 {
            if synchronizer
                .target_locks
                .lock()
                .unwrap()
                .get(&key)
                .is_some_and(|lock| lock.users.load(std::sync::atomic::Ordering::Acquire) == 2)
            {
                reserved = true;
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(reserved);
        waiting.abort();
        let _ = waiting.await;
        drop(first);

        assert!(synchronizer.target_locks.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn discards_unverified_pages_after_a_rejected_terminal_commit() {
        let lifecycle = lifecycle();
        let result = synchronizer(
            vec![page(Some("next")), page(None)],
            CommitVerification::Rejected(
                crate::space_commit::CommitVerificationFailure::MacMismatch,
            ),
        )
        .sync_target(&lifecycle, &target(), NOW, "2026-09-23T00:00:00.000Z")
        .await
        .unwrap();

        assert_eq!(result, PdsSpaceSyncOutcome::RejectedCommit);
        assert_eq!(
            lifecycle.pds_space_cursor(BOUNDARY, SPACE, DID).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn preserves_staged_pages_when_identity_resolution_is_transient() {
        let lifecycle = lifecycle();
        let result = synchronizer(
            vec![page(Some("next")), page(None)],
            CommitVerification::DeferredKeyResolution,
        )
        .sync_target(&lifecycle, &target(), NOW, "2026-09-23T00:00:00.000Z")
        .await
        .unwrap();

        assert_eq!(result, PdsSpaceSyncOutcome::DeferredKeyResolution);
        assert_eq!(
            lifecycle.pds_space_cursor(BOUNDARY, SPACE, DID).unwrap(),
            Some("next".to_owned())
        );
    }

    #[tokio::test]
    async fn rejects_a_repeated_untrusted_cursor_before_staging_it() {
        let lifecycle = lifecycle();
        let error = synchronizer(
            vec![page(Some("loop")), page(Some("loop"))],
            CommitVerification::Verified,
        )
        .sync_target(&lifecycle, &target(), NOW, "2026-09-23T00:00:00.000Z")
        .await
        .unwrap_err();

        assert!(matches!(error, PdsSpaceSyncError::CursorStalled));
    }

    #[tokio::test]
    async fn bounds_total_operations_before_staging_an_excessive_pass() {
        let lifecycle = lifecycle();
        let error = synchronizer(
            vec![page_with_ops(Some("next"), super::MAX_SYNC_OPS), page(None)],
            CommitVerification::Verified,
        )
        .sync_target(&lifecycle, &target(), NOW, "2026-09-23T00:00:00.000Z")
        .await
        .unwrap_err();

        assert!(matches!(error, PdsSpaceSyncError::OperationLimit));
    }
}
