use super::*;

fn is_space_uri(value: &str) -> bool {
    let segments: Vec<_> = value
        .strip_prefix("at://")
        .unwrap_or_default()
        .split('/')
        .collect();
    matches!(segments.as_slice(), [authority, "space", space_type, space_key]
        if crate::identifier::RecordUri::parse(&format!("at://{authority}/space/{space_type}/{space_key}/did:plc:spikespiegel/zone.stratos.feed.post/x")).is_ok())
}

fn validate_space_stage_page(page: &SpaceStagePage) -> Result<(), StoreError> {
    crate::identifier::Did::parse(page.actor_did.clone())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if !is_space_uri(&page.space_uri)
        || page.boundary.is_empty()
        || page.next_cursor.as_deref().is_some_and(str::is_empty)
        || !is_utc_timestamp(&page.updated_at)
    {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

fn stage_space_mutation(
    transaction: &rusqlite::Transaction<'_>,
    page: &SpaceStagePage,
    mutation: SpaceStageMutation,
) -> Result<(), StoreError> {
    match mutation {
        SpaceStageMutation::Upsert {
            uri,
            cid,
            sort_at,
            indexed_at,
            record_json,
            blob_refs_json,
        } => {
            validate_space_stage_uri(page, &uri)?;
            if cid.is_empty() || !is_utc_timestamp(&sort_at) || !is_utc_timestamp(&indexed_at) {
                return Err(StoreError::InvalidProjectionMutation);
            }
            transaction
                .execute(
                    "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, cid, sort_at, indexed_at, record_json, blob_refs_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(space_uri, did, uri) DO UPDATE SET boundary = excluded.boundary,
                       deleted = excluded.deleted, cid = excluded.cid, sort_at = excluded.sort_at,
                       indexed_at = excluded.indexed_at, record_json = excluded.record_json,
                       blob_refs_json = excluded.blob_refs_json, updated_at = excluded.updated_at",
                    params![
                        page.space_uri,
                        page.actor_did,
                        uri,
                        page.boundary,
                        cid,
                        sort_at,
                        indexed_at,
                        record_json,
                        blob_refs_json,
                        page.updated_at,
                    ],
                )
                .map_err(StoreError::Open)?;
        }
        SpaceStageMutation::Delete { uri } => {
            validate_space_stage_uri(page, &uri)?;
            transaction
                .execute(
                    "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, cid, sort_at, indexed_at, record_json, blob_refs_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 1, NULL, NULL, NULL, NULL, NULL, ?5)
                     ON CONFLICT(space_uri, did, uri) DO UPDATE SET boundary = excluded.boundary,
                       deleted = excluded.deleted, cid = NULL, sort_at = NULL, indexed_at = NULL,
                       record_json = NULL, blob_refs_json = NULL, updated_at = excluded.updated_at",
                    params![
                        page.space_uri,
                        page.actor_did,
                        uri,
                        page.boundary,
                        page.updated_at,
                    ],
                )
                .map_err(StoreError::Open)?;
        }
    }
    Ok(())
}

fn validate_space_stage_uri(page: &SpaceStagePage, value: &str) -> Result<(), StoreError> {
    let uri = crate::identifier::RecordUri::parse(value)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if !matches!(uri, crate::identifier::RecordUri::Space { .. })
        || uri.author().as_str() != page.actor_did
        || !value.starts_with(&format!("{}/", page.space_uri))
    {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

fn update_space_stage_checkpoint(
    transaction: &rusqlite::Transaction<'_>,
    page: &SpaceStagePage,
) -> Result<(), StoreError> {
    if let Some(cursor) = &page.next_cursor {
        transaction
            .execute(
                "DELETE FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2",
                params![page.space_uri, page.actor_did],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "INSERT INTO space_sync_stage_cursor (space_uri, did, boundary, cursor, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary,
                   cursor = excluded.cursor, updated_at = excluded.updated_at",
                params![page.space_uri, page.actor_did, page.boundary, cursor, page.updated_at],
            )
            .map_err(StoreError::Open)?;
    } else {
        transaction
            .execute(
                "INSERT INTO space_sync_pending_verification (space_uri, did, boundary, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary,
                   updated_at = excluded.updated_at",
                params![page.space_uri, page.actor_did, page.boundary, page.updated_at],
            )
            .map_err(StoreError::Open)?;
    }
    Ok(())
}

fn validate_space_stage_scope(space_uri: &str, actor_did: &str) -> Result<(), StoreError> {
    crate::identifier::Did::parse(actor_did.to_string())
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    if !is_space_uri(space_uri) {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

fn promote_space_stage_transaction(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    retained_at: &str,
) -> Result<(), StoreError> {
    let pending: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2",
            params![space_uri, actor_did],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)?;
    if pending.is_none() {
        return Err(StoreError::UnverifiedSpaceStage);
    }
    let mut after_uri = None;
    loop {
        let stages =
            load_space_stage_rows(transaction, space_uri, actor_did, after_uri.as_deref())?;
        let Some(last_uri) = stages.last().map(|stage| stage.uri.clone()) else {
            break;
        };
        for stage in stages {
            apply_verified_space_stage_row(transaction, space_uri, actor_did, retained_at, stage)?;
        }
        after_uri = Some(last_uri);
    }
    transaction
        .execute(
            "DELETE FROM space_sync_stage WHERE space_uri = ?1 AND did = ?2",
            params![space_uri, actor_did],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "INSERT INTO space_cursor (space_uri, did, boundary, cursor, updated_at)
             SELECT space_uri, did, boundary, cursor, updated_at
             FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2
             ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary,
               cursor = excluded.cursor, updated_at = excluded.updated_at",
            params![space_uri, actor_did],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2",
            params![space_uri, actor_did],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2",
            params![space_uri, actor_did],
        )
        .map_err(StoreError::Open)?;
    Ok(())
}

fn load_space_stage_rows(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    after_uri: Option<&str>,
) -> Result<Vec<SpaceStageRow>, StoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT uri, boundary, deleted, cid, sort_at, indexed_at, record_json, blob_refs_json, updated_at
             FROM space_sync_stage WHERE space_uri = ?1 AND did = ?2 AND (?3 IS NULL OR uri > ?3)
             ORDER BY uri ASC LIMIT ?4",
        )
        .map_err(StoreError::Open)?;
    statement
        .query_map(
            params![
                space_uri,
                actor_did,
                after_uri,
                i64::from(MAX_SPACE_PROMOTION_BATCH),
            ],
            |row| {
                Ok(SpaceStageRow {
                    uri: row.get(0)?,
                    boundary: row.get(1)?,
                    deleted: row.get::<_, i64>(2)? != 0,
                    cid: row.get(3)?,
                    sort_at: row.get(4)?,
                    indexed_at: row.get(5)?,
                    record_json: row.get(6)?,
                    blob_refs_json: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .map_err(StoreError::Open)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::Open)
}

fn apply_verified_space_stage_row(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    retained_at: &str,
    stage: SpaceStageRow,
) -> Result<(), StoreError> {
    let page = SpaceStagePage {
        space_uri: space_uri.to_string(),
        actor_did: actor_did.to_string(),
        boundary: stage.boundary.clone(),
        next_cursor: None,
        updated_at: stage.updated_at.clone(),
    };
    validate_space_stage_page(&page)?;
    validate_space_stage_uri(&page, &stage.uri)?;
    if stage.deleted {
        if stage.cid.is_some()
            || stage.sort_at.is_some()
            || stage.indexed_at.is_some()
            || stage.record_json.is_some()
            || stage.blob_refs_json.is_some()
        {
            return Err(StoreError::InvalidProjectionMutation);
        }
        transaction
            .execute("DELETE FROM post WHERE uri = ?1", [&stage.uri])
            .map_err(StoreError::Open)?;
        return Ok(());
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

fn purge_departed_pds_member(
    transaction: &rusqlite::Transaction<'_>,
    boundary: &str,
    did: &str,
) -> Result<(), StoreError> {
    let (authority, _) = boundary
        .split_once('/')
        .ok_or(StoreError::InvalidProjectionMutation)?;
    let space_prefix = format!("at://{authority}/space/");
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
    transaction
        .execute(
            "DELETE FROM space_cursor WHERE did = ?1 AND boundary = ?2",
            params![did, boundary],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM space_sync_stage_cursor WHERE did = ?1 AND boundary = ?2",
            params![did, boundary],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM space_sync_pending_verification WHERE did = ?1 AND boundary = ?2",
            params![did, boundary],
        )
        .map_err(StoreError::Open)?;
    transaction
        .execute(
            "DELETE FROM space_sync_stage WHERE did = ?1 AND boundary = ?2",
            params![did, boundary],
        )
        .map_err(StoreError::Open)?;
    Ok(())
}

fn has_current_pds_space_member(
    transaction: &rusqlite::Transaction<'_>,
    boundary: &str,
    did: &str,
) -> Result<bool, StoreError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM membership_baseline WHERE boundary = ?1 AND did = ?2 AND custody = 'pds')",
            params![boundary, did],
            |row| row.get(0),
        )
        .map_err(StoreError::Open)
}

impl EncryptedStore {
    pub fn replace_pds_space_members(
        &mut self,
        boundary: &str,
        members: Vec<PdsSpaceMember>,
        reconciled_at: &str,
    ) -> Result<(), StoreError> {
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
        }
        for member in members {
            transaction
                .execute(
                    "INSERT INTO membership_baseline (boundary, did, custody, repo_host, reconciled_at) VALUES (?1, ?2, 'pds', NULL, ?3)",
                    params![boundary, member.did, reconciled_at],
                )
                .map_err(StoreError::Open)?;
        }
        transaction.commit().map_err(StoreError::Open)
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

    pub fn space_sync_cursor(
        &self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<Option<String>, StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        self.connection
            .query_row(
                "SELECT COALESCE(
                   (SELECT cursor FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3),
                   (SELECT cursor FROM space_cursor WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3)
                 )",
                params![space_uri, actor_did, boundary],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)
    }

    pub fn stage_authorized_space_page(
        &mut self,
        page: SpaceStagePage,
        mutations: Vec<SpaceStageMutation>,
    ) -> Result<(), StoreError> {
        validate_space_stage_page(&page)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        if !has_current_pds_space_member(&transaction, &page.boundary, &page.actor_did)? {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        for mutation in mutations {
            stage_space_mutation(&transaction, &page, mutation)?;
        }
        update_space_stage_checkpoint(&transaction, &page)?;
        transaction.commit().map_err(StoreError::Open)
    }

    #[cfg(test)]
    pub(crate) fn promote_verified_space_stage(
        &mut self,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if !is_utc_timestamp(retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        promote_space_stage_transaction(&transaction, space_uri, actor_did, retained_at)?;
        transaction.commit().map_err(StoreError::Open)
    }

    pub fn promote_authorized_space_stage(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if boundary.is_empty() || !is_utc_timestamp(retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        if !has_current_pds_space_member(&transaction, boundary, actor_did)? {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        promote_space_stage_transaction(&transaction, space_uri, actor_did, retained_at)?;
        transaction.commit().map_err(StoreError::Open)
    }

    /// Removes unverified staging data without requiring current membership.
    pub fn discard_unverified_space_stage(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3",
                params![space_uri, actor_did, boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3",
                params![space_uri, actor_did, boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3",
                params![space_uri, actor_did, boundary],
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)
    }

    #[cfg(test)]
    pub(crate) fn stage_space_page(
        &mut self,
        page: SpaceStagePage,
        mutations: Vec<SpaceStageMutation>,
    ) -> Result<(), StoreError> {
        validate_space_stage_page(&page)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        for mutation in mutations {
            stage_space_mutation(&transaction, &page, mutation)?;
        }
        update_space_stage_checkpoint(&transaction, &page)?;
        transaction.commit().map_err(StoreError::Open)
    }
}
