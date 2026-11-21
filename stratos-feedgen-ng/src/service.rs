use crate::{
    admission::{ReadAdmission, ReadToken},
    cursor::FeedCursor,
    moderation_label::LabelPage,
    space_mac::MacVerifiedCommit,
    space_ops::ChangeSet,
    space_sync::{PreparedSpacePage, SpaceSyncError, SpaceSyncTarget, stage_space_page},
    store::{
        ActorEnrollment, ActorPage, ActorSyncState, EncryptedStore, EnrollmentReconciliation,
        FeedPage, LabelPageEffects, PdsSpaceMember, ProjectionCompaction, StoreError,
        StoreInterrupt, VerifiedSpaceBase, VerifiedSpaceRecord, VerifiedSpaceTarget,
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
        // A replaced or deleted interaction changes the counts of the boundary
        // it was stored under, which may differ from the one it moves to.
        let changed_interaction_uris = page
            .interactions
            .upserts
            .iter()
            .map(|interaction| interaction.uri.clone())
            .chain(page.interactions.deletes.iter().cloned())
            .collect::<Vec<_>>();
        boundaries.extend(
            self.store
                .list_interaction_boundaries_for_uris(&changed_interaction_uris)?,
        );
        boundaries.extend(
            page.interactions
                .upserts
                .iter()
                .map(|interaction| interaction.boundary.clone()),
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
    pub fn replace_pds_space_members(
        &mut self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
    ) -> Result<(), StoreError> {
        self.store
            .replace_pds_space_members(boundary, members, reconciled_at)?;
        self.admission.invalidate_boundary(boundary);
        Ok(())
    }
    pub fn pds_boundary_generation(&self, boundary: &str) -> Result<u64, StoreError> {
        self.store.pds_boundary_generation(boundary)
    }
    pub fn pds_member_generation(
        &self,
        boundary: &str,
        did: &str,
    ) -> Result<Option<u64>, StoreError> {
        self.store.pds_member_generation(boundary, did)
    }
    pub fn replace_pds_space_members_at_generation(
        &mut self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
        generation: u64,
    ) -> Result<std::collections::BTreeMap<String, u64>, StoreError> {
        let generations = self.store.replace_pds_space_members_at_generation(
            boundary,
            members,
            reconciled_at,
            generation,
        )?;
        self.admission.invalidate_boundary(boundary);
        Ok(generations)
    }
    pub fn pds_space_target(
        &self,
        space_uri: impl Into<String>,
        boundary: impl Into<String>,
        actor_did: impl Into<String>,
    ) -> Result<SpaceSyncTarget, SpaceSyncError> {
        SpaceSyncTarget::from_authoritative_membership(&self.store, space_uri, boundary, actor_did)
    }
    pub fn pds_space_target_at_generation(
        &self,
        space_uri: impl Into<String>,
        boundary: impl Into<String>,
        actor_did: impl Into<String>,
        generation: u64,
    ) -> Result<SpaceSyncTarget, SpaceSyncError> {
        SpaceSyncTarget::from_authoritative_membership_at_generation(
            &self.store,
            space_uri,
            boundary,
            actor_did,
            generation,
        )
    }
    pub fn space_sync_cursor(
        &self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<Option<String>, StoreError> {
        self.store.space_sync_cursor(boundary, space_uri, actor_did)
    }
    pub fn stage_pds_space_page(&mut self, page: PreparedSpacePage) -> Result<(), SpaceSyncError> {
        stage_space_page(&mut self.store, page)
    }
    pub fn promote_pds_space_stage(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<(), StoreError> {
        self.store
            .promote_authorized_space_stage(boundary, space_uri, actor_did, retained_at)?;
        self.admission.invalidate_boundary(boundary);
        Ok(())
    }
    pub fn promote_pds_space_stage_at_generation(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
        observed_at: &str,
        generation: u64,
    ) -> Result<(), StoreError> {
        self.store.promote_authorized_space_stage_at_generation(
            boundary,
            space_uri,
            actor_did,
            retained_at,
            observed_at,
            generation,
        )?;
        self.admission.invalidate_boundary(boundary);
        Ok(())
    }
    pub fn verified_space_base(
        &self,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<Option<VerifiedSpaceBase>, StoreError> {
        self.store.verified_space_base(space_uri, actor_did)
    }
    pub fn promote_verified_space_repo(
        &mut self,
        target: &VerifiedSpaceTarget,
        base_rev: Option<&str>,
        commit: &MacVerifiedCommit,
        change_set: &ChangeSet,
        retained_at: &str,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        self.store.promote_verified_space_repo(
            target,
            base_rev,
            commit,
            change_set,
            retained_at,
            observed_at,
        )?;
        self.admission.invalidate_boundary(&target.boundary);
        Ok(())
    }
    pub fn replace_verified_space_repo(
        &mut self,
        target: &VerifiedSpaceTarget,
        commit: &MacVerifiedCommit,
        records: &[VerifiedSpaceRecord],
        retained_at: &str,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        self.store.replace_verified_space_repo(
            target,
            commit,
            records,
            retained_at,
            observed_at,
        )?;
        self.admission.invalidate_boundary(&target.boundary);
        Ok(())
    }
    pub fn clear_verified_space_repo(
        &mut self,
        target: &VerifiedSpaceTarget,
        observed_at: &str,
    ) -> Result<(), StoreError> {
        self.store.clear_verified_space_repo(target, observed_at)?;
        self.admission.invalidate_boundary(&target.boundary);
        Ok(())
    }
    pub fn pds_member_boundaries(&self, did: &str) -> Result<Vec<String>, StoreError> {
        self.store.pds_member_boundaries(did)
    }
    pub fn discard_pds_space_stage(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<(), StoreError> {
        self.store
            .discard_unverified_space_stage(boundary, space_uri, actor_did)
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
    pub fn label_cursor(&self, authority_did: &str) -> Result<u64, StoreError> {
        self.store.label_cursor(authority_did)
    }
    pub fn apply_label_page(
        &mut self,
        authority_did: &str,
        page: &LabelPage,
        updated_at: &str,
    ) -> Result<LabelPageEffects, StoreError> {
        let effects = self
            .store
            .apply_label_page(authority_did, page, updated_at)?;
        for boundary in &effects.unenrolled_boundaries {
            self.admission.invalidate_boundary(boundary);
        }
        for boundary in &effects.removed_record_boundaries {
            self.admission.invalidate_boundary(boundary);
        }
        Ok(effects)
    }
    pub fn reinstating_accounts(
        &self,
        authority_did: &str,
        limit: u16,
    ) -> Result<Vec<(String, u32)>, StoreError> {
        self.store.reinstating_accounts(authority_did, limit)
    }
    pub fn is_account_taken_down(&self, did: &str) -> Result<bool, StoreError> {
        self.store.is_account_taken_down(did)
    }
    pub fn reinstating_records(
        &self,
        authority_did: &str,
        limit: u16,
    ) -> Result<Vec<String>, StoreError> {
        self.store.reinstating_records(authority_did, limit)
    }
    pub fn reset_actor_cursor(&mut self, authority_did: &str, did: &str) -> Result<(), StoreError> {
        self.store.reset_actor_cursor(authority_did, did)
    }
    pub fn reset_pds_member_space_state(
        &mut self,
        boundary: &str,
        did: &str,
    ) -> Result<(), StoreError> {
        self.store.reset_pds_member_space_state(boundary, did)
    }
    pub fn finish_reinstatement(
        &mut self,
        authority_did: &str,
        subject_key: &str,
    ) -> Result<(), StoreError> {
        self.store.finish_reinstatement(authority_did, subject_key)
    }
    pub fn record_reinstatement_attempt(
        &mut self,
        authority_did: &str,
        subject_key: &str,
    ) -> Result<(), StoreError> {
        self.store
            .record_reinstatement_attempt(authority_did, subject_key)
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

    pub fn compact_projection_with_budget(
        &mut self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
        budget: &crate::config::SpaceStageBudget,
    ) -> Result<ProjectionCompaction, StoreError> {
        let result = self.store.compact_projection_with_budget(
            as_of,
            maximum_retained_at,
            max_bytes,
            limit,
            budget,
        )?;
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
        let mut page = self.store.list_posts_by_boundary(
            request.boundary,
            request.cursor,
            request.limit,
            request.as_of,
        )?;
        let uris = page
            .posts
            .iter()
            .map(|post| post.uri.clone())
            .collect::<Vec<_>>();
        page.summaries = self.store.interaction_summaries(
            request.boundary,
            request.viewer,
            &uris,
            request.as_of,
        )?;
        Ok(Some((token, page)))
    }
    pub fn prepare_blob(
        &self,
        request: ReadRequest<'_>,
        uri: &str,
    ) -> Result<Option<(ReadToken, crate::store::BlobPost)>, StoreError> {
        let Some(token) = self.admission.begin(
            request.viewer,
            request.boundary,
            request.authority_expires_at,
            request.now,
        ) else {
            return Ok(None);
        };
        let Some(post) = self.store.blob_post(uri, request.as_of)? else {
            return Ok(None);
        };
        Ok(Some((token, post)))
    }
    pub fn blob_post(
        &self,
        uri: &str,
        as_of: &str,
    ) -> Result<Option<crate::store::BlobPost>, StoreError> {
        self.store.blob_post(uri, as_of)
    }
    pub fn release<T>(&self, token: ReadToken, response: T, now: u64) -> Option<T> {
        self.admission
            .assert_current(&token, now)
            .then_some(response)
    }
}

#[cfg(test)]
impl ProjectionReader {
    pub(crate) fn interaction_rows(&self) -> Vec<(String, String, String, String)> {
        self.store.interaction_rows()
    }

    pub(crate) fn table_snapshot(&self) -> Vec<(String, Vec<String>)> {
        self.store.table_snapshot()
    }

    pub(crate) fn served_posts(&self, boundary: &str, as_of: &str) -> Vec<(String, String)> {
        self.store.served_posts(boundary, as_of)
    }

    pub(crate) fn rewrite_stored_space_generation(
        &self,
        space_uri: &str,
        actor_did: &str,
        generation: u64,
    ) {
        self.store
            .rewrite_stored_space_generation(space_uri, actor_did, generation);
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        moderation_label::{LabelPage, LabelSubject, ModerationLabel},
        service::{ProjectionReader, ReadRequest},
        store::{
            ActorEnrollment, ActorPage, EncryptedStore, InteractionChanges, InteractionKind,
            ProjectionInteraction, ProjectionPost, StorageKey,
        },
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
            interactions: crate::store::InteractionChanges::default(),
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
    fn a_purge_between_prepare_and_release_refuses_a_page_that_carries_counts() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        let mut page = actor_page(1, vec!["bebop"]);
        page.interactions.upserts = vec![ProjectionInteraction {
            uri: "at://did:plc:spike/app.bsky.feed.like/swordfish".to_owned(),
            actor_did: "did:plc:spike".to_owned(),
            kind: InteractionKind::Like,
            subject_uri: "at://did:plc:spike/zone.stratos.feed.post/see-you".to_owned(),
            boundary: "bebop".to_owned(),
            indexed_at: "1998-04-03T00:00:00.000Z".to_owned(),
            retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
        }];
        reader.apply_actor_page(page).unwrap();
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
        let (token, feed_page) = reader.prepare(request).unwrap().unwrap();
        assert_eq!(
            feed_page
                .summaries
                .get("at://did:plc:spike/zone.stratos.feed.post/see-you")
                .map(|summary| summary.like_count),
            Some(1)
        );

        reader.revoke_boundary("bebop").unwrap();

        assert!(reader.release(token, feed_page, 2).is_none());
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
    fn an_account_takedown_between_query_and_release_rejects_the_page() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader
            .reconcile_actor_enrollment(
                "did:plc:spike",
                "1998-04-03T00:00:00.000Z",
                Some(ActorEnrollment {
                    did: "did:plc:spike".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        reader
            .apply_actor_page(actor_page(1, vec!["bebop"]))
            .unwrap();
        reader.establish_session();
        let (token, page) = reader
            .prepare(ReadRequest {
                viewer: "did:plc:faye",
                boundary: "bebop",
                authority_expires_at: 100,
                now: 1,
                cursor: None,
                limit: 50,
                as_of: "1998-04-02T00:00:00.000Z",
            })
            .unwrap()
            .unwrap();
        assert_eq!(page.posts.len(), 1);

        reader
            .apply_label_page(
                "did:web:stratos.example.test",
                &LabelPage {
                    cursor: 1,
                    labels: vec![ModerationLabel {
                        seq: 1,
                        subject: LabelSubject::Account {
                            did: "did:plc:spike".to_owned(),
                        },
                        neg: false,
                    }],
                    skipped_subjects: 0,
                },
                "2026-11-01T00:00:00.000Z",
            )
            .unwrap();

        assert!(reader.release(token, page, 2).is_none());
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

    fn like_page(
        sequence: u64,
        upserts: Vec<ProjectionInteraction>,
        deletes: Vec<String>,
    ) -> ActorPage {
        ActorPage {
            authority_did: "did:web:stratos.example.test".to_owned(),
            actor_did: "did:plc:spike".to_owned(),
            sequence,
            upserts: Vec::new(),
            deletes: Vec::new(),
            interactions: InteractionChanges { upserts, deletes },
            updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
        }
    }

    fn spike_like(boundary: &str) -> ProjectionInteraction {
        ProjectionInteraction {
            uri: "at://did:plc:spike/app.bsky.feed.like/swordfish".to_owned(),
            actor_did: "did:plc:spike".to_owned(),
            kind: InteractionKind::Like,
            subject_uri: "at://did:plc:faye/zone.stratos.feed.post/see-you".to_owned(),
            boundary: boundary.to_owned(),
            indexed_at: "1998-04-03T00:00:00.000Z".to_owned(),
            retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
        }
    }

    fn read_request(boundary: &str) -> ReadRequest<'_> {
        ReadRequest {
            viewer: "did:plc:faye",
            boundary,
            authority_expires_at: 100,
            now: 1,
            cursor: None,
            limit: 50,
            as_of: "1998-04-02T00:00:00.000Z",
        }
    }

    #[test]
    fn a_like_upsert_invalidates_only_the_reads_of_its_boundary() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader.establish_session();
        let (token, page) = reader.prepare(read_request("bebop")).unwrap().unwrap();
        let (other_token, other_page) = reader.prepare(read_request("other")).unwrap().unwrap();

        reader
            .apply_actor_page(like_page(1, vec![spike_like("bebop")], Vec::new()))
            .unwrap();

        assert!(reader.release(token, page, 2).is_none());
        assert!(reader.release(other_token, other_page, 2).is_some());
    }

    #[test]
    fn deleting_a_stored_like_invalidates_the_reads_of_the_boundary_it_was_in() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        let like = spike_like("bebop");
        reader
            .apply_actor_page(like_page(1, vec![like.clone()], Vec::new()))
            .unwrap();
        reader.establish_session();
        let (token, page) = reader.prepare(read_request("bebop")).unwrap().unwrap();
        let (other_token, other_page) = reader.prepare(read_request("other")).unwrap().unwrap();

        reader
            .apply_actor_page(like_page(2, Vec::new(), vec![like.uri]))
            .unwrap();

        assert!(reader.interaction_rows().is_empty());
        assert!(reader.release(token, page, 2).is_none());
        assert!(reader.release(other_token, other_page, 2).is_some());
    }

    #[test]
    fn moving_a_like_between_boundaries_invalidates_both() {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader
            .apply_actor_page(like_page(1, vec![spike_like("bebop")], Vec::new()))
            .unwrap();
        reader.establish_session();
        let (old_token, old_page) = reader.prepare(read_request("bebop")).unwrap().unwrap();
        let (new_token, new_page) = reader.prepare(read_request("red-tail")).unwrap().unwrap();

        reader
            .apply_actor_page(like_page(2, vec![spike_like("red-tail")], Vec::new()))
            .unwrap();

        assert!(reader.release(old_token, old_page, 2).is_none());
        assert!(reader.release(new_token, new_page, 2).is_none());
    }

    const CREW: &str = "did:web:bebop.example/crew";
    const CREW_SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/crew";
    const FAYE: &str = "did:plc:fayevalentine";
    const FIRST_REV: &str = "3jzfcijpj2z2a";
    const OBSERVED: &str = "2026-09-22T00:00:00.000Z";
    const RETAINED: &str = "2026-09-23T00:00:00.000Z";

    fn reader_with_member() -> (ProjectionReader, crate::store::VerifiedSpaceTarget) {
        let mut reader = ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        );
        reader
            .replace_pds_space_members(
                CREW,
                vec![crate::store::PdsSpaceMember {
                    did: FAYE.to_owned(),
                }],
                OBSERVED,
            )
            .unwrap();
        let target = crate::store::VerifiedSpaceTarget {
            boundary: CREW.to_owned(),
            space_uri: CREW_SPACE.to_owned(),
            actor_did: FAYE.to_owned(),
            host: "https://pds.bebop.example".to_owned(),
            generation: reader.pds_member_generation(CREW, FAYE).unwrap().unwrap(),
        };
        (reader, target)
    }

    fn empty_repo_commit() -> crate::space_mac::MacVerifiedCommit {
        crate::space_mac::MacVerifiedCommit::for_tests(
            FAYE,
            CREW_SPACE,
            FIRST_REV,
            crate::space_set_hash::SetHashState::empty().digest(),
        )
    }

    #[test]
    fn promoting_a_verified_change_set_invalidates_only_the_reads_of_its_boundary() {
        let (mut reader, target) = reader_with_member();
        reader.establish_session();
        let (token, page) = reader.prepare(read_request(CREW)).unwrap().unwrap();
        let (other_token, other_page) = reader.prepare(read_request("other")).unwrap().unwrap();
        let change_set =
            crate::space_ops::ChangeSet::apply(crate::space_set_hash::SetHashState::empty(), &[])
                .unwrap();

        reader
            .promote_verified_space_repo(
                &target,
                None,
                &empty_repo_commit(),
                &change_set,
                RETAINED,
                OBSERVED,
            )
            .unwrap();

        assert!(reader.release(token, page, 2).is_none());
        assert!(reader.release(other_token, other_page, 2).is_some());
        assert_eq!(
            reader
                .verified_space_base(CREW_SPACE, FAYE)
                .unwrap()
                .unwrap()
                .rev,
            FIRST_REV
        );
    }

    #[test]
    fn replacing_a_verified_repo_invalidates_only_the_reads_of_its_boundary() {
        let (mut reader, target) = reader_with_member();
        reader.establish_session();
        let (token, page) = reader.prepare(read_request(CREW)).unwrap().unwrap();
        let (other_token, other_page) = reader.prepare(read_request("other")).unwrap().unwrap();

        reader
            .replace_verified_space_repo(&target, &empty_repo_commit(), &[], RETAINED, OBSERVED)
            .unwrap();

        assert!(reader.release(token, page, 2).is_none());
        assert!(reader.release(other_token, other_page, 2).is_some());
    }

    #[test]
    fn a_refused_verified_write_leaves_the_reads_of_its_boundary_valid() {
        let (mut reader, target) = reader_with_member();
        reader.establish_session();
        let (token, page) = reader.prepare(read_request(CREW)).unwrap().unwrap();
        let wrong_digest =
            crate::space_mac::MacVerifiedCommit::for_tests(FAYE, CREW_SPACE, FIRST_REV, [9; 32]);

        let outcome =
            reader.replace_verified_space_repo(&target, &wrong_digest, &[], RETAINED, OBSERVED);

        assert!(outcome.is_err());
        assert!(reader.release(token, page, 2).is_some());
    }
}
