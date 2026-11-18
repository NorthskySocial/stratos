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
        let limit = i64::from(limit.clamp(1, MAX_PURGE_BATCH));
        let deleted_posts = transaction.execute("DELETE FROM post WHERE uri IN (SELECT uri FROM post WHERE retained_at <= ?1 ORDER BY retained_at ASC, uri ASC LIMIT ?2)", params![as_of, limit]).map_err(StoreError::Open)?;
        let deleted_interactions = interactions::delete_expired_interactions(
            &transaction,
            as_of,
            limit.saturating_sub(deleted_posts as i64),
        )?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok((deleted_posts + deleted_interactions) as u64)
    }

    /// Deletes expired posts and interactions, then orphan interactions, then the
    /// oldest posts, in short transactions until the configured cap is met.
    pub fn compact_projection(
        &mut self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
    ) -> Result<ProjectionCompaction, StoreError> {
        let budget = crate::config::SpaceStageBudget::for_projection(max_bytes)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        self.compact_projection_with_budget(as_of, maximum_retained_at, max_bytes, limit, &budget)
    }

    pub fn compact_projection_with_budget(
        &mut self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
        budget: &crate::config::SpaceStageBudget,
    ) -> Result<ProjectionCompaction, StoreError> {
        if !is_utc_timestamp(as_of) || !is_utc_timestamp(maximum_retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        budget
            .validate(max_bytes)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        let max_bytes =
            i64::try_from(max_bytes).map_err(|_| StoreError::InvalidProjectionMutation)?;
        let published_capacity = max_bytes
            .checked_sub(
                i64::try_from(budget.global_bytes)
                    .map_err(|_| StoreError::InvalidProjectionMutation)?,
            )
            .ok_or(StoreError::InvalidProjectionMutation)?;
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
        for (key, value) in [
            ("stage_target_max_rows", budget.target_rows),
            ("stage_global_max_rows", budget.global_rows),
            ("stage_target_max_bytes", budget.target_bytes),
            ("stage_global_max_bytes", budget.global_bytes),
        ] {
            transaction
                .execute(
                    "INSERT INTO retention_metadata (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![
                        key,
                        i64::try_from(value).map_err(|_| StoreError::InvalidProjectionMutation)?
                    ],
                )
                .map_err(StoreError::Open)?;
        }
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
        let expired_posts = transaction
            .execute(
                "DELETE FROM post WHERE uri IN (SELECT uri FROM post WHERE retained_at <= ?1 OR retained_at > ?2 ORDER BY retained_at ASC, uri ASC LIMIT ?3)",
                params![as_of, maximum_retained_at, limit],
            )
            .map_err(StoreError::Open)?;
        let expired_interactions = interactions::delete_interactions_outside_retention(
            &transaction,
            as_of,
            maximum_retained_at,
            limit.saturating_sub(expired_posts as i64),
        )?;
        let expired = expired_posts + expired_interactions;
        let deleted = if expired != 0 {
            expired
        } else if interactions::published_bytes(&transaction)? <= published_capacity {
            0
        } else {
            // Orphans can never be counted, so they go before any readable post.
            match interactions::evict_orphan_interactions(&transaction, limit)? {
                0 => transaction
                    .execute(
                        "DELETE FROM post WHERE uri IN (SELECT uri FROM post ORDER BY sort_at ASC, uri ASC LIMIT ?1)",
                        [limit],
                    )
                    .map_err(StoreError::Open)?,
                evicted => evicted,
            }
        };
        let expired_remaining: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM post WHERE retained_at <= ?1 OR retained_at > ?2)
                     OR EXISTS(SELECT 1 FROM interaction WHERE retained_at <= ?1 OR retained_at > ?2)",
                params![as_of, maximum_retained_at],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)?;
        let published_bytes = interactions::published_bytes(&transaction)?;
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
                || published_bytes > published_capacity
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
        interactions::delete_boundary_interactions(&transaction, boundary)?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok(deleted as u64)
    }
}
