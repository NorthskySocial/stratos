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

    /// Compacts with the default reserve for space writes, half the maximum.
    pub fn compact_projection(
        &mut self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
    ) -> Result<ProjectionCompaction, StoreError> {
        self.compact_projection_with_reserve(
            as_of,
            maximum_retained_at,
            max_bytes,
            limit,
            crate::config::default_space_write_reserve(max_bytes),
        )
    }

    /// Deletes expired posts and interactions, then orphan interactions, then the
    /// oldest posts, in short transactions until published bytes are at or
    /// under `max_bytes` less `space_write_reserve_bytes`. A verified space
    /// write counts against the whole maximum, so it always has the reserve.
    pub fn compact_projection_with_reserve(
        &mut self,
        as_of: &str,
        maximum_retained_at: &str,
        max_bytes: u64,
        limit: u16,
        space_write_reserve_bytes: u64,
    ) -> Result<ProjectionCompaction, StoreError> {
        if !is_utc_timestamp(as_of) || !is_utc_timestamp(maximum_retained_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        crate::config::validate_space_write_reserve(max_bytes, space_write_reserve_bytes)
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        let max_bytes =
            i64::try_from(max_bytes).map_err(|_| StoreError::InvalidProjectionMutation)?;
        let published_capacity = max_bytes
            - i64::try_from(space_write_reserve_bytes)
                .map_err(|_| StoreError::InvalidProjectionMutation)?;
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
        Ok(ProjectionCompaction {
            deleted: deleted as u64,
            has_more: expired_remaining || published_bytes > published_capacity,
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
        // Verified state must not outlive the projection it vouches for, or a
        // later incremental promotion would skip records that are gone.
        for table in ["space_repo_record", "space_repo_state"] {
            transaction
                .execute(
                    &format!("DELETE FROM {table} WHERE boundary = ?1"),
                    [boundary],
                )
                .map_err(StoreError::Open)?;
        }
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
