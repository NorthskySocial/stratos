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
        let expired = transaction
            .execute(
                "DELETE FROM post WHERE uri IN (SELECT uri FROM post WHERE retained_at <= ?1 OR retained_at > ?2 ORDER BY retained_at ASC, uri ASC LIMIT ?3)",
                params![as_of, maximum_retained_at, limit],
            )
            .map_err(StoreError::Open)?;
        let deleted = if expired != 0 {
            expired
        } else {
            let bytes: i64 = transaction
                .query_row(
                    "SELECT COALESCE(SUM(projection_bytes), 0) FROM post",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::Open)?;
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
        let bytes_remaining: i64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(projection_bytes), 0) FROM post",
                [],
                |row| row.get(0),
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok(ProjectionCompaction {
            deleted: deleted as u64,
            has_more: expired_remaining || bytes_remaining > max_bytes,
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
            .execute("DELETE FROM post_boundary WHERE boundary = ?1", [boundary])
            .map_err(StoreError::Open)?;
        let deleted = transaction
            .execute("DELETE FROM post WHERE NOT EXISTS (SELECT 1 FROM post_boundary WHERE post_boundary.uri = post.uri)", [])
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)?;
        Ok(deleted as u64)
    }
}
