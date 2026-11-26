use super::*;
/// A row is applied only to the member and space it is for, under a boundary
/// the target named and a time the store can read.
fn validate_row_scope(
    space_uri: &str,
    actor_did: &str,
    row: &SpaceStageRow,
) -> Result<(), StoreError> {
    crate::identifier::Did::parse(actor_did.to_owned())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    let space = crate::identifier::SpaceUri::parse(space_uri)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if row.boundary.is_empty() || !is_utc_timestamp(&row.updated_at) {
        return Err(StoreError::InvalidProjectionMutation);
    }
    let uri = crate::identifier::RecordUri::parse(&row.uri)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if uri.space().as_ref() != Some(&space) || uri.author().as_str() != actor_did {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

/// The configured projection maximum, which a write counts the bytes it adds
/// and the bytes already published against.
fn projection_maximum(transaction: &rusqlite::Transaction<'_>) -> Result<i64, StoreError> {
    Ok(transaction
        .query_row(
            "SELECT value FROM retention_metadata WHERE key = 'projection_max_bytes'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)?
        .unwrap_or(crate::config::MEMORY_RETENTION_MAX_BYTES as i64))
}

/// Whether `added_bytes` and what is already published together pass `maximum`.
fn projection_would_exceed(
    transaction: &rusqlite::Transaction<'_>,
    maximum: i64,
    added_bytes: i64,
) -> Result<bool, StoreError> {
    let published_bytes = super::interactions::published_bytes(transaction)?;
    Ok(added_bytes
        .checked_add(published_bytes)
        .is_none_or(|used| used > maximum))
}

pub(super) fn exceeds_projection_maximum(
    transaction: &rusqlite::Transaction<'_>,
    added_bytes: i64,
) -> Result<bool, StoreError> {
    let maximum = projection_maximum(transaction)?;
    projection_would_exceed(transaction, maximum, added_bytes)
}

/// What one row adds to the projection's byte accounting: the length of each
/// field it holds, in characters for text and bytes for blobs.
pub(super) fn stage_row_bytes(space_uri: &str, actor_did: &str, row: &SpaceStageRow) -> i64 {
    let text = |value: &str| value.chars().count();
    let optional_text = |value: &Option<String>| value.as_deref().map_or(0, text);
    let optional_blob = |value: &Option<Vec<u8>>| value.as_ref().map_or(0, Vec::len);
    (text(space_uri)
        + text(actor_did)
        + text(&row.uri)
        + text(&row.boundary)
        + optional_text(&row.cid)
        + optional_text(&row.sort_at)
        + optional_text(&row.indexed_at)
        + optional_blob(&row.record_json)
        + optional_blob(&row.blob_refs_json)
        + text(&row.updated_at)) as i64
}

pub(super) fn apply_verified_space_stage_row(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    retained_at: &str,
    stage: SpaceStageRow,
) -> Result<(), StoreError> {
    validate_row_scope(space_uri, actor_did, &stage)?;
    if stage.deleted {
        if stage.cid.is_some()
            || stage.sort_at.is_some()
            || stage.indexed_at.is_some()
            || stage.record_json.is_some()
            || stage.blob_refs_json.is_some()
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
        delete_post_and_interaction(transaction, &stage.uri)?;
        return Ok(());
    }
    // A takedown outlives the member's host still serving the records.
    if super::labels::account_taken_down(transaction, actor_did)? {
        delete_post_and_interaction(transaction, &stage.uri)?;
        return Ok(());
    }
    // A replay or a later sync must not re-admit a taken-down record.
    if super::labels::record_taken_down(transaction, &stage.uri)? {
        delete_post_and_interaction(transaction, &stage.uri)?;
        return Ok(());
    }
    let record_uri = crate::identifier::RecordUri::parse(&stage.uri)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if let Some(kind) = staged_interaction_kind(&record_uri) {
        return upsert_staged_interaction(transaction, kind, actor_did, retained_at, stage);
    }
    let Some(cid) = stage.cid else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(sort_at) = stage.sort_at else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(indexed_at) = stage.indexed_at else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(record_json) = stage.record_json else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    let Some(blob_refs_json) = stage.blob_refs_json else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    if cid.is_empty() || !is_utc_timestamp(&sort_at) || !is_utc_timestamp(&indexed_at) {
        return Err(StoreError::InvalidProjectionMutation);
    }
    let projection_bytes = projection_bytes_from_fields(
        &stage.uri,
        actor_did,
        &cid,
        &sort_at,
        &indexed_at,
        &record_json,
        &blob_refs_json,
    );
    transaction
        .execute(
            "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
             ON CONFLICT(uri) DO UPDATE SET author_did = excluded.author_did, cid = excluded.cid,
               sort_at = excluded.sort_at, indexed_at = excluded.indexed_at, retained_at = excluded.retained_at,
               projection_bytes = excluded.projection_bytes, record_json = excluded.record_json,
               blob_refs_json = excluded.blob_refs_json, row_version = post.row_version + 1",
            params![
                stage.uri,
                actor_did,
                cid,
                sort_at,
                indexed_at,
                retained_at,
                projection_bytes,
                record_json,
                blob_refs_json,
            ],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute("DELETE FROM post_boundary WHERE uri = ?1", [&stage.uri])
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "INSERT INTO post_boundary (uri, boundary, sort_at) VALUES (?1, ?2, ?3)",
            params![stage.uri, stage.boundary, sort_at],
        )
        .map_err(StoreError::Open)?;
    Ok(())
}

fn delete_post_and_interaction(
    transaction: &rusqlite::Transaction<'_>,
    uri: &str,
) -> Result<(), StoreError> {
    transaction
        .execute("DELETE FROM post WHERE uri = ?1", [uri])
        .map_err(StoreError::Open)?;
    super::interactions::delete_interaction(transaction, uri)?;
    Ok(())
}

fn staged_interaction_kind(uri: &crate::identifier::RecordUri) -> Option<InteractionKind> {
    let crate::identifier::RecordUri::Space { collection, .. } = uri else {
        return None;
    };
    InteractionKind::from_collection(collection)
}

fn upsert_staged_interaction(
    transaction: &rusqlite::Transaction<'_>,
    kind: InteractionKind,
    actor_did: &str,
    retained_at: &str,
    stage: SpaceStageRow,
) -> Result<(), StoreError> {
    let (Some(cid), Some(indexed_at), Some(record_json)) =
        (stage.cid, stage.indexed_at, stage.record_json)
    else {
        return Err(StoreError::InvalidProjectionMutation);
    };
    if cid.is_empty() {
        return Err(StoreError::InvalidProjectionMutation);
    }
    let record: serde_json::Value =
        serde_json::from_slice(&record_json).map_err(|_| StoreError::InvalidProjectionMutation)?;
    let subject_uri = record
        .get("subject")
        .and_then(|subject| subject.get("uri"))
        .and_then(serde_json::Value::as_str)
        .ok_or(StoreError::InvalidProjectionMutation)?;
    super::interactions::upsert_interaction(
        transaction,
        &ProjectionInteraction {
            uri: stage.uri,
            actor_did: actor_did.to_owned(),
            kind,
            subject_uri: subject_uri.to_owned(),
            boundary: stage.boundary,
            indexed_at,
            retained_at: retained_at.to_owned(),
        },
    )?;
    Ok(())
}

fn purge_departed_pds_member(
    transaction: &rusqlite::Transaction<'_>,
    boundary: &str,
    did: &str,
) -> Result<(), StoreError> {
    let (authority, _) = boundary
        .split_once('/')
        .ok_or(StoreError::InvalidProjectionMutation)?;
    let space_prefix = crate::identifier::SpaceUri::authority_prefix(authority);
    transaction
        .execute(
            "DELETE FROM post_boundary WHERE boundary = ?1 AND uri IN (
               SELECT uri FROM post WHERE author_did = ?2 AND substr(uri, 1, length(?3)) = ?3
             )",
            params![boundary, did, space_prefix],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM post WHERE NOT EXISTS (SELECT 1 FROM post_boundary WHERE post_boundary.uri = post.uri)",
            [],
        )
        .map_err(StoreError::Open)?;
    super::interactions::delete_actor_boundary_interactions(transaction, did, boundary)?;
    delete_verified_space_state(transaction, boundary, did)?;
    Ok(())
}

/// The verified path rows and checkpoint of a member go with every other space
/// state of that member, in the same transaction.
fn delete_verified_space_state(
    transaction: &rusqlite::Transaction<'_>,
    boundary: &str,
    did: &str,
) -> Result<(), StoreError> {
    for table in ["space_repo_record", "space_repo_state"] {
        transaction
            .execute(
                &format!("DELETE FROM {table} WHERE did = ?1 AND boundary = ?2"),
                params![did, boundary],
            )
            .map_err(StoreError::Open)?;
    }
    Ok(())
}

pub(super) fn invalidate_pds_member(
    transaction: &rusqlite::Transaction<'_>,
    boundary: &str,
    did: &str,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "INSERT INTO pds_member_generation (boundary, did, generation) VALUES (?1, ?2, 1)
         ON CONFLICT(boundary, did) DO UPDATE SET generation = generation + 1",
            params![boundary, did],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "INSERT INTO pds_boundary_generation (boundary, generation) VALUES (?1, 1)
         ON CONFLICT(boundary) DO UPDATE SET generation = generation + 1",
            [boundary],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM membership_baseline WHERE boundary = ?1 AND did = ?2 AND custody = 'pds'",
            params![boundary, did],
        )
        .map_err(StoreError::Open)?;
    delete_verified_space_state(transaction, boundary, did)?;
    Ok(())
}

pub(super) fn has_pds_member_generation(
    transaction: &rusqlite::Transaction<'_>,
    boundary: &str,
    did: &str,
    generation: u64,
) -> Result<bool, StoreError> {
    let generation =
        i64::try_from(generation).map_err(|_| StoreError::InvalidProjectionMutation)?;
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM membership_baseline AS member
         JOIN pds_member_generation AS version USING (boundary, did)
         WHERE member.boundary = ?1 AND member.did = ?2 AND member.custody = 'pds'
         AND version.generation = ?3)",
            params![boundary, did, generation],
            |row| row.get(0),
        )
        .map_err(StoreError::Open)
}

impl EncryptedStore {
    pub fn pds_boundary_generation(&self, boundary: &str) -> Result<u64, StoreError> {
        let generation: i64 = self.connection.query_row(
            "SELECT COALESCE((SELECT generation FROM pds_boundary_generation WHERE boundary = ?1), 0)",
            [boundary], |row| row.get(0),
        ).map_err(StoreError::Open)?;
        u64::try_from(generation).map_err(|_| StoreError::InvalidProjectionMutation)
    }

    pub fn pds_member_generation(
        &self,
        boundary: &str,
        did: &str,
    ) -> Result<Option<u64>, StoreError> {
        let generation: Option<i64> = self
            .connection
            .query_row(
                "SELECT version.generation FROM membership_baseline AS member
             JOIN pds_member_generation AS version USING (boundary, did)
             WHERE member.boundary = ?1 AND member.did = ?2 AND member.custody = 'pds'",
                params![boundary, did],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?;
        generation
            .map(|value| u64::try_from(value).map_err(|_| StoreError::InvalidProjectionMutation))
            .transpose()
    }

    pub fn replace_pds_space_members(
        &mut self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
    ) -> Result<(), StoreError> {
        let generation = self.pds_boundary_generation(boundary)?;
        self.replace_pds_space_members_at_generation(boundary, members, reconciled_at, generation)
            .map(|_| ())
    }

    pub fn replace_pds_space_members_at_generation(
        &mut self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
        generation: u64,
    ) -> Result<std::collections::BTreeMap<String, u64>, StoreError> {
        if boundary.is_empty()
            || boundary.len() > 256
            || !boundary.is_ascii()
            || members.len() > MAX_PDS_SPACE_MEMBER_PAGE
            || !is_utc_timestamp(reconciled_at)
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let Some((authority, name)) = boundary.split_once('/') else {
            return Err(StoreError::InvalidProjectionMutation);
        };
        if name.is_empty() || crate::identifier::Did::parse(authority.to_owned()).is_err() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let mut unique = std::collections::BTreeSet::new();
        for member in &members {
            crate::identifier::Did::parse(member.did.clone())
                .map_err(|_| StoreError::InvalidProjectionMutation)?;
            if !unique.insert(member.did.clone()) {
                return Err(StoreError::InvalidProjectionMutation);
            }
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let current_generation: i64 = transaction.query_row(
            "SELECT COALESCE((SELECT generation FROM pds_boundary_generation WHERE boundary = ?1), 0)",
            [boundary], |row| row.get(0),
        ).map_err(StoreError::Open)?;
        if u64::try_from(current_generation).map_err(|_| StoreError::InvalidProjectionMutation)?
            != generation
        {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        let prior = transaction
            .prepare("SELECT did FROM membership_baseline WHERE boundary = ?1 AND custody = 'pds'")
            .map_err(StoreError::Open)?
            .query_map([boundary], |row| row.get::<_, String>(0))
            .map_err(StoreError::Open)?
            .collect::<Result<std::collections::BTreeSet<_>, _>>()
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM membership_baseline WHERE boundary = ?1 AND custody = 'pds'",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        for did in prior.difference(&unique) {
            purge_departed_pds_member(&transaction, boundary, did)?;
            invalidate_pds_member(&transaction, boundary, did)?;
        }
        let mut generations = std::collections::BTreeMap::new();
        for member in members {
            transaction.execute(
                "INSERT OR IGNORE INTO pds_member_generation (boundary, did, generation) VALUES (?1, ?2, 0)",
                params![boundary, member.did],
            ).map_err(StoreError::Open)?;
            transaction
                .execute(
                    "INSERT INTO membership_baseline (boundary, did, custody, repo_host, reconciled_at) VALUES (?1, ?2, 'pds', NULL, ?3)",
                    params![boundary, member.did, reconciled_at],
                )
                .map_err(StoreError::Open)?;
            let value: i64 = transaction
                .query_row(
                    "SELECT generation FROM pds_member_generation WHERE boundary = ?1 AND did = ?2",
                    params![boundary, member.did],
                    |row| row.get(0),
                )
                .map_err(StoreError::Open)?;
            generations.insert(
                member.did,
                u64::try_from(value).map_err(|_| StoreError::InvalidProjectionMutation)?,
            );
        }
        transaction.commit().map_err(StoreError::Open)?;
        Ok(generations)
    }

    pub fn reset_pds_member_space_state(
        &mut self,
        boundary: &str,
        did: &str,
    ) -> Result<(), StoreError> {
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        crate::identifier::Did::parse(did.to_owned())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        delete_verified_space_state(&transaction, boundary, did)?;
        // A sync already in flight holds the old generation, so its promotion
        // is refused and cannot write state back after the reset. Membership
        // itself is untouched.
        transaction
            .execute(
                "UPDATE pds_member_generation SET generation = generation + 1
                 WHERE boundary = ?1 AND did = ?2",
                params![boundary, did],
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)
    }

    /// Every boundary the member is a current PDS-custody member of.
    pub fn pds_member_boundaries(&self, did: &str) -> Result<Vec<String>, StoreError> {
        crate::identifier::Did::parse(did.to_owned())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        self.connection
            .prepare(
                "SELECT boundary FROM membership_baseline
                 WHERE did = ?1 AND custody = 'pds' ORDER BY boundary",
            )
            .map_err(StoreError::Open)?
            .query_map([did], |row| row.get(0))
            .map_err(StoreError::Open)?
            .collect::<Result<_, _>>()
            .map_err(StoreError::Open)
    }

    pub fn is_current_pds_space_member(
        &self,
        boundary: &str,
        did: &str,
    ) -> Result<bool, StoreError> {
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        crate::identifier::Did::parse(did.to_owned())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM membership_baseline WHERE boundary = ?1 AND did = ?2 AND custody = 'pds')",
                params![boundary, did],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)
    }
}

#[cfg(test)]
mod revocation_tests {
    use super::*;
    use crate::store::{ActorEnrollment, StorageKey};

    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const OTHER: &str = "did:web:stratos.example.test/trigun";
    const SPACE: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop";
    const DID: &str = "did:plc:fayevalentine";
    const OTHER_DID: &str = "did:plc:spiegel";
    const NOW: &str = "2026-09-22T00:00:00.000Z";
    const LATER: &str = "2026-09-22T00:01:00.000Z";

    fn store() -> EncryptedStore {
        EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap()
    }

    fn member(did: &str) -> PdsSpaceMember {
        PdsSpaceMember {
            did: did.to_owned(),
        }
    }

    fn verified_state_of(store: &EncryptedStore, did: &str) {
        store
            .connection
            .execute(
                "INSERT INTO space_repo_state (space_uri, did, boundary, host, generation, rev, set_hash, record_count, updated_at)
                 VALUES (?1, ?2, ?3, 'https://pds.bebop.example', 0, '3jzfcijpj2z2a', zeroblob(2048), 1, ?4)",
                params![SPACE, did, BOUNDARY, NOW],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO space_repo_record (space_uri, did, collection, rkey, boundary, cid)
                 VALUES (?1, ?2, 'app.bsky.graph.follow', 'faye', ?3, 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
                params![SPACE, did, BOUNDARY],
            )
            .unwrap();
    }

    fn verified_rows(store: &EncryptedStore, did: &str) -> (i64, i64) {
        let count = |table: &str| -> i64 {
            store
                .connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE did = ?1"),
                    [did],
                    |row| row.get(0),
                )
                .unwrap()
        };
        (count("space_repo_state"), count("space_repo_record"))
    }

    #[test]
    fn purging_a_departed_member_removes_the_verified_state_of_that_member_only() {
        let mut store = store();
        verified_state_of(&store, DID);
        verified_state_of(&store, OTHER_DID);
        assert_eq!(verified_rows(&store, DID), (1, 1));

        let transaction = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        purge_departed_pds_member(&transaction, BOUNDARY, DID).unwrap();
        transaction.commit().unwrap();

        assert_eq!(verified_rows(&store, DID), (0, 0));
        assert_eq!(verified_rows(&store, OTHER_DID), (1, 1));
    }

    /// What a verified sync does at generation `generation`: a replacement
    /// of the member's repo with the empty set under a commit over it.
    fn replace_with_nothing(
        store: &mut EncryptedStore,
        boundary: &str,
        space_uri: &str,
        generation: u64,
    ) -> Result<(), StoreError> {
        let target = crate::store::VerifiedSpaceTarget {
            boundary: boundary.to_owned(),
            space_uri: space_uri.to_owned(),
            actor_did: DID.to_owned(),
            host: "https://pds.bebop.example".to_owned(),
            generation,
        };
        let commit = crate::space_mac::MacVerifiedCommit::for_tests(
            DID,
            space_uri,
            "3jzfcijpj2z2a",
            crate::space_set_hash::SetHashState::empty().digest(),
        );
        store.replace_verified_space_repo(&target, &commit, &[], LATER, NOW)
    }

    fn verified_base_rev(store: &EncryptedStore, space_uri: &str) -> Option<String> {
        store
            .verified_space_base(space_uri, DID)
            .unwrap()
            .map(|base| base.rev)
    }

    fn trigun_space() -> String {
        SPACE.replace("/bebop", "/trigun")
    }

    #[test]
    fn enrollment_shrink_invalidates_only_the_removed_boundary() {
        let mut store = store();
        for boundary in [BOUNDARY, OTHER] {
            store
                .replace_pds_space_members(boundary, vec![member(DID), member(OTHER_DID)], NOW)
                .unwrap();
        }
        store
            .reconcile_actor_enrollment(
                DID,
                NOW,
                Some(ActorEnrollment {
                    did: DID.to_owned(),
                    boundaries: vec![BOUNDARY.to_owned(), OTHER.to_owned()],
                    observed_at: NOW.to_owned(),
                }),
            )
            .unwrap();
        let generation = store.pds_member_generation(BOUNDARY, DID).unwrap().unwrap();
        replace_with_nothing(&mut store, BOUNDARY, SPACE, generation).unwrap();
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_repo_state WHERE boundary = ?1 AND did = ?2",
                    params![BOUNDARY, DID],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let other_generation = store.pds_member_generation(OTHER, DID).unwrap().unwrap();
        replace_with_nothing(&mut store, OTHER, &trigun_space(), other_generation).unwrap();
        store
            .reconcile_actor_enrollment(
                DID,
                LATER,
                Some(ActorEnrollment {
                    did: DID.to_owned(),
                    boundaries: vec![OTHER.to_owned()],
                    observed_at: LATER.to_owned(),
                }),
            )
            .unwrap();

        assert_eq!(store.pds_member_generation(BOUNDARY, DID).unwrap(), None);
        assert!(store.is_current_pds_space_member(OTHER, DID).unwrap());
        assert!(verified_base_rev(&store, &trigun_space()).is_some());
        assert!(
            store
                .is_current_pds_space_member(BOUNDARY, OTHER_DID)
                .unwrap()
        );
        assert_eq!(verified_base_rev(&store, SPACE), None);
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_repo_state WHERE boundary = ?1 AND did = ?2",
                    params![BOUNDARY, DID],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(matches!(
            replace_with_nothing(&mut store, BOUNDARY, SPACE, generation),
            Err(StoreError::UnauthorizedSpaceMember)
        ));
    }

    #[test]
    fn first_enrollment_invalidates_an_unauthorized_pds_baseline() {
        let mut store = store();
        store
            .replace_pds_space_members(BOUNDARY, vec![member(DID)], NOW)
            .unwrap();
        let generation = store.pds_member_generation(BOUNDARY, DID).unwrap().unwrap();

        store
            .reconcile_actor_enrollment(
                DID,
                LATER,
                Some(ActorEnrollment {
                    did: DID.to_owned(),
                    boundaries: vec![OTHER.to_owned()],
                    observed_at: LATER.to_owned(),
                }),
            )
            .unwrap();

        assert_eq!(store.pds_member_generation(BOUNDARY, DID).unwrap(), None);
        assert!(matches!(
            replace_with_nothing(&mut store, BOUNDARY, SPACE, generation),
            Err(StoreError::UnauthorizedSpaceMember)
        ));
    }

    #[test]
    fn old_page_and_enumeration_fail_after_remove_and_readd() {
        let mut store = store();
        store
            .replace_pds_space_members(BOUNDARY, vec![member(DID)], NOW)
            .unwrap();
        let old_boundary = store.pds_boundary_generation(BOUNDARY).unwrap();
        let old_member = store.pds_member_generation(BOUNDARY, DID).unwrap().unwrap();
        store
            .replace_pds_space_members(BOUNDARY, Vec::new(), LATER)
            .unwrap();
        assert!(matches!(
            store.replace_pds_space_members_at_generation(
                BOUNDARY,
                vec![member(DID)],
                LATER,
                old_boundary
            ),
            Err(StoreError::UnauthorizedSpaceMember)
        ));
        store
            .replace_pds_space_members(BOUNDARY, vec![member(DID)], LATER)
            .unwrap();
        assert_ne!(
            store.pds_member_generation(BOUNDARY, DID).unwrap(),
            Some(old_member)
        );
        assert!(matches!(
            replace_with_nothing(&mut store, BOUNDARY, SPACE, old_member),
            Err(StoreError::UnauthorizedSpaceMember)
        ));
        let fresh = store.pds_member_generation(BOUNDARY, DID).unwrap().unwrap();
        replace_with_nothing(&mut store, BOUNDARY, SPACE, fresh).unwrap();
        assert!(verified_base_rev(&store, SPACE).is_some());
    }

    #[test]
    fn full_unenrollment_removes_private_rows_and_survives_reopen() {
        let path = std::env::current_dir().unwrap().join(format!(
            "stratos-pds-revocation-{}-{}.sqlite",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_file(&path);
        let old_generation;
        {
            let mut store = EncryptedStore::open(&path, StorageKey::from_bytes([8; 32])).unwrap();
            store
                .replace_pds_space_members(BOUNDARY, vec![member(DID), member(OTHER_DID)], NOW)
                .unwrap();
            store
                .reconcile_actor_enrollment(
                    DID,
                    NOW,
                    Some(ActorEnrollment {
                        did: DID.to_owned(),
                        boundaries: vec![BOUNDARY.to_owned()],
                        observed_at: NOW.to_owned(),
                    }),
                )
                .unwrap();
            old_generation = store.pds_member_generation(BOUNDARY, DID).unwrap().unwrap();
            store
                .publish_verified_records(
                    BOUNDARY,
                    SPACE,
                    DID,
                    &[(
                        "zone.stratos.feed.post",
                        "see-you",
                        serde_json::json!({ "$type": "zone.stratos.feed.post", "createdAt": NOW }),
                    )],
                    LATER,
                    LATER,
                )
                .unwrap();
            assert_eq!(
                store
                    .connection
                    .query_row(
                        "SELECT COUNT(*) FROM post WHERE author_did = ?1",
                        [DID],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
            store.reconcile_actor_enrollment(DID, LATER, None).unwrap();
            assert_eq!(
                store
                    .connection
                    .query_row(
                        "SELECT COUNT(*) FROM post WHERE author_did = ?1",
                        [DID],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert_eq!(
                store
                    .connection
                    .query_row(
                        "SELECT COUNT(*) FROM space_repo_state WHERE did = ?1",
                        [DID],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
            assert!(
                store
                    .is_current_pds_space_member(BOUNDARY, OTHER_DID)
                    .unwrap()
            );
        }
        {
            let mut store = EncryptedStore::open(&path, StorageKey::from_bytes([8; 32])).unwrap();
            assert_eq!(store.pds_member_generation(BOUNDARY, DID).unwrap(), None);
            assert!(
                store
                    .is_current_pds_space_member(BOUNDARY, OTHER_DID)
                    .unwrap()
            );
            store
                .replace_pds_space_members(BOUNDARY, vec![member(DID), member(OTHER_DID)], LATER)
                .unwrap();
            assert_ne!(
                store.pds_member_generation(BOUNDARY, DID).unwrap(),
                Some(old_generation)
            );
            assert!(matches!(
                replace_with_nothing(&mut store, BOUNDARY, SPACE, old_generation),
                Err(StoreError::UnauthorizedSpaceMember)
            ));
        }
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod row_scope_tests {
    use super::*;
    use crate::store::StorageKey;

    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const SPACE: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop";
    const FAYE: &str = "did:plc:fayevalentine";
    const NOW: &str = "2026-09-22T00:00:00.000Z";
    const RETAINED: &str = "2026-09-23T00:00:00.000Z";

    fn post_row(uri: &str) -> SpaceStageRow {
        SpaceStageRow {
            uri: uri.to_owned(),
            boundary: BOUNDARY.to_owned(),
            deleted: false,
            cid: Some("bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned()),
            sort_at: Some(NOW.to_owned()),
            indexed_at: Some(NOW.to_owned()),
            record_json: Some(br#"{"$type":"zone.stratos.feed.post","text":"Bang"}"#.to_vec()),
            blob_refs_json: Some(b"[]".to_vec()),
            updated_at: NOW.to_owned(),
        }
    }

    fn apply_for_faye(store: &mut EncryptedStore, row: SpaceStageRow) -> Result<(), StoreError> {
        let transaction = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_verified_space_stage_row(&transaction, SPACE, FAYE, RETAINED, row)?;
        transaction.commit().unwrap();
        Ok(())
    }

    fn posts(store: &EncryptedStore) -> Vec<String> {
        store
            .connection
            .prepare("SELECT uri FROM post ORDER BY uri")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    // The verified path builds every row from its target, so only a direct
    // call can hand the store a row for some other space or author.
    #[test]
    fn a_row_outside_the_targets_space_or_author_is_refused_and_writes_nothing() {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        for (case, uri) in [
            (
                "another space under the same authority",
                "at:space/did:web:stratos.example.test/zone.stratos.space.feed/trigun/did:plc:fayevalentine/zone.stratos.feed.post/bang",
            ),
            (
                "another authority",
                "at:space/did:web:red-tail.example/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/bang",
            ),
            (
                "another author",
                "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/bang",
            ),
        ] {
            let outcome = apply_for_faye(&mut store, post_row(uri));
            assert!(
                matches!(outcome, Err(StoreError::InvalidProjectionMutation)),
                "{case}: {outcome:?}"
            );
            assert!(posts(&store).is_empty(), "{case}");
        }

        let own = format!("{SPACE}/{FAYE}/zone.stratos.feed.post/bang");
        apply_for_faye(&mut store, post_row(&own)).unwrap();
        assert_eq!(posts(&store), [own]);
    }
}
