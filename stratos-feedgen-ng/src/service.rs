use crate::{
    admission::{ReadAdmission, ReadToken},
    cursor::FeedCursor,
    store::{EncryptedStore, FeedPage, StoreError},
};

pub struct ProjectionReader {
    admission: ReadAdmission,
    store: EncryptedStore,
}
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
    pub fn revoke_boundary(&mut self, boundary: &str) -> Result<u64, StoreError> {
        self.admission.invalidate_boundary(boundary);
        self.store.purge_boundary(boundary)
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
        store::{EncryptedStore, StorageKey},
    };
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
}
