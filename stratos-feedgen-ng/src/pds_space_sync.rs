//! Synchronizer for one PDS-custody member's repo in one space under the
//! authenticated contract: pages and archives come back with a commit whose
//! MAC was verified, and nothing is promoted until the digest of the state the
//! ops (or the archive's records) produce equals that commit's `data`. A poll's
//! ops live in memory until the one store call.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use tokio::{sync::Semaphore, time::Instant};

use crate::{
    config::{
        MAX_SPACE_CYCLE_VALUES, MAX_SPACE_POLL_BODY_BYTES, SPACE_REPLACEMENT_COOLDOWN,
        SPACE_REPO_NOT_FOUND_CONFIRMATION, SPACE_REPO_NOT_FOUND_MAX_GAP, SPACE_TARGET_DEADLINE,
    },
    credential_manager::SpaceCredentialManager,
    lifecycle::ControlLifecycle,
    membership_reconciler::PdsPollTarget,
    space_archive::ArchiveRefusal,
    space_credential::HeldSpaceCredential,
    space_host::{
        AuthenticatedArchive, AuthenticatedPage, AuthenticatedReadError, PinnedSpaceHostClient,
        SpaceCredentialProof, SpaceHostError,
    },
    space_identity::AuthorKemKeyResolver,
    space_mac::MacVerifiedCommit,
    space_ops::{ChangeSet, ChangeSetRefusal, OpPageRefusal, RepoOp, decode_op_page},
    space_sync::MAX_SPACE_PAGE_OPS,
    space_value_budget::ValueBudget,
    store::{StoreError, VerifiedSpaceBase, VerifiedSpaceTarget},
};

const MAX_POLL_PAGES: usize = 1_000;
const MAX_POLL_OPS: usize = MAX_SPACE_PAGE_OPS;
const MAX_TARGET_LOCKS: usize = 4_096;
// The one status an XRPC error a lexicon declares arrives with.
const XRPC_ERROR_STATUS: u16 = 400;
const REPO_NOT_FOUND: &str = "RepoNotFound";
const INVALID_CURSOR: &str = "InvalidCursor";
const UNAUTHORIZED_STATUS: u16 = 401;

/// What a cycle came to for one target. Everything but `Failed` leaves the
/// target in a state the next cycle can build on; a failure changes nothing in
/// the store.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VerifiedSyncOutcome {
    /// The member's repo is at the revision already held; nothing was written.
    Unchanged,
    /// The ops since the held revision were proven and promoted.
    Promoted,
    /// The whole repo was read, proven and written in place of the held state.
    Replaced,
    /// The host kept saying for `SPACE_REPO_NOT_FOUND_CONFIRMATION` that the
    /// repo does not exist; the member's state was cleared.
    Cleared,
    /// The author's key could not be found right now.
    Deferred,
    /// The target moved under the cycle; the next cycle starts again. Not a
    /// failure.
    Retry,
    Failed(FailureReason),
}

/// Why a target failed, from a fixed list. No variant carries text a host sent:
/// a host's error name is looked up in a table and anything else is `Other`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureReason {
    InvalidSpaceMac,
    InvalidSpaceUri,
    InvalidCredential,
    BadSpaceAudience,
    RepoNotFound,
    RepoTakendown,
    RepoSuspended,
    RepoDeactivated,
    InvalidCursor,
    Mac,
    KemKey,
    RecordRefused,
    Archive,
    RepoOverBudget,
    Digest,
    Deadline,
    ReplacementCooldown,
    Credential,
    Transport,
    Page,
    CursorStalled,
    Store,
    TargetCapacity,
    /// A replacement was refused because no cooldown could be kept for it.
    CooldownCapacity,
    /// The membership pass gave no generation for the target; only the
    /// scheduler raises it.
    MemberGeneration,
    /// The target's task did not run to its end; only the scheduler raises it.
    Task,
    Other,
}

impl FailureReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidSpaceMac => "invalid_space_mac",
            Self::InvalidSpaceUri => "invalid_space_uri",
            Self::InvalidCredential => "invalid_credential",
            Self::BadSpaceAudience => "bad_space_audience",
            Self::RepoNotFound => "repo_not_found",
            Self::RepoTakendown => "repo_takendown",
            Self::RepoSuspended => "repo_suspended",
            Self::RepoDeactivated => "repo_deactivated",
            Self::InvalidCursor => "invalid_cursor",
            Self::Mac => "mac",
            Self::KemKey => "kem_key",
            Self::RecordRefused => "record_refused",
            Self::Archive => "archive",
            Self::RepoOverBudget => "repo_over_budget",
            Self::Digest => "digest",
            Self::Deadline => "deadline",
            Self::ReplacementCooldown => "replacement_cooldown",
            Self::Credential => "credential",
            Self::Transport => "transport",
            Self::Page => "page",
            Self::CursorStalled => "cursor_stalled",
            Self::Store => "store",
            Self::TargetCapacity => "target_capacity",
            Self::CooldownCapacity => "cooldown_capacity",
            Self::MemberGeneration => "member_generation",
            Self::Task => "task",
            Self::Other => "other",
        }
    }
}

// The only error names a host can answer with that are told apart. A name
// outside this table is `Other`, so host-supplied text reaches nothing.
const HOST_REFUSALS: [(&str, FailureReason); 9] = [
    ("InvalidSpaceMac", FailureReason::InvalidSpaceMac),
    ("InvalidSpaceUri", FailureReason::InvalidSpaceUri),
    ("InvalidCredential", FailureReason::InvalidCredential),
    ("BadSpaceAudience", FailureReason::BadSpaceAudience),
    (REPO_NOT_FOUND, FailureReason::RepoNotFound),
    ("RepoTakendown", FailureReason::RepoTakendown),
    ("RepoSuspended", FailureReason::RepoSuspended),
    ("RepoDeactivated", FailureReason::RepoDeactivated),
    (INVALID_CURSOR, FailureReason::InvalidCursor),
];

fn host_refusal_reason(error: &SpaceHostError) -> FailureReason {
    match error {
        SpaceHostError::Request { code, .. } => HOST_REFUSALS
            .iter()
            .find(|(name, _)| Some(*name) == code.as_deref())
            .map_or(FailureReason::Other, |(_, reason)| *reason),
        _ => FailureReason::Transport,
    }
}

/// One page request: the revision of the base the poll builds on, the cursor of
/// the previous page, and the most ops a page may carry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PageRequest<'a> {
    pub since: Option<&'a str>,
    pub cursor: Option<&'a str>,
    pub limit: usize,
}

/// Authenticated reads from one member's host.
#[async_trait]
pub trait VerifiedSpaceReader: Send + Sync {
    async fn read_page(
        &self,
        target: &PdsPollTarget,
        request: PageRequest<'_>,
        deadline: Instant,
    ) -> Result<AuthenticatedPage, AuthenticatedReadError>;

    async fn read_archive(
        &self,
        target: &PdsPollTarget,
        deadline: Instant,
        budget: &ValueBudget,
    ) -> Result<AuthenticatedArchive, AuthenticatedReadError>;
}

/// Connects a reader to the host the authority named for a member, presenting
/// the boundary's credential.
#[async_trait]
pub trait VerifiedSpaceReaderSource: Send + Sync {
    async fn connect(
        &self,
        target: &PdsPollTarget,
        credential: Arc<HeldSpaceCredential>,
    ) -> Result<Arc<dyn VerifiedSpaceReader>, SpaceHostError>;
}

/// The pinned HTTP client with the KEM key lookup the MAC needs.
pub struct PinnedVerifiedReaderSource {
    kem_keys: Arc<dyn AuthorKemKeyResolver>,
}

impl PinnedVerifiedReaderSource {
    pub fn new(kem_keys: Arc<dyn AuthorKemKeyResolver>) -> Self {
        Self { kem_keys }
    }
}

struct PinnedVerifiedReader {
    client: PinnedSpaceHostClient,
    kem_keys: Arc<dyn AuthorKemKeyResolver>,
}

#[async_trait]
impl VerifiedSpaceReaderSource for PinnedVerifiedReaderSource {
    async fn connect(
        &self,
        target: &PdsPollTarget,
        credential: Arc<HeldSpaceCredential>,
    ) -> Result<Arc<dyn VerifiedSpaceReader>, SpaceHostError> {
        let proof: Arc<dyn SpaceCredentialProof> = credential;
        let client = PinnedSpaceHostClient::connect(&target.host, proof).await?;
        Ok(Arc::new(PinnedVerifiedReader {
            client,
            kem_keys: Arc::clone(&self.kem_keys),
        }))
    }
}

#[async_trait]
impl VerifiedSpaceReader for PinnedVerifiedReader {
    async fn read_page(
        &self,
        target: &PdsPollTarget,
        request: PageRequest<'_>,
        deadline: Instant,
    ) -> Result<AuthenticatedPage, AuthenticatedReadError> {
        self.client
            .list_repo_ops_authenticated(
                self.kem_keys.as_ref(),
                &target.space_uri,
                &target.did,
                request.since,
                request.cursor,
                request.limit,
                deadline,
            )
            .await
    }

    async fn read_archive(
        &self,
        target: &PdsPollTarget,
        deadline: Instant,
        budget: &ValueBudget,
    ) -> Result<AuthenticatedArchive, AuthenticatedReadError> {
        self.client
            .read_repo_archive_authenticated(
                self.kem_keys.as_ref(),
                &target.space_uri,
                &target.did,
                deadline,
                budget,
            )
            .await
    }
}

/// The time the synchronizer reads: a monotonic instant for the deadline and
/// the replacement cooldown, and the UTC text the store stamps its writes with.
pub trait SyncClock: Send + Sync {
    fn now(&self) -> Instant;
    fn utc_millis(&self) -> String;
}

pub struct SystemSyncClock;

impl SyncClock for SystemSyncClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn utc_millis(&self) -> String {
        let now = time::OffsetDateTime::now_utc();
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
            now.millisecond()
        )
    }
}

/// What one cycle may read and wait. The defaults are the configured limits;
/// tests lower them to reach a limit without building it.
#[derive(Clone, Copy, Debug)]
struct SyncLimits {
    pages: usize,
    ops: usize,
    body_bytes: usize,
    values: usize,
    deadline: Duration,
    cooldown: Duration,
    repo_not_found_confirmation: Duration,
    repo_not_found_max_gap: Duration,
    cooldown_capacity: usize,
    repo_not_found_capacity: usize,
}

impl Default for SyncLimits {
    fn default() -> Self {
        Self {
            pages: MAX_POLL_PAGES,
            ops: MAX_POLL_OPS,
            body_bytes: MAX_SPACE_POLL_BODY_BYTES,
            values: MAX_SPACE_CYCLE_VALUES,
            deadline: SPACE_TARGET_DEADLINE,
            cooldown: SPACE_REPLACEMENT_COOLDOWN,
            repo_not_found_confirmation: SPACE_REPO_NOT_FOUND_CONFIRMATION,
            repo_not_found_max_gap: SPACE_REPO_NOT_FOUND_MAX_GAP,
            cooldown_capacity: MAX_TARGET_LOCKS,
            repo_not_found_capacity: MAX_TARGET_LOCKS,
        }
    }
}

pub struct PdsSpaceSynchronizer {
    readers: Arc<dyn VerifiedSpaceReaderSource>,
    credentials: Arc<SpaceCredentialManager>,
    clock: Arc<dyn SyncClock>,
    limits: SyncLimits,
    target_locks: Arc<Mutex<BTreeMap<String, Arc<TargetLock>>>>,
    cooldowns: Mutex<BTreeMap<String, Instant>>,
    repo_not_found: Mutex<BTreeMap<String, RepoNotFoundAnswers>>,
    replacement_slot: Semaphore,
}

/// When a target's host first gave the `RepoNotFound` answer that has not been
/// interrupted since, when it last gave it, and which host gave it to which
/// membership generation.
struct RepoNotFoundAnswers {
    first: Instant,
    latest: Instant,
    host: String,
    generation: u64,
}

impl RepoNotFoundAnswers {
    fn starting(target: &PdsPollTarget, now: Instant) -> Self {
        Self {
            first: now,
            latest: now,
            host: target.host.clone(),
            generation: target.generation,
        }
    }

    // Only the same host answering the same generation, with no longer wait
    // than `max_gap` since its last answer, adds to the period: a host the
    // member left says nothing about the one it moved to, and a wait with no
    // answer is not an answer.
    fn is_continued_by(&self, target: &PdsPollTarget, now: Instant, max_gap: Duration) -> bool {
        self.host == target.host
            && self.generation == target.generation
            && now.saturating_duration_since(self.latest) <= max_gap
    }
}

/// What a `RepoNotFound` answer comes to for a target.
enum RepoNotFoundStanding {
    /// One host has given it to one generation for the whole confirmation
    /// period, never waiting longer than the longest gap between two answers.
    Confirmed,
    Remembered,
    /// No answer could be remembered, so the period does not start.
    NoRoom,
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

/// One cycle's end: either a finished outcome or the need to read the whole
/// repo. Only the incremental path produces `NeedsReplacement`, and only for
/// the reasons the rules name.
#[derive(Debug, Eq, PartialEq)]
enum PollEnd {
    Finished(VerifiedSyncOutcome),
    NeedsReplacement,
}

/// How a failed read ends a cycle.
enum ReadFailure {
    RepoNotFound,
    Deferred,
    Failed(FailureReason),
}

/// A failed page read either asks for the whole repo or ends the cycle as any
/// failed read does.
enum PageFailure {
    Replace,
    Read(ReadFailure),
}

impl PdsSpaceSynchronizer {
    pub fn new(
        readers: Arc<dyn VerifiedSpaceReaderSource>,
        credentials: Arc<SpaceCredentialManager>,
    ) -> Self {
        Self::with_clock(readers, credentials, Arc::new(SystemSyncClock))
    }

    pub fn with_clock(
        readers: Arc<dyn VerifiedSpaceReaderSource>,
        credentials: Arc<SpaceCredentialManager>,
        clock: Arc<dyn SyncClock>,
    ) -> Self {
        Self {
            readers,
            credentials,
            clock,
            limits: SyncLimits::default(),
            target_locks: Arc::new(Mutex::new(BTreeMap::new())),
            cooldowns: Mutex::new(BTreeMap::new()),
            repo_not_found: Mutex::new(BTreeMap::new()),
            replacement_slot: Semaphore::new(1),
        }
    }

    /// Runs one cycle for `target` under the per-target lock and the absolute
    /// deadline, which starts when the cycle is entered and covers the wait
    /// for the lock. Nothing is written but by one store call that checks the
    /// digest itself; a cycle that is dropped part way leaves the store as it
    /// was.
    pub async fn sync_target(
        &self,
        lifecycle: &ControlLifecycle,
        target: &PdsPollTarget,
        retained_at: &str,
    ) -> VerifiedSyncOutcome {
        let deadline = self.clock.now() + self.limits.deadline;
        let _lease = match tokio::time::timeout_at(deadline, self.lock_target(target)).await {
            Ok(Ok(lease)) => lease,
            Ok(Err(reason)) => return VerifiedSyncOutcome::Failed(reason),
            Err(_) => return VerifiedSyncOutcome::Failed(FailureReason::Deadline),
        };
        // Declared after the lease so that it is dropped while the target is
        // still held, and never forgets an answer that the next cycle for the
        // target has remembered.
        let repo_not_found = RepoNotFoundWatch {
            synchronizer: self,
            key: Self::target_key(target),
            kept: AtomicBool::new(false),
        };
        let cycle = Cycle {
            synchronizer: self,
            lifecycle,
            target,
            retained_at,
            repo_not_found: &repo_not_found,
            deadline,
            budget: ValueBudget::with_limit(self.limits.values),
            store_target: VerifiedSpaceTarget {
                boundary: target.boundary.clone(),
                space_uri: target.space_uri.clone(),
                actor_did: target.did.clone(),
                host: target.host.clone(),
                generation: target.generation,
            },
        };
        match tokio::time::timeout_at(deadline, cycle.run()).await {
            Ok(outcome) => outcome,
            Err(_) => VerifiedSyncOutcome::Failed(FailureReason::Deadline),
        }
    }

    fn target_key(target: &PdsPollTarget) -> String {
        format!("{}\0{}\0{}", target.boundary, target.space_uri, target.did)
    }

    async fn lock_target(&self, target: &PdsPollTarget) -> Result<TargetLease, FailureReason> {
        let key = Self::target_key(target);
        let lock = {
            let mut locks = self.target_locks.lock().expect("PDS target locks poisoned");
            if let Some(lock) = locks.get(&key) {
                lock.users.fetch_add(1, Ordering::AcqRel);
                Arc::clone(lock)
            } else {
                if locks.len() == MAX_TARGET_LOCKS {
                    return Err(FailureReason::TargetCapacity);
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

    fn cooling_down(&self, key: &str) -> bool {
        let now = self.clock.now();
        self.cooldowns
            .lock()
            .expect("replacement cooldowns poisoned")
            .get(key)
            .is_some_and(|until| *until > now)
    }

    // The map is bounded like the target locks, and an entry is never dropped
    // before it ends: only expired entries make room, and with none to make, a
    // target that would need a new entry is given no replacement.
    fn has_room_for_a_cooldown(&self) -> bool {
        let now = self.clock.now();
        let mut cooldowns = self
            .cooldowns
            .lock()
            .expect("replacement cooldowns poisoned");
        cooldowns.retain(|_, until| *until > now);
        cooldowns.len() < self.limits.cooldown_capacity
    }

    fn start_cooldown(&self, key: String) {
        let now = self.clock.now();
        self.cooldowns
            .lock()
            .expect("replacement cooldowns poisoned")
            .insert(key, now + self.limits.cooldown);
    }

    // Bounded like the cooldowns. An entry whose target has not given the
    // answer for a whole period is stale and makes room; with no room the
    // answer is not remembered, which delays a clear and never hastens one.
    fn note_repo_not_found(&self, target: &PdsPollTarget) -> RepoNotFoundStanding {
        let now = self.clock.now();
        let period = self.limits.repo_not_found_confirmation;
        let key = Self::target_key(target);
        let mut answers = self
            .repo_not_found
            .lock()
            .expect("repo-not-found answers poisoned");
        if let Some(answer) = answers.get_mut(&key) {
            if !answer.is_continued_by(target, now, self.limits.repo_not_found_max_gap) {
                *answer = RepoNotFoundAnswers::starting(target, now);
                return RepoNotFoundStanding::Remembered;
            }
            if now.saturating_duration_since(answer.first) >= period {
                return RepoNotFoundStanding::Confirmed;
            }
            answer.latest = now;
            return RepoNotFoundStanding::Remembered;
        }
        answers.retain(|_, answer| now.saturating_duration_since(answer.latest) < period);
        if answers.len() >= self.limits.repo_not_found_capacity {
            return RepoNotFoundStanding::NoRoom;
        }
        answers.insert(key, RepoNotFoundAnswers::starting(target, now));
        RepoNotFoundStanding::Remembered
    }

    fn forget_repo_not_found(&self, key: &str) {
        self.repo_not_found
            .lock()
            .expect("repo-not-found answers poisoned")
            .remove(key);
    }

    #[cfg(test)]
    fn with_limits(mut self, limits: SyncLimits) -> Self {
        self.limits = limits;
        self
    }
}

struct Cycle<'a> {
    synchronizer: &'a PdsSpaceSynchronizer,
    lifecycle: &'a ControlLifecycle,
    target: &'a PdsPollTarget,
    retained_at: &'a str,
    repo_not_found: &'a RepoNotFoundWatch<'a>,
    deadline: Instant,
    budget: ValueBudget,
    store_target: VerifiedSpaceTarget,
}

impl Cycle<'_> {
    async fn run(&self) -> VerifiedSyncOutcome {
        let credential = match self
            .synchronizer
            .credentials
            .get(&self.target.boundary)
            .await
        {
            Ok(credential) => credential,
            Err(_) => return VerifiedSyncOutcome::Failed(FailureReason::Credential),
        };
        let reader = match self
            .synchronizer
            .readers
            .connect(self.target, Arc::clone(&credential))
            .await
        {
            Ok(reader) => reader,
            Err(error) => {
                self.forget_rejected(&credential, &error);
                return VerifiedSyncOutcome::Failed(host_refusal_reason(&error));
            }
        };
        let base = match self.lifecycle.verified_space_base_at_generation(
            &self.target.boundary,
            &self.target.space_uri,
            &self.target.did,
            self.target.generation,
        ) {
            Ok(base) => base,
            Err(error) => return store_error_ends_poll(&error),
        };
        // A member with no base has nothing to build on, and the store fences a
        // promotion on a base from another host or generation, so neither reads
        // a page.
        let Some(base) = base.filter(|base| {
            base.host == self.target.host && base.generation == self.target.generation
        }) else {
            let outcome = self.replace(reader.as_ref(), &credential).await;
            // A `RepoNotFound` answer to an archive request starts the
            // cooldown itself, and a cycle it turns away here has asked the
            // host nothing. Were the answer forgotten, it could never last the
            // confirmation period.
            if outcome == VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown) {
                self.repo_not_found.keep();
            }
            return outcome;
        };
        match self.poll(reader.as_ref(), &credential, &base).await {
            PollEnd::Finished(outcome) => outcome,
            PollEnd::NeedsReplacement => self.replace(reader.as_ref(), &credential).await,
        }
    }

    // A 401 means the credential in hand was refused, so the next cycle must
    // mint a new one.
    fn forget_rejected(&self, credential: &Arc<HeldSpaceCredential>, error: &SpaceHostError) {
        if matches!(
            error,
            SpaceHostError::Request {
                status: UNAUTHORIZED_STATUS,
                ..
            }
        ) {
            self.synchronizer
                .credentials
                .invalidate(&self.target.boundary, credential);
        }
    }

    async fn poll(
        &self,
        reader: &dyn VerifiedSpaceReader,
        credential: &Arc<HeldSpaceCredential>,
        base: &VerifiedSpaceBase,
    ) -> PollEnd {
        let limits = self.synchronizer.limits;
        let mut ops: Vec<RepoOp> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = BTreeSet::new();
        let mut body_bytes = 0_usize;
        let mut commit: Option<MacVerifiedCommit> = None;
        for _ in 0..limits.pages {
            let request = PageRequest {
                since: Some(&base.rev),
                cursor: cursor.as_deref(),
                limit: MAX_SPACE_PAGE_OPS,
            };
            let page = match reader.read_page(self.target, request, self.deadline).await {
                Ok(page) => page,
                Err(error) => {
                    self.note_read_error(credential, &error);
                    return match page_failure(error) {
                        PageFailure::Replace => PollEnd::NeedsReplacement,
                        PageFailure::Read(failure) => PollEnd::Finished(self.end_read(failure)),
                    };
                }
            };
            body_bytes = body_bytes.saturating_add(page.body().len());
            // Too much to read for a poll is recovered from the whole repo.
            if body_bytes > limits.body_bytes {
                return PollEnd::NeedsReplacement;
            }
            let decoded = match decode_op_page(page.body(), &self.budget) {
                Ok(decoded) => decoded,
                Err(OpPageRefusal::OverBudget) => {
                    return PollEnd::Finished(VerifiedSyncOutcome::Failed(
                        FailureReason::RepoOverBudget,
                    ));
                }
                Err(_) => {
                    return PollEnd::Finished(VerifiedSyncOutcome::Failed(FailureReason::Page));
                }
            };
            let next_cursor = decoded.cursor().map(str::to_owned);
            if ops.len().saturating_add(decoded.ops().len()) > limits.ops {
                return PollEnd::NeedsReplacement;
            }
            ops.extend(decoded.into_ops());
            let Some(next_cursor) = next_cursor else {
                commit = Some(page.commit().clone());
                break;
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                return PollEnd::Finished(VerifiedSyncOutcome::Failed(
                    FailureReason::CursorStalled,
                ));
            }
            cursor = Some(next_cursor);
        }
        // A page with a cursor is never the last, so running out of pages is
        // running out of the poll's page budget.
        let Some(commit) = commit else {
            return PollEnd::NeedsReplacement;
        };
        self.promote(base, ops, &commit)
    }

    fn promote(
        &self,
        base: &VerifiedSpaceBase,
        ops: Vec<RepoOp>,
        commit: &MacVerifiedCommit,
    ) -> PollEnd {
        // A host whose commit is older than the base is recovered from the whole
        // repo whatever its digest: a replacement has no revision floor.
        if commit.rev() < base.rev.as_str() {
            return PollEnd::NeedsReplacement;
        }
        let change_set = match ChangeSet::apply(base.state.clone(), &ops) {
            Ok(change_set) => change_set,
            // The host's ops do not follow what is held.
            Err(ChangeSetRefusal::PreviousMismatch) => return PollEnd::NeedsReplacement,
            Err(_) => {
                return PollEnd::Finished(VerifiedSyncOutcome::Failed(
                    FailureReason::RecordRefused,
                ));
            }
        };
        // Nothing can be projected from a post, like or repost that arrived
        // without its record; only the whole repo has it.
        if change_set
            .changes()
            .iter()
            .any(|change| change.value_missing())
        {
            return PollEnd::NeedsReplacement;
        }
        // An old `since` after the host dropped its oplog returns only later
        // ops with no error, so a gap shows only here.
        let Ok(proven) = change_set.prove(commit) else {
            return PollEnd::NeedsReplacement;
        };
        // The bounds come after the digest so that ops which do not give the
        // commit's state are recovered from the whole repo whatever their
        // revisions.
        if !ops_within_revisions(&ops, &base.rev, commit.rev()) {
            return PollEnd::Finished(VerifiedSyncOutcome::Failed(FailureReason::Page));
        }
        if proven.change_set().changes().is_empty() && commit.rev() == base.rev {
            return PollEnd::Finished(VerifiedSyncOutcome::Unchanged);
        }
        if self.past_deadline() {
            return PollEnd::Finished(VerifiedSyncOutcome::Failed(FailureReason::Deadline));
        }
        match self.lifecycle.promote_verified_space_repo(
            &self.store_target,
            Some(&base.rev),
            commit,
            proven.change_set(),
            self.retained_at,
            &self.synchronizer.clock.utc_millis(),
        ) {
            Ok(()) => PollEnd::Finished(VerifiedSyncOutcome::Promoted),
            Err(error) => promotion_refusal(&error),
        }
    }

    async fn replace(
        &self,
        reader: &dyn VerifiedSpaceReader,
        credential: &Arc<HeldSpaceCredential>,
    ) -> VerifiedSyncOutcome {
        let key = PdsSpaceSynchronizer::target_key(self.target);
        if self.synchronizer.cooling_down(&key) {
            return VerifiedSyncOutcome::Failed(FailureReason::ReplacementCooldown);
        }
        // One whole-repo read at a time across targets bounds what the process
        // holds for recoveries.
        let Ok(_slot) = self.synchronizer.replacement_slot.acquire().await else {
            return VerifiedSyncOutcome::Failed(FailureReason::Other);
        };
        // Only a replacement holding the slot starts a cooldown, so room found
        // here is still there if this one fails; a replacement that could not
        // be cooled down after a failure is not begun.
        if !self.synchronizer.has_room_for_a_cooldown() {
            return VerifiedSyncOutcome::Failed(FailureReason::CooldownCapacity);
        }
        let mut attempt = ReplacementAttempt {
            synchronizer: self.synchronizer,
            key: Some(key),
        };
        let outcome = self.replace_in_slot(reader, credential).await;
        // An attempt that does not get to the end, a deadline included, counts
        // as failed too: the guard starts the cooldown when it is dropped armed.
        if !matches!(outcome, VerifiedSyncOutcome::Failed(_)) {
            attempt.key = None;
        }
        outcome
    }

    async fn replace_in_slot(
        &self,
        reader: &dyn VerifiedSpaceReader,
        credential: &Arc<HeldSpaceCredential>,
    ) -> VerifiedSyncOutcome {
        let archive = match reader
            .read_archive(self.target, self.deadline, &self.budget)
            .await
        {
            Ok(archive) => archive,
            Err(error) => {
                self.note_read_error(credential, &error);
                return self.end_read(archive_failure(error));
            }
        };
        let (commit, records) = archive.into_parts();
        if self.past_deadline() {
            return VerifiedSyncOutcome::Failed(FailureReason::Deadline);
        }
        match self.lifecycle.replace_verified_space_repo(
            &self.store_target,
            &commit,
            &records,
            self.retained_at,
            &self.synchronizer.clock.utc_millis(),
        ) {
            Ok(()) => VerifiedSyncOutcome::Replaced,
            Err(error) => replacement_refusal(&error),
        }
    }

    // The answer carries no MAC, so the member's state is cleared only once the
    // host has given it for the whole confirmation period.
    fn clear_once_confirmed(&self) -> VerifiedSyncOutcome {
        let unconfirmed = VerifiedSyncOutcome::Failed(FailureReason::RepoNotFound);
        match self.synchronizer.note_repo_not_found(self.target) {
            RepoNotFoundStanding::Confirmed => self.clear(),
            RepoNotFoundStanding::Remembered => {
                self.repo_not_found.keep();
                unconfirmed
            }
            RepoNotFoundStanding::NoRoom => unconfirmed,
        }
    }

    // The host said the repo does not exist: only the member's state in this
    // space is cleared, and only under the generation the cycle started with.
    fn clear(&self) -> VerifiedSyncOutcome {
        if self.past_deadline() {
            return VerifiedSyncOutcome::Failed(FailureReason::Deadline);
        }
        match self
            .lifecycle
            .clear_verified_space_repo(&self.store_target, &self.synchronizer.clock.utc_millis())
        {
            Ok(()) => VerifiedSyncOutcome::Cleared,
            Err(error) => store_error_ends_poll(&error),
        }
    }

    // The timeout around the cycle cannot stop a store call, which runs to its
    // end once begun, so this check stops a write from being started after the
    // deadline. A write that passed it waits for the store's locks, and the
    // process locks have no time bound; it then runs as one atomic write, and
    // the cycle reports what it did.
    fn past_deadline(&self) -> bool {
        self.synchronizer.clock.now() >= self.deadline
    }

    fn note_read_error(
        &self,
        credential: &Arc<HeldSpaceCredential>,
        error: &AuthenticatedReadError,
    ) {
        if let AuthenticatedReadError::Host(host) = error {
            self.forget_rejected(credential, host);
        }
    }

    fn end_read(&self, failure: ReadFailure) -> VerifiedSyncOutcome {
        match failure {
            ReadFailure::RepoNotFound => self.clear_once_confirmed(),
            ReadFailure::Deferred => VerifiedSyncOutcome::Deferred,
            ReadFailure::Failed(reason) => VerifiedSyncOutcome::Failed(reason),
        }
    }
}

/// Starts the replacement cooldown for its target when dropped armed.
struct ReplacementAttempt<'a> {
    synchronizer: &'a PdsSpaceSynchronizer,
    key: Option<String>,
}

impl Drop for ReplacementAttempt<'_> {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.synchronizer.start_cooldown(key);
        }
    }
}

/// Forgets the target's remembered `RepoNotFound` answer when dropped, so that
/// a cycle that ends any other way, by a deadline or an abort included, starts
/// the confirmation period again.
struct RepoNotFoundWatch<'a> {
    synchronizer: &'a PdsSpaceSynchronizer,
    key: String,
    kept: AtomicBool,
}

impl RepoNotFoundWatch<'_> {
    fn keep(&self) {
        self.kept.store(true, Ordering::Release);
    }
}

impl Drop for RepoNotFoundWatch<'_> {
    fn drop(&mut self) {
        if !self.kept.load(Ordering::Acquire) {
            self.synchronizer.forget_repo_not_found(&self.key);
        }
    }
}

fn page_failure(error: AuthenticatedReadError) -> PageFailure {
    match &error {
        AuthenticatedReadError::Host(SpaceHostError::Request {
            status: XRPC_ERROR_STATUS,
            code: Some(name),
        }) if name == INVALID_CURSOR => PageFailure::Replace,
        // More than a poll may read is recovered from the whole repo.
        AuthenticatedReadError::Host(SpaceHostError::ResponseTooLarge) => PageFailure::Replace,
        _ => PageFailure::Read(read_failure(error)),
    }
}

fn archive_failure(error: AuthenticatedReadError) -> ReadFailure {
    match &error {
        AuthenticatedReadError::Host(SpaceHostError::ResponseTooLarge) => {
            ReadFailure::Failed(FailureReason::RepoOverBudget)
        }
        _ => read_failure(error),
    }
}

fn read_failure(error: AuthenticatedReadError) -> ReadFailure {
    match error {
        AuthenticatedReadError::KemKeyUnavailable => ReadFailure::Deferred,
        AuthenticatedReadError::KemKeyInvalid => ReadFailure::Failed(FailureReason::KemKey),
        AuthenticatedReadError::Host(SpaceHostError::Request {
            status: XRPC_ERROR_STATUS,
            code: Some(name),
        }) if name == REPO_NOT_FOUND => ReadFailure::RepoNotFound,
        AuthenticatedReadError::Host(host) => ReadFailure::Failed(host_refusal_reason(&host)),
        AuthenticatedReadError::Authentication(_) => ReadFailure::Failed(FailureReason::Mac),
        AuthenticatedReadError::Archive(ArchiveRefusal::LimitExceeded(_))
        | AuthenticatedReadError::OverBudget => ReadFailure::Failed(FailureReason::RepoOverBudget),
        AuthenticatedReadError::Archive(_) | AuthenticatedReadError::ArchiveOrder(_) => {
            ReadFailure::Failed(FailureReason::Archive)
        }
        AuthenticatedReadError::ArchiveRecord(_) => {
            ReadFailure::Failed(FailureReason::RecordRefused)
        }
        AuthenticatedReadError::DeadlineExceeded => ReadFailure::Failed(FailureReason::Deadline),
    }
}

// What a refused promotion asks for: a stored host or generation that is not
// the target's, a record that does not follow the stored one and a digest that
// is not the commit's are all recovered from the whole repo.
fn promotion_refusal(error: &StoreError) -> PollEnd {
    match error {
        StoreError::SpaceRepoFenced
        | StoreError::SpaceRepoPreviousMismatch
        | StoreError::SpaceRepoDigestMismatch => PollEnd::NeedsReplacement,
        other => PollEnd::Finished(store_error_ends_poll(other)),
    }
}

// A refused replacement has nowhere further to recover to. The store checks
// the digest itself, so a mismatch here is the archive's, not the poll's; and
// it refuses the value of a record it cannot hold to its CID.
fn replacement_refusal(error: &StoreError) -> VerifiedSyncOutcome {
    match error {
        StoreError::SpaceRepoDigestMismatch => VerifiedSyncOutcome::Failed(FailureReason::Digest),
        StoreError::SpaceRepoInvalid => VerifiedSyncOutcome::Failed(FailureReason::RecordRefused),
        other => store_error_ends_poll(other),
    }
}

// A store refusal that does not name a recovery: the member left or the base
// moved, which the next cycle starts over from, or a failure.
fn store_error_ends_poll(error: &StoreError) -> VerifiedSyncOutcome {
    match error {
        StoreError::UnauthorizedSpaceMember | StoreError::SpaceRepoBaseMoved => {
            VerifiedSyncOutcome::Retry
        }
        StoreError::SpaceRepoOverBudget => {
            VerifiedSyncOutcome::Failed(FailureReason::RepoOverBudget)
        }
        _ => VerifiedSyncOutcome::Failed(FailureReason::Store),
    }
}

// Every op is above the base, none is above the commit the poll ends on, and
// none is below the one before it.
fn ops_within_revisions(ops: &[RepoOp], base_rev: &str, commit_rev: &str) -> bool {
    ops.iter()
        .all(|op| op.rev() > base_rev && op.rev() <= commit_rev)
        && ops.windows(2).all(|pair| pair[0].rev() <= pair[1].rev())
}

#[cfg(test)]
pub(crate) mod test_host;
#[cfg(test)]
mod tests;
