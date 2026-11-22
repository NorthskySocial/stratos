use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{
    actor_event::{ActorEventError, parse_actor_commit},
    authorization::{AuthorizationError, ViewerAuthorization, ViewerAuthorizations},
    feed_service::{
        FeedQuery, FeedService, FeedServiceError, ViewerAuthorization as FeedViewerAuthorization,
    },
    feeds::FeedRegistry,
    identifier::{Did, RecordUri},
    moderation_label::{LabelPage, LabelSubject},
    readiness::{FeedReadinessGate, ReconciliationOutcome},
    service::ProjectionReader,
    service_event::{EnrollmentAction, EnrollmentEvent},
    space_mac::MacVerifiedCommit,
    space_ops::ChangeSet,
    store::{
        ActorEnrollment, ActorPage, ActorSyncState, EnrollmentReconciliation, LabelPageEffects,
        PdsSpaceMember, StoreError, StoreInterrupt, VerifiedSpaceBase, VerifiedSpaceRecord,
        VerifiedSpaceTarget,
    },
    telemetry::FeedTelemetry,
};

#[derive(Debug)]
pub enum ActorFrameError {
    Event(ActorEventError),
    Store(StoreError),
}

impl std::fmt::Display for ActorFrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("actor frame could not be applied")
    }
}

impl std::error::Error for ActorFrameError {}

pub enum ActorFrameResult {
    Applied,
    Ignored,
    NotEnrolled,
}

pub struct ControlLifecycle {
    transition: Mutex<()>,
    authorizations: Mutex<ViewerAuthorizations>,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    projection: Arc<Mutex<ProjectionReader>>,
    interrupt: StoreInterrupt,
    authority_did: Option<String>,
    telemetry: Arc<FeedTelemetry>,
    labels_caught_up_at: Mutex<Option<Instant>>,
}

impl ControlLifecycle {
    pub fn new(projection: ProjectionReader, readiness: Arc<Mutex<FeedReadinessGate>>) -> Self {
        Self::with_authorizations(
            projection,
            readiness,
            ViewerAuthorizations::new(crate::authorization::DEFAULT_AUTHORIZATION_BYTES),
            None,
            Arc::new(FeedTelemetry::disabled()),
        )
    }

    pub fn for_authority(
        projection: ProjectionReader,
        readiness: Arc<Mutex<FeedReadinessGate>>,
        authority_did: impl Into<String>,
    ) -> Result<Self, crate::identifier::IdentifierError> {
        Self::for_authority_with_telemetry(
            projection,
            readiness,
            authority_did,
            Arc::new(FeedTelemetry::disabled()),
        )
    }

    pub fn for_authority_with_telemetry(
        projection: ProjectionReader,
        readiness: Arc<Mutex<FeedReadinessGate>>,
        authority_did: impl Into<String>,
        telemetry: Arc<FeedTelemetry>,
    ) -> Result<Self, crate::identifier::IdentifierError> {
        let authority_did = authority_did.into();
        Did::parse(authority_did.clone())?;
        Ok(Self::with_authorizations(
            projection,
            readiness,
            ViewerAuthorizations::new(crate::authorization::DEFAULT_AUTHORIZATION_BYTES),
            Some(authority_did),
            telemetry,
        ))
    }

    fn with_authorizations(
        projection: ProjectionReader,
        readiness: Arc<Mutex<FeedReadinessGate>>,
        authorizations: ViewerAuthorizations,
        authority_did: Option<String>,
        telemetry: Arc<FeedTelemetry>,
    ) -> Self {
        let interrupt = projection.interrupt_handle();
        Self {
            transition: Mutex::new(()),
            authorizations: Mutex::new(authorizations),
            readiness,
            projection: Arc::new(Mutex::new(projection)),
            interrupt,
            authority_did,
            telemetry,
            labels_caught_up_at: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(crate) fn read<T>(&self, action: impl FnOnce(&ProjectionReader) -> T) -> T {
        let projection = self.projection.lock().expect("projection lock poisoned");
        action(&projection)
    }

    pub fn serve_viewer_feed(
        &self,
        did: &str,
        feeds: &FeedRegistry,
        query: FeedQuery<'_>,
    ) -> Result<(Vec<u8>, usize), FeedServiceError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        if !self
            .readiness
            .lock()
            .expect("readiness lock poisoned")
            .is_ready()
        {
            return Err(FeedServiceError::FeedNotReady);
        }
        let authorization = self
            .authorizations
            .lock()
            .expect("authorization lock poisoned")
            .current(did, query.now)
            .ok_or(FeedServiceError::AuthorizationUnavailable)?;
        let projection = self.projection.lock().expect("projection lock poisoned");
        FeedService::new(feeds, &projection).serve_serialized(
            FeedViewerAuthorization {
                did: &authorization.did,
                boundaries: &authorization.boundaries,
                expires_at: authorization.expires_at,
            },
            query,
        )
    }

    pub fn prepare_viewer_blob(
        &self,
        did: &str,
        feeds: &FeedRegistry,
        uri: &str,
        now: u64,
        as_of: &str,
    ) -> Result<Option<(crate::admission::ReadToken, crate::store::BlobPost)>, FeedServiceError>
    {
        if !matches!(RecordUri::parse(uri), Ok(RecordUri::Repo { .. })) {
            return Ok(None);
        }
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        if !self
            .readiness
            .lock()
            .expect("readiness lock poisoned")
            .is_ready()
        {
            return Err(FeedServiceError::FeedNotReady);
        }
        let authorization = self
            .authorizations
            .lock()
            .expect("authorization lock poisoned")
            .current(did, now)
            .ok_or(FeedServiceError::AuthorizationUnavailable)?;
        let projection = self.projection.lock().expect("projection lock poisoned");
        let Some(post) = projection
            .blob_post(uri, as_of)
            .map_err(FeedServiceError::Store)?
        else {
            return Ok(None);
        };
        let Some(boundary) = post.boundaries.iter().find(|boundary| {
            authorization.boundaries.contains(boundary)
                && feeds.list().any(|feed| &feed.boundary == *boundary)
        }) else {
            return Ok(None);
        };
        projection
            .prepare_blob(
                crate::service::ReadRequest {
                    viewer: &authorization.did,
                    boundary,
                    authority_expires_at: authorization.expires_at,
                    now,
                    cursor: None,
                    limit: 1,
                    as_of,
                },
                uri,
            )
            .map_err(FeedServiceError::Store)
    }

    pub fn release_blob<T>(
        &self,
        token: crate::admission::ReadToken,
        value: T,
        now: u64,
    ) -> Option<T> {
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .release(token, value, now)
    }

    pub fn interrupt_feed_work(&self) {
        self.interrupt.interrupt();
    }

    pub fn session_established(&self) {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        readiness.mark_session_established();
        projection.close_session();
        self.telemetry.mark_service_connected();
        self.telemetry.mark_unready();
    }

    pub fn begin_reconciliation(&self) -> u64 {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        projection.close_session();
        self.telemetry.mark_unready();
        readiness.begin_reconciliation()
    }

    pub fn complete_reconciliation(&self, generation: u64, outcome: ReconciliationOutcome) -> bool {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        let accepted = readiness.complete_reconciliation(generation, outcome);
        if readiness.is_ready() {
            projection.establish_session();
            self.telemetry.mark_ready();
        } else {
            projection.close_session();
            self.telemetry.mark_unready();
        }
        accepted
    }

    pub fn label_cursor(&self) -> Result<u64, StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .label_cursor(authority_did)
    }

    pub fn apply_label_page(
        &self,
        page: &LabelPage,
        updated_at: &str,
    ) -> Result<LabelPageEffects, StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let effects = self
            .projection
            .lock()
            .expect("projection lock poisoned")
            .apply_label_page(authority_did, page, updated_at)?;
        for subject in &effects.taken_down {
            let LabelSubject::Account { did } = subject else {
                continue;
            };
            if self.revoke_viewer_authorization_locked(did) {
                self.projection
                    .lock()
                    .expect("projection lock poisoned")
                    .invalidate_viewer(did);
            }
        }
        Ok(effects)
    }

    pub fn reinstating_accounts(&self, limit: u16) -> Result<Vec<(String, u32)>, StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .reinstating_accounts(authority_did, limit)
    }

    pub fn is_account_taken_down(&self, did: &str) -> Result<bool, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .is_account_taken_down(did)
    }

    pub fn is_actor_enrolled(&self, did: &str) -> Result<bool, StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .actor_sync_state(authority_did, did)
            .map(|state| state.is_some())
    }

    pub fn reinstating_records(&self, limit: u16) -> Result<Vec<String>, StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .reinstating_records(authority_did, limit)
    }

    pub fn reset_actor_cursor(&self, did: &str) -> Result<(), StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .reset_actor_cursor(authority_did, did)
    }

    pub fn reset_pds_member_space_state(
        &self,
        boundary: &str,
        did: &str,
    ) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .reset_pds_member_space_state(boundary, did)
    }

    pub fn finish_reinstatement(&self, subject_key: &str) -> Result<(), StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .finish_reinstatement(authority_did, subject_key)
    }

    pub fn record_reinstatement_attempt(&self, subject_key: &str) -> Result<(), StoreError> {
        let authority_did = self.label_authority()?;
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .record_reinstatement_attempt(authority_did, subject_key)
    }

    pub fn mark_labels_current(&self) {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        *self
            .labels_caught_up_at
            .lock()
            .expect("label freshness lock poisoned") = Some(Instant::now());
        let changed = readiness.mark_labels_current();
        if changed && readiness.is_ready() {
            projection.establish_session();
            self.telemetry.mark_ready();
        }
    }

    #[cfg(test)]
    pub(crate) fn mark_labels_stale(&self) {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.withdraw_labels_locked();
    }

    /// Closes reads once the label log has not been read to its head within
    /// `max_staleness`. Returns whether this call closed them, so an outage is
    /// reported once.
    pub fn withdraw_stale_labels(&self, now: Instant, max_staleness: Duration) -> bool {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let caught_up_at = *self
            .labels_caught_up_at
            .lock()
            .expect("label freshness lock poisoned");
        let overdue =
            caught_up_at.is_some_and(|at| now.saturating_duration_since(at) >= max_staleness);
        if overdue {
            self.withdraw_labels_locked();
        }
        overdue
    }

    /// When reads close unless the log is read to its head again first. `None`
    /// means they are already closed for want of a catch-up.
    pub fn labels_fresh_until(&self, max_staleness: Duration) -> Option<Instant> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.labels_caught_up_at
            .lock()
            .expect("label freshness lock poisoned")
            .map(|at| at + max_staleness)
    }

    fn withdraw_labels_locked(&self) {
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        *self
            .labels_caught_up_at
            .lock()
            .expect("label freshness lock poisoned") = None;
        readiness.mark_labels_stale();
        projection.close_session();
        self.telemetry.mark_unready();
    }

    fn label_authority(&self) -> Result<&str, StoreError> {
        self.authority_did
            .as_deref()
            .ok_or(StoreError::InvalidProjectionMutation)
    }

    pub fn mark_unavailable(&self) {
        self.close_reads();
        self.telemetry.mark_service_disconnected();
    }

    /// Closes feed admission after a projection failure while retaining the
    /// independent service-stream connection signal.
    pub fn mark_read_unavailable(&self) {
        self.close_reads();
    }

    fn close_reads(&self) {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        readiness.mark_unavailable();
        projection.close_session();
        self.telemetry.mark_unready();
    }

    pub fn apply_actor_page(&self, page: ActorPage) -> Result<(), StoreError> {
        let upserts = page.upserts.len();
        let deletes = page.deletes.len();
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let result = self
            .projection
            .lock()
            .expect("projection lock poisoned")
            .apply_actor_page(page);
        self.telemetry.record_index_operations(
            upserts,
            deletes,
            if result.is_ok() { "ok" } else { "error" },
        );
        result
    }

    pub fn compact_projection(
        &self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
    ) -> Result<crate::store::ProjectionCompaction, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .compact_projection(as_of, maximum_retained_at, max_bytes, limit)
    }

    pub fn compact_projection_with_reserve(
        &self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
        space_write_reserve_bytes: u64,
    ) -> Result<crate::store::ProjectionCompaction, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .compact_projection_with_reserve(
                as_of,
                maximum_retained_at,
                max_bytes,
                limit,
                space_write_reserve_bytes,
            )
    }

    pub fn actor_sync_state(
        &self,
        authority_did: &str,
        did: &str,
    ) -> Result<Option<ActorSyncState>, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .actor_sync_state(authority_did, did)
    }

    pub fn apply_actor_frame(
        &self,
        frame: &[u8],
        authority_did: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<ActorFrameResult, ActorFrameError> {
        if self.authority_did.as_deref() != Some(authority_did) {
            return Err(ActorFrameError::Event(
                ActorEventError::InvalidConfiguration,
            ));
        }
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        let Some(state) = projection
            .actor_sync_state(authority_did, actor_did)
            .map_err(ActorFrameError::Store)?
        else {
            return Ok(ActorFrameResult::NotEnrolled);
        };
        let boundaries = state.boundaries.into_iter().collect();
        let Some(page) =
            parse_actor_commit(frame, authority_did, actor_did, &boundaries, retained_at)
                .map_err(ActorFrameError::Event)?
        else {
            return Ok(ActorFrameResult::Ignored);
        };
        let upserts = page.upserts.len();
        let deletes = page.deletes.len();
        let result = projection
            .apply_actor_page(page)
            .map_err(ActorFrameError::Store);
        self.telemetry.record_index_operations(
            upserts,
            deletes,
            if result.is_ok() { "ok" } else { "error" },
        );
        result?;
        Ok(ActorFrameResult::Applied)
    }

    pub fn list_actor_enrollments_page(
        &self,
        after_did: Option<&str>,
        limit: u16,
    ) -> Result<Vec<ActorEnrollment>, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .list_actor_enrollments_page(after_did, limit)
    }

    pub fn replace_pds_space_members(
        &self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
    ) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .replace_pds_space_members(boundary, members, reconciled_at)
    }
    pub fn pds_boundary_generation(&self, boundary: &str) -> Result<u64, StoreError> {
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .pds_boundary_generation(boundary)
    }
    pub fn pds_member_generation(
        &self,
        boundary: &str,
        did: &str,
    ) -> Result<Option<u64>, StoreError> {
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .pds_member_generation(boundary, did)
    }
    pub fn replace_pds_space_members_at_generation(
        &self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
        generation: u64,
    ) -> Result<std::collections::BTreeMap<String, u64>, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .replace_pds_space_members_at_generation(boundary, members, reconciled_at, generation)
    }

    /// The checkpoint a verified promotion builds on. A caller holding a
    /// generation that is no longer the member's current one is refused before
    /// it reads anything.
    pub fn verified_space_base_at_generation(
        &self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
        generation: u64,
    ) -> Result<Option<VerifiedSpaceBase>, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let projection = self.projection.lock().expect("projection lock poisoned");
        if projection.pds_member_generation(boundary, actor_did)? != Some(generation) {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        projection.verified_space_base(space_uri, actor_did)
    }

    pub fn promote_verified_space_repo(
        &self,
        target: &VerifiedSpaceTarget,
        base_rev: Option<&str>,
        commit: &MacVerifiedCommit,
        change_set: &ChangeSet,
        retained_at: &str,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .promote_verified_space_repo(
                target,
                base_rev,
                commit,
                change_set,
                retained_at,
                observed_at,
            )
    }

    pub fn replace_verified_space_repo(
        &self,
        target: &VerifiedSpaceTarget,
        commit: &MacVerifiedCommit,
        records: &[VerifiedSpaceRecord],
        retained_at: &str,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .replace_verified_space_repo(target, commit, records, retained_at, observed_at)
    }

    pub fn clear_verified_space_repo(
        &self,
        target: &VerifiedSpaceTarget,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .clear_verified_space_repo(target, observed_at)
    }

    pub fn pds_member_boundaries(&self, did: &str) -> Result<Vec<String>, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .pds_member_boundaries(did)
    }

    pub fn reconcile_actor_enrollment(
        &self,
        did: &str,
        observed_at: &str,
        enrollment: Option<ActorEnrollment>,
    ) -> Result<EnrollmentReconciliation, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let result = self
            .projection
            .lock()
            .expect("projection lock poisoned")
            .reconcile_actor_enrollment(did, observed_at, enrollment);
        if result.is_ok() && self.revoke_viewer_authorization_locked(did) {
            self.projection
                .lock()
                .expect("projection lock poisoned")
                .invalidate_viewer(did);
        }
        result
    }

    pub fn has_current_viewer_authorization(&self, did: &str, now: u64) -> bool {
        self.authorizations
            .lock()
            .expect("authorization lock poisoned")
            .current(did, now)
            .is_some()
    }

    pub fn apply_enrollment_event(
        &self,
        event: EnrollmentEvent,
    ) -> Result<EnrollmentReconciliation, StoreError> {
        let enrollment = match event.action {
            EnrollmentAction::Enroll | EnrollmentAction::BoundariesChanged => {
                Some(ActorEnrollment {
                    did: event.did.clone(),
                    boundaries: event.boundaries,
                    observed_at: event.observed_at.clone(),
                })
            }
            EnrollmentAction::Unenroll => None,
        };
        self.reconcile_actor_enrollment(&event.did, &event.observed_at, enrollment)
    }

    pub fn apply_viewer_authorization(
        &self,
        authorization: ViewerAuthorization,
        now: u64,
    ) -> Result<(), AuthorizationError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        // An answer resolved before the takedown, or by a Stratos process whose
        // cache is still stale, must not grant access while the takedown stands.
        let takedown_refusal = match projection.is_account_taken_down(&authorization.did) {
            Ok(false) => None,
            Ok(true) => Some(AuthorizationError::AccountTakenDown),
            Err(_) => Some(AuthorizationError::TakedownStateUnavailable),
        };
        if let Some(refusal) = takedown_refusal {
            if self.revoke_viewer_authorization_locked(&authorization.did) {
                projection.invalidate_viewer(&authorization.did);
            }
            return Err(refusal);
        }
        let result = self
            .authorizations
            .lock()
            .expect("authorization lock poisoned")
            .replace(authorization.clone(), now);
        if result.is_ok()
            || matches!(
                &result,
                Err(AuthorizationError::CapacityExceeded
                    | AuthorizationError::Expired
                    | AuthorizationError::EmptyBoundary)
            )
        {
            projection.invalidate_viewer(&authorization.did);
        }
        result
    }

    fn revoke_viewer_authorization_locked(&self, did: &str) -> bool {
        self.authorizations
            .lock()
            .expect("authorization lock poisoned")
            .revoke(did)
            .is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use crate::{
        authorization::{AuthorizationError, ViewerAuthorization, ViewerAuthorizations},
        feeds::{FeedDescription, FeedRegistry},
        lifecycle::{ActorFrameError, ActorFrameResult, ControlLifecycle},
        readiness::{FeedReadinessGate, ReconciliationOutcome},
        service::{ProjectionReader, ReadRequest},
        service_event::{EnrollmentAction, EnrollmentEvent},
        store::{ActorEnrollment, ActorPage, EncryptedStore, ProjectionPost, StorageKey},
        telemetry::FeedTelemetry,
    };

    fn request() -> ReadRequest<'static> {
        ReadRequest {
            viewer: "did:plc:faye",
            boundary: "bebop",
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-03T00:00:00.000Z",
        }
    }

    #[test]
    fn opens_reads_only_after_the_current_reconciliation_succeeds() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::clone(&readiness),
        );

        lifecycle.session_established();
        lifecycle.mark_labels_current();
        assert!(lifecycle.read(|projection| projection.prepare(request()).unwrap().is_none()));

        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        assert!(readiness.lock().unwrap().is_ready());
        assert!(lifecycle.read(|projection| projection.prepare(request()).unwrap().is_some()));
        lifecycle.begin_reconciliation();
        assert!(lifecycle.read(|projection| projection.prepare(request()).unwrap().is_none()));
    }

    #[test]
    fn closes_reads_on_failed_or_lost_control_state() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            readiness,
        );
        lifecycle.session_established();
        let failed = lifecycle.begin_reconciliation();
        assert!(!lifecycle.complete_reconciliation(
            failed,
            ReconciliationOutcome {
                errors: 1,
                truncated: false,
            },
        ));
        assert!(lifecycle.read(|projection| projection.prepare(request()).unwrap().is_none()));

        lifecycle.mark_unavailable();
        assert!(!lifecycle.complete_reconciliation(
            failed,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        assert!(lifecycle.read(|projection| projection.prepare(request()).unwrap().is_none()));
    }

    #[test]
    fn rejects_a_late_successful_reconciliation_after_timeout_closure() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::clone(&readiness),
        );
        lifecycle.session_established();
        let generation = lifecycle.begin_reconciliation();

        lifecycle.mark_unavailable();
        assert!(!lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        assert!(!readiness.lock().unwrap().is_ready());
        assert!(lifecycle.read(|projection| projection.prepare(request()).unwrap().is_none()));
    }

    #[test]
    fn authority_authorization_changes_invalidate_prepared_viewer_reads() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            readiness,
        );
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        let (token, page) =
            lifecycle.read(|projection| projection.prepare(request()).unwrap().unwrap());

        lifecycle
            .apply_viewer_authorization(
                crate::authorization::ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: Vec::new(),
                    expires_at: 100,
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

        assert!(lifecycle.read(|projection| projection.release(token, page, 2).is_none()));
    }

    #[test]
    fn blob_reads_require_a_configured_boundary_and_recheck_the_admission_token() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .apply_actor_page(ActorPage {
                authority_did: "did:web:stratos.example".to_owned(),
                actor_did: "did:plc:spike".to_owned(),
                sequence: 1,
                upserts: vec![ProjectionPost {
                    uri: "at://did:plc:spike/zone.stratos.feed.post/see-you".to_owned(),
                    author_did: "did:plc:spike".to_owned(),
                    cid: "bafyrecord".to_owned(),
                    sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
                    indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
                    retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
                    record_json: b"{}".to_vec(),
                    blob_refs_json: b"[]".to_vec(),
                    boundaries: vec!["bebop".to_owned()],
                }],
                deletes: Vec::new(),
                updated_at: "1998-04-03T00:00:02.000Z".to_owned(),
                interactions: crate::store::InteractionChanges::default(),
            })
            .unwrap();
        let lifecycle = ControlLifecycle::new(ProjectionReader::new(store), readiness);
        let feeds = FeedRegistry::new([FeedDescription {
            id: "bebop".to_owned(),
            boundary: "bebop".to_owned(),
            display_name: None,
            description: None,
        }])
        .unwrap();
        lifecycle
            .apply_viewer_authorization(
                ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));

        let (token, _) = lifecycle
            .prepare_viewer_blob(
                "did:plc:faye",
                &feeds,
                "at://did:plc:spike/zone.stratos.feed.post/see-you",
                1,
                "1998-04-03T00:00:00.000Z",
            )
            .unwrap()
            .unwrap();
        assert!(lifecycle
            .prepare_viewer_blob(
                "did:plc:faye",
                &feeds,
                "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:spike/zone.stratos.feed.post/see-you",
                1,
                "1998-04-03T00:00:00.000Z",
            )
            .unwrap()
            .is_none());
        lifecycle
            .apply_viewer_authorization(
                ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: Vec::new(),
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        assert!(lifecycle.release_blob(token, (), 1).is_none());
    }

    #[test]
    fn rejected_authorization_replacements_invalidate_prepared_viewer_reads() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::with_authorizations(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            readiness,
            ViewerAuthorizations::new(310),
            None,
            Arc::new(FeedTelemetry::disabled()),
        );
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        lifecycle
            .apply_viewer_authorization(
                ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        let (token, page) =
            lifecycle.read(|projection| projection.prepare(request()).unwrap().unwrap());

        assert_eq!(
            lifecycle.apply_viewer_authorization(
                ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["a-very-long-boundary".to_owned()],
                    expires_at: 100,
                },
                1,
            ),
            Err(AuthorizationError::CapacityExceeded)
        );
        assert!(lifecycle.read(|projection| projection.release(token, page, 2).is_none()));
    }

    #[test]
    fn unavailable_lifecycle_transition_closes_the_telemetry_readiness_gauge() {
        let telemetry = Arc::new(FeedTelemetry::disabled());
        let lifecycle = ControlLifecycle::for_authority_with_telemetry(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            "did:plc:spike",
            Arc::clone(&telemetry),
        )
        .unwrap();
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        assert!(telemetry.is_ready());
        lifecycle.mark_unavailable();
        assert!(!telemetry.is_ready());
    }

    #[test]
    fn read_timeout_transition_preserves_the_service_connection_gauge() {
        let telemetry = Arc::new(FeedTelemetry::disabled());
        let lifecycle = ControlLifecycle::for_authority_with_telemetry(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            "did:plc:spike",
            Arc::clone(&telemetry),
        )
        .unwrap();
        lifecycle.session_established();
        lifecycle.mark_read_unavailable();
        assert!(telemetry.is_service_connected());
        assert!(!telemetry.is_ready());
        lifecycle.mark_unavailable();
        assert!(!telemetry.is_service_connected());
    }

    #[test]
    fn serves_only_with_a_current_viewer_authorization() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            readiness,
        );
        lifecycle
            .apply_viewer_authorization(
                ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));

        let feeds = crate::feeds::FeedRegistry::new([crate::feeds::FeedDescription {
            id: "bebop".to_owned(),
            boundary: "bebop".to_owned(),
            display_name: None,
            description: None,
        }])
        .unwrap();
        let query = crate::feed_service::FeedQuery {
            feed_id: "bebop",
            cursor: None,
            limit: 50,
            now: 2,
            as_of: "1998-04-03T00:00:00.000Z",
            blob_base_url: "https://feedgen.example.test",
        };
        assert!(
            lifecycle
                .serve_viewer_feed("did:plc:faye", &feeds, query)
                .is_ok()
        );
        let expired = crate::feed_service::FeedQuery { now: 100, ..query };
        assert!(matches!(
            lifecycle.serve_viewer_feed("did:plc:faye", &feeds, expired),
            Err(crate::feed_service::FeedServiceError::AuthorizationUnavailable)
        ));
    }

    #[test]
    fn enrollment_events_replace_durable_boundaries_and_invalidate_reads() {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::clone(&readiness),
        );
        lifecycle
            .apply_enrollment_event(EnrollmentEvent {
                did: "did:plc:spike".to_owned(),
                action: EnrollmentAction::Enroll,
                boundaries: vec!["crew".to_owned()],
                observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
            })
            .unwrap();
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        let crew_request = ReadRequest {
            boundary: "crew",
            ..request()
        };
        let (token, page) =
            lifecycle.read(|projection| projection.prepare(crew_request).unwrap().unwrap());

        lifecycle
            .apply_enrollment_event(EnrollmentEvent {
                did: "did:plc:spike".to_owned(),
                action: EnrollmentAction::BoundariesChanged,
                boundaries: vec!["bebop".to_owned()],
                observed_at: "1998-04-03T00:00:01.000Z".to_owned(),
            })
            .unwrap();

        assert!(lifecycle.read(|projection| projection.release(token, page, 2).is_none()));
        assert_eq!(
            lifecycle.list_actor_enrollments_page(None, 1).unwrap()[0].boundaries,
            ["bebop"]
        );
    }

    #[test]
    fn applies_only_current_authority_actor_frames_without_advancing_invalid_cursors() {
        let lifecycle = ControlLifecycle::for_authority(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            "did:web:stratos.example.test",
        )
        .unwrap();
        lifecycle
            .reconcile_actor_enrollment(
                "did:plc:faye",
                "1998-04-03T00:00:00.000Z",
                Some(crate::store::ActorEnrollment {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["did:web:stratos.example.test/bebop".to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        let header = serde_cbor::to_vec(&serde_json::json!({"t":"#commit"})).unwrap();
        let valid_body = serde_cbor::to_vec(&serde_json::json!({
            "seq":7,
            "did":"did:plc:faye",
            "time":"1998-04-03T00:00:00.000Z",
            "rev":"3jzfcijpj2z2a",
            "ops":[{"action":"create","path":"zone.stratos.feed.post/see-you","cid":"bafyreia","record":{"$type":"zone.stratos.feed.post","boundary":{"values":[{"value":"bebop"}]}}}]
        })).unwrap();
        let mut valid = header.clone();
        valid.extend(valid_body);
        assert!(matches!(
            lifecycle.apply_actor_frame(
                &valid,
                "did:web:stratos.example.test",
                "did:plc:faye",
                "1998-05-03T00:00:00.000Z",
            ),
            Ok(ActorFrameResult::Applied)
        ));
        assert_eq!(
            lifecycle
                .actor_sync_state("did:web:stratos.example.test", "did:plc:faye")
                .unwrap()
                .unwrap()
                .cursor,
            Some(7)
        );
        let info = serde_cbor::to_vec(&serde_json::json!({"t":"#info"})).unwrap();
        assert!(matches!(
            lifecycle.apply_actor_frame(
                &info,
                "did:web:stratos.example.test",
                "did:plc:faye",
                "1998-05-03T00:00:00.000Z",
            ),
            Ok(ActorFrameResult::Ignored)
        ));
        let invalid_body = serde_cbor::to_vec(&serde_json::json!({
            "seq":8,
            "did":"did:plc:faye",
            "time":"1998-04-03T00:00:00.000Z",
            "rev":"3jzfcijpj2z2a",
            "ops":[{"action":"update","path":"zone.stratos.feed.post/see-you","record":{"$type":"zone.stratos.feed.post"}}]
        })).unwrap();
        let mut invalid = header;
        invalid.extend(invalid_body);
        assert!(matches!(
            lifecycle.apply_actor_frame(
                &invalid,
                "did:web:stratos.example.test",
                "did:plc:faye",
                "1998-05-03T00:00:00.000Z",
            ),
            Err(ActorFrameError::Event(_))
        ));
        assert_eq!(
            lifecycle
                .actor_sync_state("did:web:stratos.example.test", "did:plc:faye")
                .unwrap()
                .unwrap()
                .cursor,
            Some(7)
        );
        assert!(matches!(
            lifecycle.apply_actor_frame(
                &valid,
                "did:web:other.example.test",
                "did:plc:faye",
                "1998-05-03T00:00:00.000Z",
            ),
            Err(ActorFrameError::Event(_))
        ));
        lifecycle
            .reconcile_actor_enrollment("did:plc:faye", "1998-04-03T00:00:01.000Z", None)
            .unwrap();
        assert!(matches!(
            lifecycle.apply_actor_frame(
                b"not cbor",
                "did:web:stratos.example.test",
                "did:plc:faye",
                "1998-05-03T00:00:00.000Z",
            ),
            Ok(ActorFrameResult::NotEnrolled)
        ));
    }

    #[test]
    fn serves_a_post_whose_boundary_is_only_on_the_operation_to_viewers_in_that_boundary() {
        let authority = "did:web:stratos.example.test";
        let bebop = "did:web:stratos.example.test/bebop";
        let swordfish = "did:web:stratos.example.test/swordfish";
        let lifecycle = ControlLifecycle::for_authority(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            authority,
        )
        .unwrap();
        lifecycle
            .reconcile_actor_enrollment(
                "did:plc:faye",
                "1998-04-03T00:00:00.000Z",
                Some(crate::store::ActorEnrollment {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec![bebop.to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        for (viewer, boundary) in [
            ("did:plc:spikespiegel", bebop),
            ("did:plc:jetblack", swordfish),
        ] {
            lifecycle
                .apply_viewer_authorization(
                    ViewerAuthorization {
                        did: viewer.to_owned(),
                        boundaries: vec![boundary.to_owned()],
                        expires_at: 100,
                    },
                    1,
                )
                .unwrap();
        }
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));

        let header = serde_cbor::to_vec(&serde_json::json!({"t":"#commit"})).unwrap();
        let body = serde_cbor::to_vec(&serde_json::json!({
            "seq":7,
            "did":"did:plc:faye",
            "time":"1998-04-03T00:00:00.000Z",
            "rev":"3jzfcijpj2z2a",
            "ops":[{
                "action":"create",
                "path":"zone.stratos.feed.post/see-you",
                "cid":"bafyreia",
                "record":{"$type":"zone.stratos.feed.post","createdAt":"1998-04-03T00:00:00.000Z","text":"see you space cowboy"},
                "boundary":{"values":[{"value":"bebop"}]}
            }]
        }))
        .unwrap();
        let mut frame = header;
        frame.extend(body);
        assert!(matches!(
            lifecycle.apply_actor_frame(
                &frame,
                authority,
                "did:plc:faye",
                "1998-05-03T00:00:00.000Z",
            ),
            Ok(ActorFrameResult::Applied)
        ));

        let feeds = FeedRegistry::new([
            FeedDescription {
                id: "bebop".to_owned(),
                boundary: bebop.to_owned(),
                display_name: None,
                description: None,
            },
            FeedDescription {
                id: "swordfish".to_owned(),
                boundary: swordfish.to_owned(),
                display_name: None,
                description: None,
            },
        ])
        .unwrap();
        let query = |feed_id| crate::feed_service::FeedQuery {
            feed_id,
            cursor: None,
            limit: 50,
            now: 2,
            as_of: "1998-04-03T00:00:00.000Z",
            blob_base_url: "https://feedgen.example.test",
        };

        let (served, served_count) = lifecycle
            .serve_viewer_feed("did:plc:spikespiegel", &feeds, query("bebop"))
            .unwrap();
        assert_eq!(served_count, 1);
        let served: serde_json::Value = serde_json::from_slice(&served).unwrap();
        assert_eq!(
            served["feed"][0]["post"]["uri"],
            "at://did:plc:faye/zone.stratos.feed.post/see-you"
        );
        assert_eq!(
            served["feed"][0]["post"]["boundaries"],
            serde_json::json!([bebop])
        );

        assert!(matches!(
            lifecycle.serve_viewer_feed("did:plc:jetblack", &feeds, query("bebop")),
            Err(crate::feed_service::FeedServiceError::BoundaryMismatch)
        ));
        let (_, other_boundary_count) = lifecycle
            .serve_viewer_feed("did:plc:jetblack", &feeds, query("swordfish"))
            .unwrap();
        assert_eq!(other_boundary_count, 0);
    }

    fn lifecycle_with_telemetry() -> (
        ControlLifecycle,
        Arc<Mutex<FeedReadinessGate>>,
        Arc<FeedTelemetry>,
    ) {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let telemetry = Arc::new(FeedTelemetry::disabled());
        let lifecycle = ControlLifecycle::for_authority_with_telemetry(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::clone(&readiness),
            "did:plc:spike",
            Arc::clone(&telemetry),
        )
        .unwrap();
        (lifecycle, readiness, telemetry)
    }

    fn reconcile_cleanly(lifecycle: &ControlLifecycle) {
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
    }

    #[test]
    fn reads_stay_closed_until_labels_and_reconciliation_are_both_current() {
        let (lifecycle, readiness, telemetry) = lifecycle_with_telemetry();
        lifecycle.session_established();
        reconcile_cleanly(&lifecycle);
        assert!(!readiness.lock().unwrap().is_ready());
        assert!(!telemetry.is_ready());

        lifecycle.mark_labels_current();
        assert!(readiness.lock().unwrap().is_ready());
        assert!(telemetry.is_ready());

        let (lifecycle, readiness, telemetry) = lifecycle_with_telemetry();
        lifecycle.mark_labels_current();
        assert!(!readiness.lock().unwrap().is_ready());
        assert!(!telemetry.is_ready());
        lifecycle.session_established();
        reconcile_cleanly(&lifecycle);
        assert!(readiness.lock().unwrap().is_ready());
        assert!(telemetry.is_ready());
    }

    #[test]
    fn stale_labels_close_reads_until_the_log_catches_up_again() {
        let (lifecycle, readiness, telemetry) = lifecycle_with_telemetry();
        lifecycle.mark_labels_current();
        lifecycle.session_established();
        reconcile_cleanly(&lifecycle);
        assert!(telemetry.is_ready());

        lifecycle.mark_labels_stale();
        assert!(!readiness.lock().unwrap().is_ready());
        assert!(!telemetry.is_ready());

        lifecycle.mark_labels_current();
        assert!(readiness.lock().unwrap().is_ready());
        assert!(telemetry.is_ready());
    }

    #[test]
    fn a_service_reconnect_reopens_without_relearning_label_currency() {
        let (lifecycle, readiness, _telemetry) = lifecycle_with_telemetry();
        lifecycle.mark_labels_current();
        lifecycle.session_established();
        reconcile_cleanly(&lifecycle);
        assert!(readiness.lock().unwrap().is_ready());

        lifecycle.mark_unavailable();
        assert!(!readiness.lock().unwrap().is_ready());

        lifecycle.session_established();
        reconcile_cleanly(&lifecycle);
        assert!(readiness.lock().unwrap().is_ready());
    }

    #[test]
    fn an_account_takedown_revokes_that_accounts_viewer_authorization() {
        let (lifecycle, _readiness, _telemetry) = lifecycle_with_telemetry();
        for did in ["did:plc:spike", "did:plc:faye"] {
            lifecycle
                .apply_viewer_authorization(
                    ViewerAuthorization {
                        did: did.to_owned(),
                        boundaries: vec!["bebop".to_owned()],
                        expires_at: 100,
                    },
                    1,
                )
                .unwrap();
        }

        lifecycle
            .apply_label_page(
                &crate::moderation_label::LabelPage {
                    cursor: 1,
                    labels: vec![crate::moderation_label::ModerationLabel {
                        seq: 1,
                        subject: crate::moderation_label::LabelSubject::Account {
                            did: "did:plc:spike".to_owned(),
                        },
                        neg: false,
                    }],
                    skipped_subjects: 0,
                },
                "2026-11-01T00:00:00.000Z",
            )
            .unwrap();

        assert!(!lifecycle.has_current_viewer_authorization("did:plc:spike", 2));
        assert!(lifecycle.has_current_viewer_authorization("did:plc:faye", 2));
    }

    const BEBOP_AUTHORITY: &str = "did:web:stratos.example.test";
    const SPIKESPIEGEL: &str = "did:plc:spikespiegel";
    const SPIKE_BLOB_POST: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1";
    const SPIKE_ENROLLED_AT: &str = "1998-04-03T00:00:00.000Z";
    const BEFORE_RETENTION_ENDS: &str = "1998-04-03T12:00:00.000Z";
    const TAKEDOWN_RECORDED_AT: &str = "2026-11-01T00:00:00.000Z";

    fn bebop_feeds() -> FeedRegistry {
        FeedRegistry::new([FeedDescription {
            id: "bebop".to_owned(),
            boundary: "bebop".to_owned(),
            display_name: None,
            description: None,
        }])
        .unwrap()
    }

    fn account_label_page(
        cursor: u64,
        sequence: u64,
        negated: bool,
    ) -> crate::moderation_label::LabelPage {
        crate::moderation_label::LabelPage {
            cursor,
            labels: vec![crate::moderation_label::ModerationLabel {
                seq: sequence,
                subject: crate::moderation_label::LabelSubject::Account {
                    did: SPIKESPIEGEL.to_owned(),
                },
                neg: negated,
            }],
            skipped_subjects: 0,
        }
    }

    fn lifecycle_serving_a_member_with_a_blob_post() -> ControlLifecycle {
        let lifecycle = ControlLifecycle::for_authority(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            BEBOP_AUTHORITY,
        )
        .unwrap();
        lifecycle
            .reconcile_actor_enrollment(
                SPIKESPIEGEL,
                SPIKE_ENROLLED_AT,
                Some(ActorEnrollment {
                    did: SPIKESPIEGEL.to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: SPIKE_ENROLLED_AT.to_owned(),
                }),
            )
            .unwrap();
        lifecycle
            .apply_actor_page(ActorPage {
                authority_did: BEBOP_AUTHORITY.to_owned(),
                actor_did: SPIKESPIEGEL.to_owned(),
                sequence: 1,
                upserts: vec![ProjectionPost {
                    uri: SPIKE_BLOB_POST.to_owned(),
                    author_did: SPIKESPIEGEL.to_owned(),
                    cid: "bafyrecord".to_owned(),
                    sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
                    indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
                    retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
                    record_json: b"{}".to_vec(),
                    blob_refs_json: serde_json::to_vec(&serde_json::json!([
                        { "cid": "bafkreiswordfish", "mimeType": "image/png" }
                    ]))
                    .unwrap(),
                    boundaries: vec!["bebop".to_owned()],
                }],
                deletes: Vec::new(),
                updated_at: "1998-04-03T00:00:02.000Z".to_owned(),
                interactions: crate::store::InteractionChanges::default(),
            })
            .unwrap();
        lifecycle
            .apply_viewer_authorization(
                ViewerAuthorization {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        reconcile_cleanly(&lifecycle);
        lifecycle
    }

    fn blob_route_serves(lifecycle: &ControlLifecycle) -> bool {
        lifecycle
            .prepare_viewer_blob(
                "did:plc:faye",
                &bebop_feeds(),
                SPIKE_BLOB_POST,
                1,
                BEFORE_RETENTION_ENDS,
            )
            .unwrap()
            .is_some()
    }

    #[test]
    fn the_blob_route_serves_no_post_of_a_taken_down_account() {
        let lifecycle = lifecycle_serving_a_member_with_a_blob_post();
        assert!(blob_route_serves(&lifecycle));

        lifecycle
            .apply_label_page(&account_label_page(1, 1, false), TAKEDOWN_RECORDED_AT)
            .unwrap();

        assert!(!blob_route_serves(&lifecycle));
    }

    fn viewer_account_label_page(cursor: u64, negated: bool) -> crate::moderation_label::LabelPage {
        crate::moderation_label::LabelPage {
            cursor,
            labels: vec![crate::moderation_label::ModerationLabel {
                seq: cursor,
                subject: crate::moderation_label::LabelSubject::Account {
                    did: FAYE.to_owned(),
                },
                neg: negated,
            }],
            skipped_subjects: 0,
        }
    }

    fn enrolled_answer_for_faye(lifecycle: &ControlLifecycle) -> Result<(), AuthorizationError> {
        lifecycle.apply_viewer_authorization(
            ViewerAuthorization {
                did: FAYE.to_owned(),
                boundaries: vec!["bebop".to_owned()],
                expires_at: 100,
            },
            1,
        )
    }

    fn faye_feed(
        lifecycle: &ControlLifecycle,
    ) -> Result<(), crate::feed_service::FeedServiceError> {
        lifecycle
            .serve_viewer_feed(
                FAYE,
                &bebop_feeds(),
                crate::feed_service::FeedQuery {
                    feed_id: "bebop",
                    cursor: None,
                    limit: 50,
                    now: 1,
                    as_of: BEFORE_RETENTION_ENDS,
                    blob_base_url: "https://feedgen.example.test",
                },
            )
            .map(|_| ())
    }

    #[test]
    fn an_enrolled_answer_for_a_viewer_under_account_takedown_installs_no_access() {
        let lifecycle = lifecycle_serving_a_member_with_a_blob_post();
        lifecycle
            .apply_label_page(&viewer_account_label_page(1, false), TAKEDOWN_RECORDED_AT)
            .unwrap();

        let late_answer = enrolled_answer_for_faye(&lifecycle);

        assert!(late_answer.is_err());
        assert!(!lifecycle.has_current_viewer_authorization(FAYE, 1));
        assert!(matches!(
            faye_feed(&lifecycle),
            Err(crate::feed_service::FeedServiceError::AuthorizationUnavailable)
        ));
        assert!(matches!(
            lifecycle.prepare_viewer_blob(
                FAYE,
                &bebop_feeds(),
                SPIKE_BLOB_POST,
                1,
                BEFORE_RETENTION_ENDS
            ),
            Err(crate::feed_service::FeedServiceError::AuthorizationUnavailable)
        ));

        lifecycle
            .apply_label_page(&viewer_account_label_page(2, true), TAKEDOWN_RECORDED_AT)
            .unwrap();

        assert_eq!(enrolled_answer_for_faye(&lifecycle), Ok(()));
        assert!(faye_feed(&lifecycle).is_ok());
        assert!(blob_route_serves(&lifecycle));
    }

    #[test]
    fn a_replayed_enroll_older_than_the_stored_observation_is_stale_while_reinstating() {
        let lifecycle = lifecycle_serving_a_member_with_a_blob_post();
        lifecycle
            .apply_label_page(&account_label_page(1, 1, false), TAKEDOWN_RECORDED_AT)
            .unwrap();
        lifecycle
            .apply_label_page(&account_label_page(2, 2, true), TAKEDOWN_RECORDED_AT)
            .unwrap();
        assert_eq!(
            lifecycle.reinstating_accounts(10).unwrap(),
            [(SPIKESPIEGEL.to_owned(), 0)]
        );

        let replay = lifecycle.apply_enrollment_event(EnrollmentEvent {
            did: SPIKESPIEGEL.to_owned(),
            action: EnrollmentAction::Enroll,
            boundaries: vec!["bebop".to_owned()],
            observed_at: "2026-10-31T00:00:00.000Z".to_owned(),
        });

        assert!(matches!(replay, Err(crate::store::StoreError::StaleCursor)));
        assert_eq!(
            lifecycle
                .actor_sync_state(BEBOP_AUTHORITY, SPIKESPIEGEL)
                .unwrap(),
            None
        );
    }

    const ACTOR_AUTHORITY: &str = "did:web:stratos.example.test";
    const ACTOR_BEBOP: &str = "did:web:stratos.example.test/bebop";
    const FAYE: &str = "did:plc:faye";
    const RETAINED_AT: &str = "1998-05-03T00:00:00.000Z";
    const LIKE: &str = "app.bsky.feed.like";
    const REPOST: &str = "app.bsky.feed.repost";
    const FAYE_LIKE_SUBJECT: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/swordfish";

    fn faye_uri(collection: &str, rkey: &str) -> String {
        format!("at://{FAYE}/{collection}/{rkey}")
    }

    fn enrolled_lifecycle() -> ControlLifecycle {
        let lifecycle = ControlLifecycle::for_authority(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            ACTOR_AUTHORITY,
        )
        .unwrap();
        lifecycle
            .reconcile_actor_enrollment(
                FAYE,
                "1998-04-03T00:00:00.000Z",
                Some(ActorEnrollment {
                    did: FAYE.to_owned(),
                    boundaries: vec![ACTOR_BEBOP.to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        lifecycle
    }

    fn commit_frame(sequence: u64, ops: serde_json::Value) -> Vec<u8> {
        let mut bytes = serde_cbor::to_vec(&serde_json::json!({"t": "#commit"})).unwrap();
        bytes.extend(
            serde_cbor::to_vec(&serde_json::json!({
                "seq": sequence,
                "did": FAYE,
                "time": "1998-04-03T00:00:00.000Z",
                "rev": "3jzfcijpj2z2a",
                "ops": ops,
            }))
            .unwrap(),
        );
        bytes
    }

    fn like_create_ops(rkey: &str) -> serde_json::Value {
        serde_json::json!([{
            "action": "create",
            "path": format!("app.bsky.feed.like/{rkey}"),
            "cid": "bafyreia",
            "record": {
                "$type": LIKE,
                "subject": {"uri": FAYE_LIKE_SUBJECT, "cid": "bafyreib"},
                "boundary": {"values": [{"value": "bebop"}]},
            },
        }])
    }

    fn apply(lifecycle: &ControlLifecycle, frame: &[u8]) -> ActorFrameResult {
        lifecycle
            .apply_actor_frame(frame, ACTOR_AUTHORITY, FAYE, RETAINED_AT)
            .unwrap()
    }

    fn faye_cursor(lifecycle: &ControlLifecycle) -> Option<u64> {
        lifecycle
            .actor_sync_state(ACTOR_AUTHORITY, FAYE)
            .unwrap()
            .unwrap()
            .cursor
    }

    #[test]
    fn a_like_frame_is_stored_and_a_later_delete_frame_removes_it() {
        let lifecycle = enrolled_lifecycle();

        assert!(matches!(
            apply(&lifecycle, &commit_frame(7, like_create_ops("one"))),
            ActorFrameResult::Applied
        ));
        assert_eq!(
            lifecycle.read(|projection| projection.interaction_rows()),
            [(
                faye_uri(LIKE, "one"),
                "like".to_owned(),
                FAYE_LIKE_SUBJECT.to_owned(),
                ACTOR_BEBOP.to_owned()
            )]
        );
        assert_eq!(faye_cursor(&lifecycle), Some(7));

        let delete = commit_frame(
            8,
            serde_json::json!([{"action": "delete", "path": "app.bsky.feed.like/one"}]),
        );
        assert!(matches!(
            apply(&lifecycle, &delete),
            ActorFrameResult::Applied
        ));
        assert!(
            lifecycle
                .read(|projection| projection.interaction_rows())
                .is_empty()
        );
        assert_eq!(faye_cursor(&lifecycle), Some(8));
    }

    #[test]
    fn a_malformed_like_frame_still_advances_the_cursor() {
        let lifecycle = enrolled_lifecycle();
        let malformed = commit_frame(
            7,
            serde_json::json!([{
                "action": "create",
                "path": "app.bsky.feed.like/one",
                "cid": "bafyreia",
                "record": {"$type": REPOST},
            }]),
        );

        assert!(matches!(
            apply(&lifecycle, &malformed),
            ActorFrameResult::Applied
        ));
        assert!(
            lifecycle
                .read(|projection| projection.interaction_rows())
                .is_empty()
        );
        assert_eq!(faye_cursor(&lifecycle), Some(7));
    }

    #[test]
    fn a_like_with_an_unreadable_action_beside_a_post_keeps_the_post_and_advances_the_cursor() {
        let lifecycle = enrolled_lifecycle();
        let post_uri = format!("at://{FAYE}/zone.stratos.feed.post/see-you");
        let frame = commit_frame(
            7,
            serde_json::json!([
                {
                    "action": "create",
                    "path": "zone.stratos.feed.post/see-you",
                    "cid": "bafyreia",
                    "record": {
                        "$type": "zone.stratos.feed.post",
                        "createdAt": "1998-04-03T00:00:00.000Z",
                        "boundary": {"values": [{"value": "bebop"}]},
                    },
                },
                {
                    "action": 7,
                    "path": "app.bsky.feed.like/one",
                    "cid": "bafyreib",
                    "record": {
                        "$type": LIKE,
                        "subject": {"uri": FAYE_LIKE_SUBJECT, "cid": "bafyreib"},
                        "boundary": {"values": [{"value": "bebop"}]},
                    },
                },
                {
                    "path": "app.bsky.feed.repost/two",
                    "cid": "bafyreic",
                    "record": {
                        "$type": REPOST,
                        "subject": {"uri": FAYE_LIKE_SUBJECT, "cid": "bafyreib"},
                        "boundary": {"values": [{"value": "bebop"}]},
                    },
                },
            ]),
        );

        assert!(matches!(
            apply(&lifecycle, &frame),
            ActorFrameResult::Applied
        ));

        let stored_post = lifecycle
            .read(|projection| projection.blob_post(&post_uri, "1998-04-03T00:00:00.000Z"))
            .unwrap()
            .expect("the post is stored");
        assert_eq!(stored_post.boundaries, [ACTOR_BEBOP]);
        assert!(
            lifecycle
                .read(|projection| projection.interaction_rows())
                .is_empty()
        );
        assert_eq!(faye_cursor(&lifecycle), Some(7));
    }

    #[test]
    fn a_replayed_frame_does_not_readmit_a_taken_down_like() {
        let lifecycle = enrolled_lifecycle();
        lifecycle
            .apply_label_page(
                &crate::moderation_label::LabelPage {
                    cursor: 1,
                    labels: vec![crate::moderation_label::ModerationLabel {
                        seq: 1,
                        subject: crate::moderation_label::LabelSubject::Record {
                            uri: faye_uri(LIKE, "one"),
                            author_did: FAYE.to_owned(),
                        },
                        neg: false,
                    }],
                    skipped_subjects: 0,
                },
                "1998-04-03T00:00:00.000Z",
            )
            .unwrap();

        for _ in 0..2 {
            assert!(matches!(
                apply(&lifecycle, &commit_frame(7, like_create_ops("one"))),
                ActorFrameResult::Applied
            ));
        }
        assert!(matches!(
            apply(&lifecycle, &commit_frame(8, like_create_ops("two"))),
            ActorFrameResult::Applied
        ));

        let stored = lifecycle.read(|projection| projection.interaction_rows());
        assert_eq!(
            stored.iter().map(|row| row.0.clone()).collect::<Vec<_>>(),
            [faye_uri(LIKE, "two")]
        );
        assert_eq!(faye_cursor(&lifecycle), Some(8));
    }

    const CREW: &str = "did:web:bebop.example/crew";
    const CREW_SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/crew";
    const MEMBER: &str = "did:plc:fayevalentine";
    const FIRST_REV: &str = "3jzfcijpj2z2a";
    const OBSERVED: &str = "2026-09-22T00:00:00.000Z";
    const RETAINED: &str = "2026-09-23T00:00:00.000Z";

    fn lifecycle_with_member() -> (ControlLifecycle, crate::store::VerifiedSpaceTarget) {
        let lifecycle = ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
        );
        lifecycle
            .replace_pds_space_members(
                CREW,
                vec![crate::store::PdsSpaceMember {
                    did: MEMBER.to_owned(),
                }],
                OBSERVED,
            )
            .unwrap();
        let target = crate::store::VerifiedSpaceTarget {
            boundary: CREW.to_owned(),
            space_uri: CREW_SPACE.to_owned(),
            actor_did: MEMBER.to_owned(),
            host: "https://pds.bebop.example".to_owned(),
            generation: lifecycle
                .pds_member_generation(CREW, MEMBER)
                .unwrap()
                .unwrap(),
        };
        (lifecycle, target)
    }

    fn empty_repo_commit() -> crate::space_mac::MacVerifiedCommit {
        crate::space_mac::MacVerifiedCommit::for_tests(
            MEMBER,
            CREW_SPACE,
            FIRST_REV,
            crate::space_set_hash::SetHashState::empty().digest(),
        )
    }

    #[test]
    fn a_verified_replacement_reaches_the_store_and_its_base_can_be_read_back() {
        let (lifecycle, target) = lifecycle_with_member();
        assert_eq!(
            lifecycle
                .verified_space_base_at_generation(CREW, CREW_SPACE, MEMBER, target.generation)
                .unwrap(),
            None
        );

        lifecycle
            .replace_verified_space_repo(&target, &empty_repo_commit(), &[], RETAINED, OBSERVED)
            .unwrap();

        let base = lifecycle
            .verified_space_base_at_generation(CREW, CREW_SPACE, MEMBER, target.generation)
            .unwrap()
            .unwrap();
        assert_eq!(base.rev, FIRST_REV);
        assert_eq!(base.host, "https://pds.bebop.example");
    }

    #[test]
    fn a_verified_promotion_reaches_the_store() {
        let (lifecycle, target) = lifecycle_with_member();
        let change_set =
            crate::space_ops::ChangeSet::apply(crate::space_set_hash::SetHashState::empty(), &[])
                .unwrap();

        lifecycle
            .promote_verified_space_repo(
                &target,
                None,
                &empty_repo_commit(),
                &change_set,
                RETAINED,
                OBSERVED,
            )
            .unwrap();

        let base = lifecycle
            .verified_space_base_at_generation(CREW, CREW_SPACE, MEMBER, target.generation)
            .unwrap()
            .unwrap();
        assert_eq!(base.rev, FIRST_REV);
        let stale = lifecycle.promote_verified_space_repo(
            &target,
            None,
            &empty_repo_commit(),
            &change_set,
            RETAINED,
            OBSERVED,
        );
        assert!(
            matches!(stale, Err(crate::store::StoreError::SpaceRepoBaseMoved)),
            "{stale:?}"
        );
    }

    const BRIDGE_SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/bridge";

    fn bridge_target_and_commit(
        target: crate::store::VerifiedSpaceTarget,
    ) -> (
        crate::store::VerifiedSpaceTarget,
        crate::space_mac::MacVerifiedCommit,
    ) {
        let commit = crate::space_mac::MacVerifiedCommit::for_tests(
            MEMBER,
            BRIDGE_SPACE,
            FIRST_REV,
            crate::space_set_hash::SetHashState::empty().digest(),
        );
        let target = crate::store::VerifiedSpaceTarget {
            space_uri: BRIDGE_SPACE.to_owned(),
            ..target
        };
        (target, commit)
    }

    fn crew_request() -> ReadRequest<'static> {
        ReadRequest {
            boundary: CREW,
            ..request()
        }
    }

    #[test]
    fn a_verified_promotion_into_a_space_its_boundary_does_not_name_leaves_reads_valid() {
        let (lifecycle, crew_target) = lifecycle_with_member();
        let (target, commit) = bridge_target_and_commit(crew_target);
        let change_set =
            crate::space_ops::ChangeSet::apply(crate::space_set_hash::SetHashState::empty(), &[])
                .unwrap();
        let (token, page) = {
            let mut projection = lifecycle.projection.lock().unwrap();
            projection.establish_session();
            projection.prepare(crew_request()).unwrap().unwrap()
        };

        let outcome = lifecycle.promote_verified_space_repo(
            &target,
            None,
            &commit,
            &change_set,
            RETAINED,
            OBSERVED,
        );

        assert!(
            matches!(outcome, Err(crate::store::StoreError::SpaceRepoInvalid)),
            "{outcome:?}"
        );
        assert!(lifecycle.read(|projection| projection.release(token, page, 2).is_some()));
    }

    #[test]
    fn a_verified_replacement_into_a_space_its_boundary_does_not_name_leaves_reads_valid() {
        let (lifecycle, crew_target) = lifecycle_with_member();
        let (target, commit) = bridge_target_and_commit(crew_target);
        let (token, page) = {
            let mut projection = lifecycle.projection.lock().unwrap();
            projection.establish_session();
            projection.prepare(crew_request()).unwrap().unwrap()
        };

        let outcome =
            lifecycle.replace_verified_space_repo(&target, &commit, &[], RETAINED, OBSERVED);

        assert!(
            matches!(outcome, Err(crate::store::StoreError::SpaceRepoInvalid)),
            "{outcome:?}"
        );
        assert!(lifecycle.read(|projection| projection.release(token, page, 2).is_some()));
    }

    #[test]
    fn reading_the_base_under_a_stale_generation_is_refused() {
        let (lifecycle, target) = lifecycle_with_member();

        let outcome = lifecycle.verified_space_base_at_generation(
            CREW,
            CREW_SPACE,
            MEMBER,
            target.generation + 1,
        );

        assert!(
            matches!(
                outcome,
                Err(crate::store::StoreError::UnauthorizedSpaceMember)
            ),
            "{outcome:?}"
        );
    }
}
