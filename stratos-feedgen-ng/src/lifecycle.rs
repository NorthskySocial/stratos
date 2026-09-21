use std::sync::{Arc, Mutex};

use crate::{
    authorization::{AuthorizationError, ViewerAuthorization, ViewerAuthorizations},
    readiness::{FeedReadinessGate, ReconciliationOutcome},
    service::ProjectionReader,
    store::{ActorPage, StoreError},
};

pub struct ControlLifecycle {
    transition: Mutex<()>,
    authorizations: Mutex<ViewerAuthorizations>,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    projection: Arc<Mutex<ProjectionReader>>,
}

impl ControlLifecycle {
    pub fn new(projection: ProjectionReader, readiness: Arc<Mutex<FeedReadinessGate>>) -> Self {
        Self::with_authorizations(
            projection,
            readiness,
            ViewerAuthorizations::new(crate::authorization::DEFAULT_AUTHORIZATION_BYTES),
        )
    }

    fn with_authorizations(
        projection: ProjectionReader,
        readiness: Arc<Mutex<FeedReadinessGate>>,
        authorizations: ViewerAuthorizations,
    ) -> Self {
        Self {
            transition: Mutex::new(()),
            authorizations: Mutex::new(authorizations),
            readiness,
            projection: Arc::new(Mutex::new(projection)),
        }
    }

    pub fn read<T>(&self, action: impl FnOnce(&ProjectionReader) -> T) -> T {
        let projection = self.projection.lock().expect("projection lock poisoned");
        action(&projection)
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
        lifecycle::ControlLifecycle,
        readiness::{FeedReadinessGate, ReconciliationOutcome},
        service::{ProjectionReader, ReadRequest},
        store::{EncryptedStore, StorageKey},
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

        assert!(lifecycle.read(|projection| projection.release(token, page, 2).is_none()));
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
}
