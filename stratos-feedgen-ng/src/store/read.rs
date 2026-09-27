use super::*;

impl EncryptedStore {
    pub fn list_posts_by_boundary(
        &self,
        boundary: &str,
        cursor: Option<&crate::cursor::FeedCursor>,
        limit: u16,
        as_of: &str,
    ) -> Result<FeedPage, StoreError> {
        if !is_utc_timestamp(as_of) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let limit = i64::from(limit.clamp(1, crate::cursor::MAX_FEED_LIMIT));
        let posts = match cursor {
            Some(cursor) => self.list_posts_after_cursor(boundary, cursor, limit, as_of)?,
            None => self.list_initial_posts(boundary, limit, as_of)?,
        };
        let cursor = if posts.len() == limit as usize {
            posts.last().map(|post| crate::cursor::FeedCursor {
                sort_at: post.sort_at.clone(),
                uri: post.uri.clone(),
            })
        } else {
            None
        };
        Ok(FeedPage { posts, cursor })
    }

    pub fn blob_post(&self, uri: &str, as_of: &str) -> Result<Option<BlobPost>, StoreError> {
        if !is_utc_timestamp(as_of) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        self.connection
            .query_row(
                "SELECT p.uri, p.author_did, p.blob_refs_json,
                 COALESCE((SELECT json_group_array(boundary) FROM post_boundary WHERE uri = p.uri), '[]')
                 FROM post p WHERE p.uri = ?1 AND p.retained_at > ?2",
                params![uri, as_of],
                |row| Ok(BlobPost {
                    uri: row.get(0)?,
                    author_did: row.get(1)?,
                    blob_refs_json: row.get(2)?,
                    boundaries: serde_json::from_str(&row.get::<_, String>(3)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?,
                }),
            )
            .optional()
            .map_err(StoreError::Open)
    }

    fn list_initial_posts(
        &self,
        boundary: &str,
        limit: i64,
        as_of: &str,
    ) -> Result<Vec<FeedPost>, StoreError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT p.uri, p.author_did, p.cid, p.sort_at, p.indexed_at, p.record_json, p.blob_refs_json,
              COALESCE((SELECT json_group_array(boundary) FROM post_boundary WHERE uri = p.uri), '[]')
             FROM post_boundary b JOIN post p ON p.uri = b.uri
             WHERE b.boundary = ?1 AND p.retained_at > ?2 ORDER BY b.sort_at DESC, b.uri ASC LIMIT ?3",
            )
            .map_err(StoreError::Open)?;
        statement
            .query_map(params![boundary, as_of, limit], feed_post_from_row)
            .map_err(StoreError::Open)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::Open)
    }

    fn list_posts_after_cursor(
        &self,
        boundary: &str,
        cursor: &crate::cursor::FeedCursor,
        limit: i64,
        as_of: &str,
    ) -> Result<Vec<FeedPost>, StoreError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT p.uri, p.author_did, p.cid, p.sort_at, p.indexed_at, p.record_json, p.blob_refs_json,
              COALESCE((SELECT json_group_array(boundary) FROM post_boundary WHERE uri = p.uri), '[]')
             FROM post_boundary b JOIN post p ON p.uri = b.uri
             WHERE b.boundary = ?1 AND p.retained_at > ?2 AND (b.sort_at < ?3 OR (b.sort_at = ?3 AND b.uri > ?4))
             ORDER BY b.sort_at DESC, b.uri ASC LIMIT ?5",
            )
            .map_err(StoreError::Open)?;
        statement
            .query_map(
                params![boundary, as_of, cursor.sort_at, cursor.uri, limit],
                feed_post_from_row,
            )
            .map_err(StoreError::Open)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::Open)
    }
}
