use super::*;

impl EncryptedStore {
    pub fn purge_expired(&mut self, as_of: &str, limit: u16) -> Result<u64, StoreError> {
        if !is_utc_timestamp(as_of) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let deleted = transaction.execute("DELETE FROM post WHERE uri IN (SELECT uri FROM post WHERE retained_at <= ?1 ORDER BY retained_at ASC, uri ASC LIMIT ?2)", params![as_of, i64::from(limit.clamp(1, MAX_PURGE_BATCH))]).map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok(deleted as u64)
    }

    /// Deletes expired or oldest posts in short transactions until the configured cap is met.
    pub fn compact_projection(
        &mut self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
    ) -> Result<ProjectionCompaction, StoreError> {
        if !is_utc_timestamp(as_of) || !is_utc_timestamp(maximum_retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let max_bytes =
            i64::try_from(max_bytes).map_err(|_| StoreError::InvalidProjectionMutation)?;
        let limit = i64::from(limit.clamp(1, MAX_PURGE_BATCH));
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "INSERT INTO retention_metadata (key, value) VALUES ('projection_max_bytes', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [max_bytes],
            )
            .map_err(StoreError::Open)?;
        let now =
            time::OffsetDateTime::parse(as_of, &time::format_description::well_known::Rfc3339)
                .map_err(|_| StoreError::InvalidProjectionMutation)?;
        let maximum = time::OffsetDateTime::parse(
            maximum_retained_at,
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| StoreError::InvalidProjectionMutation)?;
        let maximum_age_ms = i64::try_from((maximum - now).whole_milliseconds())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        if maximum_age_ms <= 0 {
            return Err(StoreError::InvalidProjectionMutation);
        }
        transaction
            .execute(
                "INSERT INTO retention_metadata (key, value) VALUES ('projection_max_age_ms', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [maximum_age_ms],
            )
            .map_err(StoreError::Open)?;
        let cutoff = now
            .checked_sub(maximum - now)
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
        let expired_targets: Vec<(String, String)> = {
            let mut statement = transaction
                .prepare(
                    "SELECT space_uri, did FROM space_sync_stage_lifetime
                 WHERE created_at <= ?1 OR last_progress_at <= ?1
                 ORDER BY last_progress_at, space_uri, did LIMIT ?2",
                )
                .map_err(StoreError::Open)?;
            statement
                .query_map(params![cutoff, limit], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(StoreError::Open)?
                .collect::<Result<_, _>>()
                .map_err(StoreError::Open)?
        };
        for (space_uri, did) in &expired_targets {
            for table in [
                "space_sync_stage",
                "space_sync_stage_cursor",
                "space_sync_pending_verification",
                "space_sync_stage_lifetime",
            ] {
                transaction
                    .execute(
                        &format!("DELETE FROM {table} WHERE space_uri = ?1 AND did = ?2"),
                        params![space_uri, did],
                    )
                    .map_err(StoreError::Open)?;
            }
        }
        let expired = transaction
            .execute(
                "DELETE FROM post WHERE uri IN (SELECT uri FROM post WHERE retained_at <= ?1 OR retained_at > ?2 ORDER BY retained_at ASC, uri ASC LIMIT ?3)",
                params![as_of, maximum_retained_at, limit],
            )
            .map_err(StoreError::Open)?;
        let deleted = if expired != 0 {
            expired
        } else {
            let published_bytes: i64 = transaction
                .query_row(
                    "SELECT COALESCE(SUM(projection_bytes), 0) FROM post",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::Open)?;
            let staged_bytes = super::space::stage_usage(&transaction, None, None)?.1;
            let bytes = published_bytes
                .checked_add(staged_bytes)
                .ok_or(StoreError::SpaceStageLimit)?;
            if bytes <= max_bytes {
                0
            } else {
                transaction
                    .execute(
                        "DELETE FROM post WHERE uri IN (SELECT uri FROM post ORDER BY sort_at ASC, uri ASC LIMIT ?1)",
                        [limit],
                    )
                    .map_err(StoreError::Open)?
            }
        };
        let expired_remaining: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM post WHERE retained_at <= ?1 OR retained_at > ?2)",
                params![as_of, maximum_retained_at],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)?;
        let published_bytes: i64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(projection_bytes), 0) FROM post",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)?;
        let staged_bytes = super::space::stage_usage(&transaction, None, None)?.1;
        let bytes_remaining = published_bytes
            .checked_add(staged_bytes)
            .ok_or(StoreError::SpaceStageLimit)?;
        transaction.commit().map_err(StoreError::Open)?;
        if !expired_targets.is_empty() {
            eprintln!(
                "event=space_stage_cleanup expired_targets={}",
                expired_targets.len()
            );
        }
        Ok(ProjectionCompaction {
            deleted: deleted as u64,
            has_more: expired_remaining
                || bytes_remaining > max_bytes
                || expired_targets.len() == limit as usize,
        })
    }

    pub fn purge_boundary(&mut self, boundary: &str) -> Result<u64, StoreError> {
        if boundary.is_empty() {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_cursor WHERE boundary = ?1 OR boundary = ''",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage_cursor WHERE boundary = ?1",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_pending_verification WHERE boundary = ?1 OR boundary = ''",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage WHERE boundary = ?1",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute(
                "DELETE FROM space_sync_stage_lifetime WHERE boundary = ?1",
                [boundary],
            )
            .map_err(StoreError::Open)?;
        transaction
            .execute("DELETE FROM post_boundary WHERE boundary = ?1", [boundary])
            .map_err(StoreError::Open)?;
        let deleted = transaction
            .execute("DELETE FROM post WHERE NOT EXISTS (SELECT 1 FROM post_boundary WHERE post_boundary.uri = post.uri)", [])
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok(deleted as u64)
    }
}
