use super::*;
use crate::config::{MAX_SPACE_PROMOTION_STAGE_BYTES, MAX_SPACE_PROMOTION_STAGE_ROWS};

type PreviousStage = (i64, Option<String>, Option<Vec<u8>>, Option<Vec<u8>>);

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
) -> Result<bool, StoreError> {
    let uri = match &mutation {
        SpaceStageMutation::Upsert { uri, .. } | SpaceStageMutation::Delete { uri } => uri,
    };
    let previous: Option<PreviousStage> = transaction
        .query_row(
            "SELECT deleted, cid, record_json, blob_refs_json FROM space_sync_stage WHERE space_uri = ?1 AND did = ?2 AND uri = ?3",
            params![page.space_uri, page.actor_did, uri],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(StoreError::Open)?;
    let changed = match &mutation {
        SpaceStageMutation::Upsert {
            cid,
            record_json,
            blob_refs_json,
            ..
        } => previous.as_ref().is_none_or(|old| {
            old.0 != 0
                || old.1.as_ref() != Some(cid)
                || old.2.as_ref() != Some(record_json)
                || old.3.as_ref() != Some(blob_refs_json)
        }),
        SpaceStageMutation::Delete { .. } => previous.as_ref().is_none_or(|old| old.0 != 1),
    };
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
    Ok(changed)
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
) -> Result<bool, StoreError> {
    let previous_cursor: Option<String> = transaction
        .query_row(
            "SELECT cursor FROM space_sync_stage_cursor WHERE space_uri = ?1 AND did = ?2",
            params![page.space_uri, page.actor_did],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)?;
    let pending: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM space_sync_pending_verification WHERE space_uri = ?1 AND did = ?2)",
        params![page.space_uri, page.actor_did], |row| row.get(0),
    ).map_err(StoreError::Open)?;
    let progressed = match &page.next_cursor {
        Some(cursor) => previous_cursor.as_ref() != Some(cursor) || pending,
        None => !pending,
    };
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
    Ok(progressed)
}

fn create_stage_lifetime(
    transaction: &rusqlite::Transaction<'_>,
    page: &SpaceStagePage,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO space_sync_stage_lifetime (space_uri, did, boundary, created_at, last_progress_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(space_uri, did) DO UPDATE SET boundary = excluded.boundary",
        params![page.space_uri, page.actor_did, page.boundary, page.updated_at],
    ).map_err(StoreError::Open)?;
    Ok(())
}

fn record_stage_progress(
    transaction: &rusqlite::Transaction<'_>,
    page: &SpaceStagePage,
) -> Result<(), StoreError> {
    transaction
        .execute(
            "UPDATE space_sync_stage_lifetime SET last_progress_at = ?3
         WHERE space_uri = ?1 AND did = ?2",
            params![page.space_uri, page.actor_did, page.updated_at],
        )
        .map_err(StoreError::Open)?;
    Ok(())
}

pub(super) struct StageUsage {
    pub rows: i64,
    pub bytes: i64,
}

pub(super) fn stage_usage(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: Option<&str>,
    did: Option<&str>,
) -> Result<StageUsage, StoreError> {
    let mut usage = StageUsage { rows: 0, bytes: 0 };
    for query in [
        "SELECT COUNT(*), COALESCE(SUM(length(space_uri) + length(did) + length(uri) + length(boundary) +
          COALESCE(length(cid), 0) + COALESCE(length(sort_at), 0) + COALESCE(length(indexed_at), 0) +
          COALESCE(length(record_json), 0) + COALESCE(length(blob_refs_json), 0) + length(updated_at)), 0)
         FROM space_sync_stage WHERE (?1 IS NULL OR space_uri = ?1) AND (?2 IS NULL OR did = ?2)",
        "SELECT COUNT(*), COALESCE(SUM(length(space_uri) + length(did) + length(boundary) +
          length(CAST(cursor AS BLOB)) + length(updated_at)), 0)
         FROM space_sync_stage_cursor WHERE (?1 IS NULL OR space_uri = ?1) AND (?2 IS NULL OR did = ?2)",
        "SELECT COUNT(*), COALESCE(SUM(length(space_uri) + length(did) + length(boundary) +
          length(updated_at)), 0)
         FROM space_sync_pending_verification WHERE (?1 IS NULL OR space_uri = ?1) AND (?2 IS NULL OR did = ?2)",
        "SELECT COUNT(*), COALESCE(SUM(length(space_uri) + length(did) + length(boundary) +
          length(created_at) + length(last_progress_at)), 0)
         FROM space_sync_stage_lifetime WHERE (?1 IS NULL OR space_uri = ?1) AND (?2 IS NULL OR did = ?2)",
    ] {
        let (rows, bytes): (i64, i64) = transaction
            .query_row(query, params![space_uri, did], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(StoreError::Open)?;
        usage.rows = usage
            .rows
            .checked_add(rows)
            .ok_or(StoreError::SpaceStageLimit)?;
        usage.bytes = usage
            .bytes
            .checked_add(bytes)
            .ok_or(StoreError::SpaceStageLimit)?;
    }
    Ok(usage)
}

fn enforce_stage_budget(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
) -> Result<StageUsage, StoreError> {
    let maximum: i64 = transaction
        .query_row(
            "SELECT value FROM retention_metadata WHERE key = 'projection_max_bytes'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)?
        .unwrap_or(crate::config::MEMORY_RETENTION_MAX_BYTES as i64);
    let budget = stage_budget(transaction, maximum)?;
    let target = stage_usage(transaction, Some(space_uri), Some(actor_did))?;
    let global = stage_usage(transaction, None, None)?;
    let published_bytes: i64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(projection_bytes), 0) FROM post",
            [],
            |row| row.get(0),
        )
        .map_err(StoreError::Open)?;
    let reason = if target.rows > budget.target_rows {
        Some("target_rows")
    } else if target.bytes > budget.target_bytes {
        Some("target_bytes")
    } else if global.rows > budget.global_rows {
        Some("global_rows")
    } else if global.bytes > budget.global_bytes {
        Some("global_bytes")
    } else if global
        .bytes
        .checked_add(published_bytes)
        .is_none_or(|used| used > maximum)
    {
        Some("projection_bytes")
    } else {
        None
    };
    if let Some(reason) = reason {
        eprintln!(
            "event=space_stage_budget_rejected target_rows={} target_bytes={} global_rows={} global_bytes={} reason={reason}",
            target.rows, target.bytes, global.rows, global.bytes,
        );
        return Err(StoreError::SpaceStageLimit);
    }
    Ok(target)
}

fn stage_budget(
    transaction: &rusqlite::Transaction<'_>,
    maximum: i64,
) -> Result<StageUsageBudget, StoreError> {
    let defaults = crate::config::SpaceStageBudget::for_projection(maximum as u64)
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
    let read = |key: &str, default: u64| -> Result<i64, StoreError> {
        transaction
            .query_row(
                "SELECT value FROM retention_metadata WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?
            .map_or_else(
                || i64::try_from(default).map_err(|_| StoreError::InvalidProjectionMutation),
                Ok,
            )
    };
    Ok(StageUsageBudget {
        target_rows: read("stage_target_max_rows", defaults.target_rows)?,
        global_rows: read("stage_global_max_rows", defaults.global_rows)?,
        target_bytes: read("stage_target_max_bytes", defaults.target_bytes)?,
        global_bytes: read("stage_global_max_bytes", defaults.global_bytes)?,
    })
}

struct StageUsageBudget {
    target_rows: i64,
    global_rows: i64,
    target_bytes: i64,
    global_bytes: i64,
}

fn pass_observed_at_from_retention_deadline(
    connection: &rusqlite::Connection,
    retained_at: &str,
) -> Result<String, StoreError> {
    let maximum_age_ms: Option<i64> = connection
        .query_row(
            "SELECT value FROM retention_metadata WHERE key = 'projection_max_age_ms'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)?;
    let Some(maximum_age_ms) = maximum_age_ms else {
        return Ok(retained_at.to_owned());
    };
    let deadline =
        time::OffsetDateTime::parse(retained_at, &time::format_description::well_known::Rfc3339)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
    // Retained-at is the post's future deadline, not the promotion time.
    let observed_at = deadline
        .checked_sub(time::Duration::milliseconds(maximum_age_ms))
        .ok_or(StoreError::InvalidProjectionMutation)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        observed_at.year(),
        u8::from(observed_at.month()),
        observed_at.day(),
        observed_at.hour(),
        observed_at.minute(),
        observed_at.second(),
        observed_at.millisecond()
    ))
}

fn ensure_stage_live(
    transaction: &rusqlite::Transaction<'_>,
    space_uri: &str,
    actor_did: &str,
    observed_at: &str,
) -> Result<(), StoreError> {
    let maximum_age_ms: Option<i64> = transaction
        .query_row(
            "SELECT value FROM retention_metadata WHERE key = 'projection_max_age_ms'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::Open)?;
    let Some(maximum_age_ms) = maximum_age_ms else {
        return Ok(());
    };
    let lifetime: Option<(String, String)> = transaction.query_row(
        "SELECT created_at, last_progress_at FROM space_sync_stage_lifetime WHERE space_uri = ?1 AND did = ?2",
        params![space_uri, actor_did], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(StoreError::Open)?;
    let Some((created_at, last_progress_at)) = lifetime else {
        return Ok(());
    };
    let now =
        time::OffsetDateTime::parse(observed_at, &time::format_description::well_known::Rfc3339)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
    let cutoff = now
        .checked_sub(time::Duration::milliseconds(maximum_age_ms))
        .ok_or(StoreError::InvalidProjectionMutation)?;
    let cutoff = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        cutoff.year(),
        u8::from(cutoff.month()),
        cutoff.day(),
        cutoff.hour(),
        cutoff.minute(),
        cutoff.second(),
        cutoff.millisecond()
    );
    if created_at <= cutoff || last_progress_at <= cutoff {
        return Err(StoreError::ExpiredSpaceStage);
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
    let target = enforce_stage_budget(transaction, space_uri, actor_did)?;
    if target.rows > MAX_SPACE_PROMOTION_STAGE_ROWS
        || target.bytes > MAX_SPACE_PROMOTION_STAGE_BYTES
    {
        return Err(StoreError::SpacePromotionLimit);
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
    transaction
        .execute(
            "DELETE FROM space_sync_stage_lifetime WHERE space_uri = ?1 AND did = ?2",
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
    transaction
        .execute(
            "DELETE FROM space_sync_stage_lifetime WHERE did = ?1 AND boundary = ?2",
            params![did, boundary],
        )
        .map_err(StoreError::Open)?;
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
    Ok(())
}

fn has_pds_member_generation(
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
        let generation = self
            .pds_member_generation(&page.boundary, &page.actor_did)?
            .ok_or(StoreError::UnauthorizedSpaceMember)?;
        self.stage_authorized_space_page_at_generation(page, mutations, generation)
    }

    pub fn stage_authorized_space_page_at_generation(
        &mut self,
        page: SpaceStagePage,
        mutations: Vec<SpaceStageMutation>,
        generation: u64,
    ) -> Result<(), StoreError> {
        validate_space_stage_page(&page)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        if !has_pds_member_generation(&transaction, &page.boundary, &page.actor_did, generation)? {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        ensure_stage_live(
            &transaction,
            &page.space_uri,
            &page.actor_did,
            &page.updated_at,
        )?;
        let mut progressed = false;
        for mutation in mutations {
            progressed |= stage_space_mutation(&transaction, &page, mutation)?;
        }
        progressed |= update_space_stage_checkpoint(&transaction, &page)?;
        create_stage_lifetime(&transaction, &page)?;
        if progressed {
            record_stage_progress(&transaction, &page)?;
        }
        enforce_stage_budget(&transaction, &page.space_uri, &page.actor_did)?;
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
        let generation = self
            .pds_member_generation(boundary, actor_did)?
            .ok_or(StoreError::UnauthorizedSpaceMember)?;
        let observed_at = pass_observed_at_from_retention_deadline(&self.connection, retained_at)?;
        self.promote_authorized_space_stage_at_generation(
            boundary,
            space_uri,
            actor_did,
            retained_at,
            &observed_at,
            generation,
        )
    }

    pub fn promote_authorized_space_stage_at_generation(
        &mut self,
        boundary: &str,
        space_uri: &str,
        actor_did: &str,
        retained_at: &str,
        observed_at: &str,
        generation: u64,
    ) -> Result<(), StoreError> {
        validate_space_stage_scope(space_uri, actor_did)?;
        if boundary.is_empty() || !is_utc_timestamp(retained_at) || !is_utc_timestamp(observed_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        if !has_pds_member_generation(&transaction, boundary, actor_did, generation)? {
            return Err(StoreError::UnauthorizedSpaceMember);
        }
        ensure_stage_live(&transaction, space_uri, actor_did, observed_at)?;
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
        transaction.execute("DELETE FROM space_sync_stage_lifetime WHERE space_uri = ?1 AND did = ?2 AND boundary = ?3", params![space_uri, actor_did, boundary]).map_err(StoreError::Open)?;
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
        ensure_stage_live(
            &transaction,
            &page.space_uri,
            &page.actor_did,
            &page.updated_at,
        )?;
        let mut progressed = false;
        for mutation in mutations {
            progressed |= stage_space_mutation(&transaction, &page, mutation)?;
        }
        progressed |= update_space_stage_checkpoint(&transaction, &page)?;
        create_stage_lifetime(&transaction, &page)?;
        if progressed {
            record_stage_progress(&transaction, &page)?;
        }
        enforce_stage_budget(&transaction, &page.space_uri, &page.actor_did)?;
        transaction.commit().map_err(StoreError::Open)
    }
}

#[cfg(test)]
mod revocation_tests {
    use super::*;
    use crate::store::{ActorEnrollment, StorageKey};

    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const OTHER: &str = "did:web:stratos.example.test/trigun";
    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
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

    fn page() -> SpaceStagePage {
        SpaceStagePage {
            space_uri: SPACE.to_owned(),
            actor_did: DID.to_owned(),
            boundary: BOUNDARY.to_owned(),
            next_cursor: Some("pending".to_owned()),
            updated_at: NOW.to_owned(),
        }
    }

    fn private_mutation() -> SpaceStageMutation {
        SpaceStageMutation::Upsert {
            uri: format!("{SPACE}/{DID}/zone.stratos.feed.post/see-you"),
            cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            sort_at: NOW.to_owned(),
            indexed_at: NOW.to_owned(),
            record_json: br#"{"$type":"zone.stratos.feed.post"}"#.to_vec(),
            blob_refs_json: b"[]".to_vec(),
        }
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
        store
            .stage_authorized_space_page_at_generation(page(), vec![private_mutation()], generation)
            .unwrap();
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_sync_stage WHERE boundary = ?1 AND did = ?2",
                    params![BOUNDARY, DID],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let other_generation = store.pds_member_generation(OTHER, DID).unwrap().unwrap();
        let mut other_page = page();
        other_page.boundary = OTHER.to_owned();
        other_page.space_uri = SPACE.replace("/bebop", "/crew");
        store
            .stage_authorized_space_page_at_generation(other_page, Vec::new(), other_generation)
            .unwrap();
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
        assert_eq!(
            store
                .space_sync_cursor(OTHER, &SPACE.replace("/bebop", "/crew"), DID)
                .unwrap(),
            Some("pending".to_owned())
        );
        assert!(
            store
                .is_current_pds_space_member(BOUNDARY, OTHER_DID)
                .unwrap()
        );
        assert_eq!(store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(), None);
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM space_sync_stage WHERE boundary = ?1 AND did = ?2",
                    params![BOUNDARY, DID],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(matches!(
            store.stage_authorized_space_page_at_generation(page(), Vec::new(), generation),
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
            store.stage_authorized_space_page_at_generation(page(), Vec::new(), generation),
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
            store.stage_authorized_space_page_at_generation(page(), Vec::new(), old_member),
            Err(StoreError::UnauthorizedSpaceMember)
        ));
        assert!(matches!(
            store.promote_authorized_space_stage_at_generation(
                BOUNDARY, SPACE, DID, LATER, LATER, old_member
            ),
            Err(StoreError::UnauthorizedSpaceMember)
        ));
        let fresh = store.pds_member_generation(BOUNDARY, DID).unwrap().unwrap();
        store
            .stage_authorized_space_page_at_generation(page(), Vec::new(), fresh)
            .unwrap();
        assert_eq!(
            store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(),
            Some("pending".to_owned())
        );
    }

    #[test]
    fn departed_member_purges_stage_lifetime() {
        let mut store = store();
        store
            .replace_pds_space_members(BOUNDARY, vec![member(DID)], NOW)
            .unwrap();
        store
            .stage_authorized_space_page(page(), Vec::new())
            .unwrap();
        store
            .replace_pds_space_members(BOUNDARY, Vec::new(), LATER)
            .unwrap();
        let remaining: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM space_sync_stage_lifetime WHERE did = ?1 AND boundary = ?2",
                params![DID, BOUNDARY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn full_unenrollment_removes_private_rows_and_survives_reopen() {
        let path = std::env::current_dir().unwrap().join(format!(
            "stratos-pds-revocation-{}-{}.sqlite",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_file(&path);
        let uri = format!("{SPACE}/{DID}/zone.stratos.feed.post/see-you");
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
            let mutation = SpaceStageMutation::Upsert {
                uri: uri.clone(),
                cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                sort_at: NOW.to_owned(),
                indexed_at: NOW.to_owned(),
                record_json: br#"{"$type":"zone.stratos.feed.post"}"#.to_vec(),
                blob_refs_json: b"[]".to_vec(),
            };
            let mut terminal = page();
            terminal.next_cursor = None;
            store
                .stage_authorized_space_page_at_generation(terminal, vec![mutation], old_generation)
                .unwrap();
            store
                .promote_authorized_space_stage_at_generation(
                    BOUNDARY,
                    SPACE,
                    DID,
                    LATER,
                    LATER,
                    old_generation,
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
            store
                .stage_authorized_space_page_at_generation(page(), Vec::new(), old_generation)
                .unwrap();
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
                        "SELECT COUNT(*) FROM space_sync_stage_cursor WHERE did = ?1",
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
                store.stage_authorized_space_page_at_generation(page(), Vec::new(), old_generation),
                Err(StoreError::UnauthorizedSpaceMember)
            ));
        }
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod stage_limit_tests {
    use super::*;
    use crate::store::StorageKey;

    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const DID: &str = "did:plc:fayevalentine";
    const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
    const NOW: &str = "2026-09-22T00:00:00.000Z";

    fn store(maximum: i64) -> EncryptedStore {
        let store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .connection
            .execute(
                "INSERT INTO retention_metadata (key, value) VALUES ('projection_max_bytes', ?1)",
                [maximum],
            )
            .unwrap();
        store
    }

    fn page(cursor: &str) -> SpaceStagePage {
        SpaceStagePage {
            space_uri: SPACE.to_owned(),
            actor_did: DID.to_owned(),
            boundary: BOUNDARY.to_owned(),
            next_cursor: Some(cursor.to_owned()),
            updated_at: NOW.to_owned(),
        }
    }

    fn upsert(index: usize, payload_bytes: usize) -> SpaceStageMutation {
        SpaceStageMutation::Upsert {
            uri: format!("{SPACE}/{DID}/zone.stratos.feed.post/{index}"),
            cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            sort_at: NOW.to_owned(),
            indexed_at: NOW.to_owned(),
            record_json: vec![b'x'; payload_bytes],
            blob_refs_json: b"[]".to_vec(),
        }
    }

    #[test]
    fn stage_budget_persists_across_small_passes_and_rolls_back_rejected_page() {
        let mut store = store(8_000);
        let mut accepted = 0;
        for index in 0..10 {
            match store.stage_space_page(page(&format!("cursor-{index}")), vec![upsert(index, 400)])
            {
                Ok(()) => accepted += 1,
                Err(StoreError::SpaceStageLimit) => break,
                Err(error) => panic!("unexpected stage error: {error:?}"),
            }
        }
        assert!(accepted > 1 && accepted < 10);
        let rows: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, accepted);
        assert_eq!(
            store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(),
            Some(format!("cursor-{}", accepted - 1))
        );
    }

    #[test]
    fn compaction_reserves_global_stage_capacity_before_published_posts_fill_the_cap() {
        let mut store = store(10_000);
        store
            .connection
            .execute(
                "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, 0)",
                params![
                    format!("{SPACE}/{DID}/zone.stratos.feed.post/old"),
                    DID,
                    "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    NOW,
                    "2026-09-22T12:00:00.000Z",
                    6_500,
                    vec![b'x'; 100],
                    b"[]".as_slice(),
                ],
            )
            .unwrap();
        let budget = crate::config::SpaceStageBudget {
            target_rows: 100,
            global_rows: 200,
            target_bytes: 2_000,
            global_bytes: 4_000,
        };

        let result = store
            .compact_projection_with_budget(NOW, "2026-09-23T00:00:00.000Z", 10_000, 1, &budget)
            .unwrap();

        assert_eq!(result.deleted, 1);
        assert!(!result.has_more);
        let remaining: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn stage_replacement_and_delete_charge_current_payload_only() {
        let mut store = store(6_000);
        store
            .stage_space_page(page("first"), vec![upsert(0, 600)])
            .unwrap();
        let original: i64 = store
            .connection
            .query_row(
                "SELECT length(record_json) FROM space_sync_stage",
                [],
                |row| row.get(0),
            )
            .unwrap();
        store
            .stage_space_page(page("second"), vec![upsert(0, 20)])
            .unwrap();
        let reduced: i64 = store
            .connection
            .query_row(
                "SELECT length(record_json) FROM space_sync_stage",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(reduced, 20);
        assert!(original > reduced);
        store
            .stage_space_page(
                page("third"),
                vec![SpaceStageMutation::Delete {
                    uri: format!("{SPACE}/{DID}/zone.stratos.feed.post/0"),
                }],
            )
            .unwrap();
        let (deleted, bytes): (i64, Option<i64>) = store
            .connection
            .query_row(
                "SELECT deleted, length(record_json) FROM space_sync_stage",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(bytes, None);
    }

    #[test]
    fn expired_stage_removes_rows_checkpoint_and_pending_together() {
        let mut store = store(16_000);
        store
            .stage_space_page(page("partial"), vec![upsert(0, 100)])
            .unwrap();
        let mut terminal = page("partial");
        terminal.next_cursor = None;
        store.stage_space_page(terminal, Vec::new()).unwrap();
        store
            .compact_projection(
                "2026-09-24T00:00:00.000Z",
                "2026-09-25T00:00:00.000Z",
                16_000,
                128,
            )
            .unwrap();
        for table in [
            "space_sync_stage",
            "space_sync_stage_cursor",
            "space_sync_pending_verification",
            "space_sync_stage_lifetime",
        ] {
            let count: i64 = store
                .connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
        assert_eq!(store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(), None);
    }

    #[test]
    fn expired_stage_cannot_resume_after_store_reopen() {
        let path = std::env::temp_dir().join(format!(
            "stratos-stage-expiry-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos(),
        ));
        let key = || StorageKey::from_bytes([9; 32]);
        {
            let mut store = EncryptedStore::open(&path, key()).unwrap();
            store
                .stage_space_page(page("partial"), vec![upsert(0, 100)])
                .unwrap();
            store
                .compact_projection(
                    "2026-09-24T00:00:00.000Z",
                    "2026-09-25T00:00:00.000Z",
                    16_000,
                    128,
                )
                .unwrap();
        }
        let store = EncryptedStore::open(&path, key()).unwrap();
        assert_eq!(store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(), None);
        let count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM space_sync_stage_lifetime",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stage_expires_before_compactor_tick_on_a_later_page() {
        let mut store = store(16_000);
        store
            .stage_space_page(page("partial"), vec![upsert(0, 100)])
            .unwrap();
        store
            .compact_projection(NOW, "2026-09-22T00:00:01.000Z", 16_000, 128)
            .unwrap();
        let mut late = page("later");
        late.updated_at = "2026-09-22T00:00:02.000Z".to_owned();
        assert!(matches!(
            store.stage_space_page(late, vec![upsert(1, 100)]),
            Err(StoreError::ExpiredSpaceStage)
        ));
        assert_eq!(
            store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(),
            Some("partial".to_owned())
        );
    }

    #[test]
    fn retrying_identical_page_does_not_extend_stage_lifetime() {
        let mut store = store(16_000);
        store
            .stage_space_page(page("partial"), vec![upsert(0, 100)])
            .unwrap();
        let mut retry = page("partial");
        retry.updated_at = "2026-09-23T00:00:00.000Z".to_owned();
        let mut retried_record = upsert(0, 100);
        if let SpaceStageMutation::Upsert {
            sort_at,
            indexed_at,
            ..
        } = &mut retried_record
        {
            *sort_at = retry.updated_at.clone();
            *indexed_at = retry.updated_at.clone();
        }
        store.stage_space_page(retry, vec![retried_record]).unwrap();
        let (created, progress): (String, String) = store
            .connection
            .query_row(
                "SELECT created_at, last_progress_at FROM space_sync_stage_lifetime",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(created, NOW);
        assert_eq!(progress, NOW);
    }

    #[test]
    fn global_stage_budget_counts_many_individually_small_targets() {
        let mut store = store(4_000);
        let mut accepted = 0;
        for index in 0..20 {
            let did = format!("did:web:actor{index}.example.test");
            let page = SpaceStagePage {
                space_uri: SPACE.to_owned(),
                actor_did: did.clone(),
                boundary: BOUNDARY.to_owned(),
                next_cursor: Some(format!("cursor-{index}")),
                updated_at: NOW.to_owned(),
            };
            let mutation = SpaceStageMutation::Upsert {
                uri: format!("{SPACE}/{did}/zone.stratos.feed.post/0"),
                cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                sort_at: NOW.to_owned(),
                indexed_at: NOW.to_owned(),
                record_json: vec![b'x'; 250],
                blob_refs_json: b"[]".to_vec(),
            };
            match store.stage_space_page(page, vec![mutation]) {
                Ok(()) => accepted += 1,
                Err(StoreError::SpaceStageLimit) => break,
                Err(error) => panic!("unexpected stage error: {error:?}"),
            }
        }
        assert!(accepted > 1 && accepted < 20);
        let rows: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, accepted);
    }

    #[test]
    fn configured_target_and_global_row_caps_reject_separately() {
        let set_limit = |store: &EncryptedStore, key: &str, value: i64| {
            store
                .connection
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)",
                    params![key, value],
                )
                .unwrap();
        };
        let mut target = store(16_000);
        set_limit(&target, "stage_target_max_rows", 3);
        set_limit(&target, "stage_global_max_rows", 10);
        target
            .stage_space_page(page("first"), vec![upsert(0, 100)])
            .unwrap();
        assert!(matches!(
            target.stage_space_page(page("second"), vec![upsert(1, 100)]),
            Err(StoreError::SpaceStageLimit),
        ));

        let mut global = store(16_000);
        set_limit(&global, "stage_target_max_rows", 3);
        set_limit(&global, "stage_global_max_rows", 5);
        global
            .stage_space_page(page("first"), vec![upsert(0, 100)])
            .unwrap();
        let did = "did:plc:jetblack";
        let second = SpaceStagePage {
            actor_did: did.to_owned(),
            next_cursor: Some("second".to_owned()),
            ..page("unused")
        };
        assert!(matches!(
            global.stage_space_page(
                second,
                vec![SpaceStageMutation::Delete {
                    uri: format!("{SPACE}/{did}/zone.stratos.feed.post/0"),
                }]
            ),
            Err(StoreError::SpaceStageLimit),
        ));
    }

    #[test]
    fn cursored_checkpoint_bytes_and_terminal_pending_row_roll_back_at_target_cap() {
        let mut store = store(16_000);
        store.stage_space_page(page("short"), Vec::new()).unwrap();
        let before = {
            let transaction = store.connection.transaction().unwrap();
            let usage = stage_usage(&transaction, Some(SPACE), Some(DID)).unwrap();
            transaction.rollback().unwrap();
            usage
        };
        assert_eq!(before.rows, 2); // cursor and lifetime are distinct rows
        for (key, value) in [
            ("stage_target_max_rows", 2),
            ("stage_global_max_rows", 20),
            ("stage_target_max_bytes", before.bytes + 10),
            ("stage_global_max_bytes", 16_000),
        ] {
            store
                .connection
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)",
                    params![key, value],
                )
                .unwrap();
        }
        let long_cursor = "x".repeat(100);
        assert!(matches!(
            store.stage_space_page(page(&long_cursor), Vec::new()),
            Err(StoreError::SpaceStageLimit)
        ));
        let terminal = || SpaceStagePage {
            next_cursor: None,
            ..page("unused")
        };
        assert!(matches!(
            store.stage_space_page(terminal(), Vec::new()),
            Err(StoreError::SpaceStageLimit)
        ));
        store
            .connection
            .execute(
                "UPDATE retention_metadata SET value = 3 WHERE key = 'stage_target_max_rows'",
                [],
            )
            .unwrap();
        assert!(matches!(
            store.stage_space_page(terminal(), Vec::new()),
            Err(StoreError::SpaceStageLimit)
        ));
        let after = {
            let transaction = store.connection.transaction().unwrap();
            let usage = stage_usage(&transaction, Some(SPACE), Some(DID)).unwrap();
            transaction.rollback().unwrap();
            usage
        };
        assert_eq!((after.rows, after.bytes), (before.rows, before.bytes));
        assert_eq!(
            store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(),
            Some("short".to_owned())
        );
        let pending: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM space_sync_pending_verification",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 0);
    }

    #[test]
    fn terminal_pending_metadata_counts_against_global_cap_across_targets() {
        let mut store = store(16_000);
        for (key, value) in [("stage_target_max_rows", 3), ("stage_global_max_rows", 3)] {
            store
                .connection
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)",
                    params![key, value],
                )
                .unwrap();
        }
        store.stage_space_page(page("first"), Vec::new()).unwrap();
        let mut terminal = page("unused");
        terminal.next_cursor = None;
        store.stage_space_page(terminal, Vec::new()).unwrap();
        let other_did = "did:plc:jetblack";
        let second = SpaceStagePage {
            actor_did: other_did.to_owned(),
            next_cursor: Some("second".to_owned()),
            ..page("unused")
        };
        assert!(matches!(
            store.stage_space_page(second, Vec::new()),
            Err(StoreError::SpaceStageLimit)
        ));
        let usage = {
            let transaction = store.connection.transaction().unwrap();
            let usage = stage_usage(&transaction, None, None).unwrap();
            transaction.rollback().unwrap();
            usage
        };
        assert_eq!(usage.rows, 3); // cursor, pending verification, lifetime
        let other_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM space_sync_stage_lifetime WHERE did = ?1",
                [other_did],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other_rows, 0);
    }

    #[test]
    fn configured_global_byte_cap_rejects_before_projection_limit() {
        let mut store = store(16_000);
        for (key, value) in [
            ("stage_target_max_bytes", 2_000),
            ("stage_global_max_bytes", 1_500),
        ] {
            store
                .connection
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)",
                    params![key, value],
                )
                .unwrap();
        }
        store
            .stage_space_page(page("first"), vec![upsert(0, 500)])
            .unwrap();
        let did = "did:plc:jetblack";
        let second = SpaceStagePage {
            actor_did: did.to_owned(),
            next_cursor: Some("second".to_owned()),
            ..page("unused")
        };
        assert!(matches!(
            store.stage_space_page(
                second,
                vec![SpaceStageMutation::Upsert {
                    uri: format!("{SPACE}/{did}/zone.stratos.feed.post/0"),
                    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                    sort_at: NOW.to_owned(),
                    indexed_at: NOW.to_owned(),
                    record_json: vec![b'x'; 500],
                    blob_refs_json: b"[]".to_vec(),
                }]
            ),
            Err(StoreError::SpaceStageLimit)
        ));
    }

    #[test]
    fn over_budget_target_does_not_block_an_unrelated_target() {
        let mut store = store(8_000);
        store
            .stage_space_page(page("first"), vec![upsert(0, 400)])
            .unwrap();
        store
            .stage_space_page(page("second"), vec![upsert(1, 400)])
            .unwrap();
        assert!(matches!(
            store.stage_space_page(page("third"), vec![upsert(2, 400)]),
            Err(StoreError::SpaceStageLimit),
        ));
        let did = "did:web:jetblack.example.test";
        let other = SpaceStagePage {
            space_uri: SPACE.to_owned(),
            actor_did: did.to_owned(),
            boundary: BOUNDARY.to_owned(),
            next_cursor: Some("other".to_owned()),
            updated_at: NOW.to_owned(),
        };
        store
            .stage_space_page(
                other,
                vec![SpaceStageMutation::Delete {
                    uri: format!("{SPACE}/{did}/zone.stratos.feed.post/0"),
                }],
            )
            .unwrap();
        assert_eq!(
            store.space_sync_cursor(BOUNDARY, SPACE, did).unwrap(),
            Some("other".to_owned())
        );
    }

    #[test]
    fn oversized_legacy_stage_fails_atomic_promotion_closed() {
        let mut store = store(16_000);
        let mut terminal = page("unused");
        terminal.next_cursor = None;
        store.stage_space_page(terminal, Vec::new()).unwrap();
        let transaction = store.connection.transaction().unwrap();
        let target_rows = crate::config::SpaceStageBudget::for_projection(16_000)
            .unwrap()
            .target_rows;
        for index in 0..=target_rows {
            transaction.execute(
                "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                params![SPACE, DID, format!("{SPACE}/{DID}/zone.stratos.feed.post/{index}"), BOUNDARY, NOW],
            ).unwrap();
        }
        transaction.commit().unwrap();
        assert!(matches!(
            store.promote_verified_space_stage(SPACE, DID, NOW),
            Err(StoreError::SpaceStageLimit)
        ));
        let published: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        assert_eq!(published, 0);
    }

    #[test]
    fn byte_oversized_legacy_stage_fails_promotion_before_publishing() {
        let mut store = store(16_000);
        let mut terminal = page("terminal");
        terminal.next_cursor = None;
        store
            .stage_space_page(terminal, vec![upsert(0, 100)])
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE space_sync_stage SET record_json = zeroblob(5000)",
                [],
            )
            .unwrap();
        assert!(matches!(
            store.promote_verified_space_stage(SPACE, DID, NOW),
            Err(StoreError::SpaceStageLimit),
        ));
        let published: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        let staged: i64 = store
            .connection
            .query_row(
                "SELECT length(record_json) FROM space_sync_stage",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(published, 0);
        assert_eq!(staged, 5000);
    }

    #[test]
    fn authorized_terminal_stage_expires_before_promotion_at_one_and_half_retention_ages() {
        let mut store = store(16_000);
        store
            .connection
            .execute(
                "INSERT INTO retention_metadata (key, value) VALUES ('projection_max_age_ms', 1000)",
                [],
            )
            .unwrap();
        store
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: DID.to_owned(),
                }],
                NOW,
            )
            .unwrap();
        let mut terminal = page("terminal");
        terminal.next_cursor = None;
        store
            .stage_authorized_space_page(terminal, vec![upsert(0, 100)])
            .unwrap();

        let generation = store.pds_member_generation(BOUNDARY, DID).unwrap().unwrap();
        // The scheduler captured a deadline at T0, but verification completed
        // at T0 + 1.5 ages. Promotion must use that later observation time.
        assert!(matches!(
            store.promote_authorized_space_stage_at_generation(
                BOUNDARY,
                SPACE,
                DID,
                "2026-09-22T00:00:01.000Z",
                "2026-09-22T00:00:01.500Z",
                generation,
            ),
            Err(StoreError::ExpiredSpaceStage)
        ));
        let published: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        let staged: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM space_sync_stage", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(published, 0);
        assert_eq!(staged, 1);
    }

    #[test]
    fn successful_promotion_replaces_staged_usage_with_published_usage() {
        let mut store = store(16_000);
        store
            .replace_pds_space_members(
                BOUNDARY,
                vec![PdsSpaceMember {
                    did: DID.to_owned(),
                }],
                NOW,
            )
            .unwrap();
        let mut terminal = page("terminal");
        terminal.next_cursor = None;
        store
            .stage_authorized_space_page(terminal, vec![upsert(0, 100)])
            .unwrap();
        let staged_before = {
            let transaction = store.connection.transaction().unwrap();
            let usage = stage_usage(&transaction, None, None).unwrap();
            transaction.rollback().unwrap();
            usage
        };
        assert_eq!(staged_before.rows, 3); // post, pending verification, lifetime
        assert!(staged_before.bytes > 0);
        let maximum = staged_before.bytes;
        for (key, value) in [
            ("projection_max_bytes", maximum),
            ("stage_target_max_rows", 8),
            ("stage_global_max_rows", 16),
            ("stage_target_max_bytes", staged_before.bytes),
            ("stage_global_max_bytes", staged_before.bytes),
        ] {
            store
                .connection
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )
                .unwrap();
        }
        store
            .promote_authorized_space_stage(BOUNDARY, SPACE, DID, NOW)
            .unwrap();
        let staged_after = {
            let transaction = store.connection.transaction().unwrap();
            let usage = stage_usage(&transaction, None, None).unwrap();
            transaction.rollback().unwrap();
            usage
        };
        let (published_rows, published_bytes): (i64, i64) = store
            .connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(projection_bytes), 0) FROM post",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(staged_after.rows, 0);
        assert_eq!(staged_after.bytes, 0);
        assert_eq!(published_rows, 1);
        assert!(published_bytes > 0 && published_bytes <= maximum);
        assert!(published_bytes + staged_before.bytes > maximum);
    }

    #[test]
    fn globally_oversized_legacy_stage_fails_promotion_before_publishing() {
        let mut store = store(16_000);
        for (key, value) in [
            ("stage_target_max_bytes", 2_000),
            ("stage_global_max_bytes", 3_000),
        ] {
            store
                .connection
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)",
                    params![key, value],
                )
                .unwrap();
        }
        let mut terminal = page("terminal");
        terminal.next_cursor = None;
        store
            .stage_space_page(terminal, vec![upsert(0, 100)])
            .unwrap();
        let other_did = "did:plc:jetblack";
        store.connection.execute(
            "INSERT INTO space_sync_stage (space_uri, did, uri, boundary, deleted, record_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, zeroblob(3000), ?5)",
            params![SPACE, other_did,
                format!("{SPACE}/{other_did}/zone.stratos.feed.post/0"), BOUNDARY, NOW],
        ).unwrap();
        assert!(matches!(
            store.promote_verified_space_stage(SPACE, DID, NOW),
            Err(StoreError::SpaceStageLimit),
        ));
        let published: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM post", [], |row| row.get(0))
            .unwrap();
        assert_eq!(published, 0);
    }

    #[test]
    fn stage_row_cap_rejects_unpromotable_target_and_allows_other_target() {
        let mut store = store(16 * 1024 * 1024);
        let other_did = "did:plc:jetblack";
        store
            .replace_pds_space_members(
                BOUNDARY,
                vec![
                    PdsSpaceMember {
                        did: DID.to_owned(),
                    },
                    PdsSpaceMember {
                        did: other_did.to_owned(),
                    },
                ],
                NOW,
            )
            .unwrap();
        let deletes = |range: std::ops::Range<usize>| {
            range
                .map(|index| SpaceStageMutation::Delete {
                    uri: format!("{SPACE}/{DID}/zone.stratos.feed.post/{index}"),
                })
                .collect()
        };
        store
            .stage_authorized_space_page(page("first"), deletes(0..1_000))
            .unwrap();
        let terminal = SpaceStagePage {
            next_cursor: None,
            ..page("unused")
        };
        assert!(matches!(
            store.stage_authorized_space_page(terminal, deletes(1_000..1_023)),
            Err(StoreError::SpaceStageLimit)
        ));
        let staged_before: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM space_sync_stage WHERE did = ?1",
                [DID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(staged_before, 1_000);
        assert_eq!(
            store.space_sync_cursor(BOUNDARY, SPACE, DID).unwrap(),
            Some("first".to_owned())
        );
        let (staged_after, pending, published): (i64, i64, i64) = store
            .connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM space_sync_stage WHERE did = ?1),
                        (SELECT COUNT(*) FROM space_sync_pending_verification WHERE did = ?1),
                        (SELECT COUNT(*) FROM post)",
                [DID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((staged_after, pending, published), (staged_before, 0, 0));

        let other = SpaceStagePage {
            actor_did: other_did.to_owned(),
            next_cursor: None,
            ..page("unused")
        };
        store
            .stage_authorized_space_page(
                other,
                vec![SpaceStageMutation::Upsert {
                    uri: format!("{SPACE}/{other_did}/zone.stratos.feed.post/0"),
                    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                    sort_at: NOW.to_owned(),
                    indexed_at: NOW.to_owned(),
                    record_json: b"{}".to_vec(),
                    blob_refs_json: b"[]".to_vec(),
                }],
            )
            .unwrap();
        store
            .promote_authorized_space_stage(BOUNDARY, SPACE, other_did, NOW)
            .unwrap();
        let other_published: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM post WHERE author_did = ?1",
                [other_did],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other_published, 1);
        let rejected_target_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM space_sync_stage WHERE did = ?1",
                [DID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rejected_target_rows, staged_before);
    }

    #[test]
    fn stage_byte_cap_rejects_unpromotable_target_before_publishing() {
        let mut store = store(64 * 1024 * 1024);
        let terminal = SpaceStagePage {
            next_cursor: None,
            ..page("unused")
        };
        assert!(matches!(
            store.stage_space_page(
                terminal,
                (0..170).map(|index| upsert(index, 50_000)).collect(),
            ),
            Err(StoreError::SpaceStageLimit)
        ));
        let usage = {
            let transaction = store.connection.transaction().unwrap();
            let usage = stage_usage(&transaction, Some(SPACE), Some(DID)).unwrap();
            transaction.rollback().unwrap();
            usage
        };
        assert!(usage.rows < MAX_SPACE_PROMOTION_STAGE_ROWS);
        assert!(usage.bytes <= MAX_SPACE_PROMOTION_STAGE_BYTES);
        let (staged, published): (i64, i64) = store
            .connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM space_sync_stage), (SELECT COUNT(*) FROM post)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((staged, published), (0, 0));
    }
}
