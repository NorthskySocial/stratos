use std::sync::{Arc, Mutex};

use crate::{
    readiness::{FeedReadinessGate, ReconciliationOutcome},
    service::ProjectionReader,
    store::{ActorPage, StoreError},
};

pub struct ControlLifecycle {
    transition: Mutex<()>,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    projection: Arc<Mutex<ProjectionReader>>,
}

impl ControlLifecycle {
    pub fn new(projection: ProjectionReader, readiness: Arc<Mutex<FeedReadinessGate>>) -> Self {
        Self {
            transition: Mutex::new(()),
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
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use crate::{
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
}
