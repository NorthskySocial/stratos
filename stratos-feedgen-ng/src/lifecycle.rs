use std::sync::{Arc, Mutex};

use crate::{
    actor_event::{ActorEventError, parse_actor_commit},
    authorization::{AuthorizationError, ViewerAuthorization, ViewerAuthorizations},
    feed_service::{
        FeedQuery, FeedService, FeedServiceError, ViewerAuthorization as FeedViewerAuthorization,
    },
    feeds::FeedRegistry,
    identifier::{Did, RecordUri},
    readiness::{FeedReadinessGate, ReconciliationOutcome},
    service::ProjectionReader,
    service_event::{EnrollmentAction, EnrollmentEvent},
    space_sync::{PreparedSpacePage, SpaceSyncError, SpaceSyncTarget},
    store::{
        ActorEnrollment, ActorPage, ActorSyncState, EnrollmentReconciliation, PdsSpaceMember,
        StoreError, StoreInterrupt,
    },
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
}

impl ControlLifecycle {
    pub fn new(projection: ProjectionReader, readiness: Arc<Mutex<FeedReadinessGate>>) -> Self {
        Self::with_authorizations(
            projection,
            readiness,
            ViewerAuthorizations::new(crate::authorization::DEFAULT_AUTHORIZATION_BYTES),
            None,
        )
    }

    pub fn for_authority(
        projection: ProjectionReader,
        readiness: Arc<Mutex<FeedReadinessGate>>,
        authority_did: impl Into<String>,
    ) -> Result<Self, crate::identifier::IdentifierError> {
        let authority_did = authority_did.into();
        Did::parse(authority_did.clone())?;
        Ok(Self::with_authorizations(
            projection,
            readiness,
            ViewerAuthorizations::new(crate::authorization::DEFAULT_AUTHORIZATION_BYTES),
            Some(authority_did),
        ))
    }

    fn with_authorizations(
        projection: ProjectionReader,
        readiness: Arc<Mutex<FeedReadinessGate>>,
        authorizations: ViewerAuthorizations,
        authority_did: Option<String>,
    ) -> Self {
        let interrupt = projection.interrupt_handle();
        Self {
            transition: Mutex::new(()),
            authorizations: Mutex::new(authorizations),
            readiness,
            projection: Arc::new(Mutex::new(projection)),
            interrupt,
            authority_did,
        }
    }

    #[cfg(test)]
    fn read<T>(&self, action: impl FnOnce(&ProjectionReader) -> T) -> T {
        let projection = self.projection.lock().expect("projection lock poisoned");
        action(&projection)
    }

    pub fn serve_viewer_feed(
        &self,
        did: &str,
        feeds: &FeedRegistry,
        query: FeedQuery<'_>,
    ) -> Result<Vec<u8>, FeedServiceError> {
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
    }

    pub fn begin_reconciliation(&self) -> u64 {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        projection.close_session();
        readiness.begin_reconciliation()
    }

    pub fn complete_reconciliation(&self, generation: u64, outcome: ReconciliationOutcome) -> bool {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        let ready = readiness.complete_reconciliation(generation, outcome);
        if ready {
            projection.establish_session();
        } else {
            projection.close_session();
        }
        ready
    }

    pub fn mark_unavailable(&self) {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        let mut readiness = self.readiness.lock().expect("readiness lock poisoned");
        let mut projection = self.projection.lock().expect("projection lock poisoned");
        readiness.mark_unavailable();
        projection.close_session();
    }

    pub fn apply_actor_page(&self, page: ActorPage) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .apply_actor_page(page)
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
        projection
            .apply_actor_page(page)
            .map_err(ActorFrameError::Store)?;
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

    pub fn pds_space_target(
        &self,
        space_uri: impl Into<String>,
        boundary: impl Into<String>,
        actor_did: impl Into<String>,
    ) -> Result<SpaceSyncTarget, SpaceSyncError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .pds_space_target(space_uri, boundary, actor_did)
    }

    pub fn pds_space_cursor(
        &self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<Option<String>, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .space_sync_cursor(boundary, space_uri, actor_did)
    }

    pub fn stage_pds_space_page(&self, page: PreparedSpacePage) -> Result<(), SpaceSyncError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .stage_pds_space_page(page)
    }

    pub fn promote_pds_space_stage(
        &self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .promote_pds_space_stage(boundary, space_uri, actor_did, retained_at)
    }

    pub fn discard_pds_space_stage(
        &self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<(), StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .discard_pds_space_stage(boundary, space_uri, actor_did)
    }

    pub fn reconcile_actor_enrollment(
        &self,
        did: &str,
        observed_at: &str,
        enrollment: Option<ActorEnrollment>,
    ) -> Result<EnrollmentReconciliation, StoreError> {
        let _transition = self.transition.lock().expect("lifecycle lock poisoned");
        self.projection
            .lock()
            .expect("projection lock poisoned")
            .reconcile_actor_enrollment(did, observed_at, enrollment)
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
        store::{ActorPage, EncryptedStore, ProjectionPost, StorageKey},
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
                "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:spike/zone.stratos.feed.post/see-you",
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
        );
        lifecycle.session_established();
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
}
