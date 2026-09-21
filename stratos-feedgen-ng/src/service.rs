use crate::{
    admission::{ReadAdmission, ReadToken},
    cursor::FeedCursor,
    store::{
        ActorEnrollment, ActorPage, ActorSyncState, EncryptedStore, EnrollmentReconciliation,
        FeedPage, ProjectionCompaction, StoreError, StoreInterrupt,
    },
};
use std::collections::BTreeSet;

pub struct ProjectionReader {
    admission: ReadAdmission,
    store: EncryptedStore,
}
#[derive(Clone, Copy)]
pub struct ReadRequest<'a> {
    pub viewer: &'a str,
    pub boundary: &'a str,
    pub authority_expires_at: u64,
    pub now: u64,
    pub cursor: Option<&'a FeedCursor>,
    pub limit: u16,
    pub as_of: &'a str,
}

impl ProjectionReader {
    pub fn new(store: EncryptedStore) -> Self {
        Self {
            admission: ReadAdmission::default(),
            store,
        }
    }
    pub fn interrupt_handle(&self) -> StoreInterrupt {
        self.store.interrupt_handle()
    }
    pub fn establish_session(&mut self) {
        self.admission.establish_session();
    }
    pub fn close_session(&mut self) {
        self.admission.close_session();
    }
    pub fn invalidate_viewer(&mut self, viewer: &str) {
        self.admission.invalidate_viewer(viewer);
    }
    pub fn invalidate_boundary(&mut self, boundary: &str) {
        self.admission.invalidate_boundary(boundary);
    }
    pub fn replace_projection(&mut self) {
        self.admission.replace_projection();
    }
    pub fn apply_actor_page(&mut self, page: ActorPage) -> Result<(), StoreError> {
        let changed_uris = page
            .upserts
            .iter()
            .map(|post| post.uri.clone())
            .chain(page.deletes.iter().cloned())
            .collect::<Vec<_>>();
        let mut boundaries = self
            .store
            .list_boundaries_for_uris(&changed_uris)?
            .into_iter()
            .collect::<BTreeSet<_>>();
        boundaries.extend(
            page.upserts
                .iter()
                .flat_map(|post| post.boundaries.iter().cloned()),
        );
        self.store.apply_actor_page(page)?;
        for boundary in boundaries {
            self.admission.invalidate_boundary(&boundary);
        }
        Ok(())
    }
    pub fn actor_sync_state(
        &self,
        authority_did: &str,
        did: &str,
    ) -> Result<Option<ActorSyncState>, StoreError> {
        self.store.actor_sync_state(authority_did, did)
    }
    pub fn list_actor_enrollments_page(
        &self,
        after_did: Option<&str>,
        limit: u16,
    ) -> Result<Vec<ActorEnrollment>, StoreError> {
        self.store.list_actor_enrollments_page(after_did, limit)
    }
    pub fn reconcile_actor_enrollment(
        &mut self,
        did: &str,
        observed_at: &str,
        enrollment: Option<ActorEnrollment>,
    ) -> Result<EnrollmentReconciliation, StoreError> {
        let mut affected = enrollment
            .as_ref()
            .map(|entry| entry.boundaries.iter().cloned().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        let result = self
            .store
            .reconcile_actor_enrollment(did, observed_at, enrollment)?;
        affected.extend(result.removed_boundaries.iter().cloned());
        for boundary in affected {
            self.admission.invalidate_boundary(&boundary);
        }
        Ok(result)
    }
    pub fn revoke_boundary(&mut self, boundary: &str) -> Result<u64, StoreError> {
        self.admission.invalidate_boundary(boundary);
        self.store.purge_boundary(boundary)
    }
    pub fn compact_projection(
        &mut self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
    ) -> Result<ProjectionCompaction, StoreError> {
        let result = self
            .store
            .compact_projection(as_of, maximum_retained_at, max_bytes, limit)?;
        if result.deleted != 0 {
            self.admission.replace_projection();
        }
        Ok(result)
    }
    pub fn prepare(
        &self,
        request: ReadRequest<'_>,
    ) -> Result<Option<(ReadToken, FeedPage)>, StoreError> {
        let Some(token) = self.admission.begin(
            request.viewer,
            request.boundary,
            request.authority_expires_at,
            request.now,
        ) else {
            return Ok(None);
        };
        Ok(Some((
            token,
            self.store.list_posts_by_boundary(
                request.boundary,
                request.cursor,
                request.limit,
                request.as_of,
            )?,
        )))
    }
    pub fn release<T>(&self, token: ReadToken, response: T, now: u64) -> Option<T> {
        self.admission
            .assert_current(&token, now)
            .then_some(response)
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        service::{ProjectionReader, ReadRequest},
        store::{ActorPage, EncryptedStore, ProjectionPost, StorageKey},
    };

    fn actor_page(sequence: u64, boundaries: Vec<&str>) -> ActorPage {
        ActorPage {
            authority_did: "did:web:stratos.example.test".to_owned(),
            actor_did: "did:plc:spike".to_owned(),
            sequence,
            upserts: vec![ProjectionPost {
                uri: "at://did:plc:spike/zone.stratos.feed.post/see-you".to_owned(),
                author_did: "did:plc:spike".to_owned(),
                cid: "bafyreia".to_owned(),
                sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
                indexed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
                record_json: br#"{"$type":"zone.stratos.feed.post","text":"Bang"}"#.to_vec(),
                blob_refs_json: b"[]".to_vec(),
                boundaries: boundaries.into_iter().map(str::to_owned).collect(),
            }],
            deletes: Vec::new(),
            updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
        }
    }
    #[test]
    fn invalidation_between_query_and_release_rejects_the_page() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader.establish_session();
        let request = ReadRequest {
            viewer: "did:plc:spike",
            boundary: "bebop",
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-03T00:00:00.000Z",
        };
        let (token, page) = reader.prepare(request).unwrap().unwrap();
        reader.invalidate_viewer("did:plc:spike");
        assert!(reader.release(token, page, 2).is_none());
    }

    #[test]
    fn disconnect_and_reopen_rejects_the_old_read() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader.establish_session();
        let request = ReadRequest {
            viewer: "did:plc:spike",
            boundary: "bebop",
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-03T00:00:00.000Z",
        };
        let (token, page) = reader.prepare(request).unwrap().unwrap();
        reader.close_session();
        reader.establish_session();
        assert!(reader.release(token, page, 2).is_none());
    }

    #[test]
    fn boundary_revocation_rejects_a_prepared_page() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader.establish_session();
        let request = ReadRequest {
            viewer: "did:plc:spike",
            boundary: "bebop",
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-03T00:00:00.000Z",
        };
        let (token, page) = reader.prepare(request).unwrap().unwrap();
        assert_eq!(reader.revoke_boundary("bebop").unwrap(), 0);
        assert!(reader.release(token, page, 2).is_none());
    }

    #[test]
    fn ordinary_actor_updates_invalidate_only_affected_boundary_reads() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader
            .apply_actor_page(actor_page(1, vec!["bebop"]))
            .unwrap();
        reader.establish_session();
        let request = ReadRequest {
            viewer: "did:plc:faye",
            boundary: "bebop",
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-02T00:00:00.000Z",
        };
        let (token, page) = reader.prepare(request).unwrap().unwrap();
        let unrelated = ReadRequest {
            viewer: "did:plc:faye",
            boundary: "other",
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-02T00:00:00.000Z",
        };
        let (unrelated_token, unrelated_page) = reader.prepare(unrelated).unwrap().unwrap();

        reader
            .apply_actor_page(actor_page(2, vec!["red-tail"]))
            .unwrap();

        assert!(reader.release(token, page, 2).is_none());
        assert!(reader.release(unrelated_token, unrelated_page, 2).is_some());
        let red_tail = ReadRequest {
            boundary: "red-tail",
            ..request
        };
        assert!(reader.prepare(red_tail).unwrap().is_some());
    }

    #[test]
    fn rejected_actor_updates_leave_prepared_reads_current() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader
            .apply_actor_page(actor_page(2, vec!["bebop"]))
            .unwrap();
        reader.establish_session();
        let request = ReadRequest {
            viewer: "did:plc:faye",
            boundary: "bebop",
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-02T00:00:00.000Z",
        };
        let (token, page) = reader.prepare(request).unwrap().unwrap();

        assert!(
            reader
                .apply_actor_page(actor_page(1, vec!["red-tail"]))
                .is_err()
        );

        assert!(reader.release(token, page, 2).is_some());
    }
}
