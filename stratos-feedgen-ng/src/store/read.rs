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
        Ok(FeedPage {
            posts,
            cursor,
            summaries: std::collections::BTreeMap::new(),
        })
    }

    /// Counts and the viewer's own record URIs for the posts of one served
    /// page. Only the feed's own boundary, exact subjects and unexpired rows
    /// count, and no other actor's DID or record URI leaves the query.
    pub fn interaction_summaries(
        &self,
        boundary: &str,
        viewer: &str,
        uris: &[String],
        as_of: &str,
    ) -> Result<std::collections::BTreeMap<String, InteractionSummary>, StoreError> {
        if !is_utc_timestamp(as_of) || uris.len() > usize::from(crate::cursor::MAX_FEED_LIMIT) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        if uris.is_empty() {
            return Ok(std::collections::BTreeMap::new());
        }
        let subjects =
            serde_json::to_string(uris).map_err(|_| StoreError::InvalidProjectionMutation)?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT subject_uri,
                   COUNT(DISTINCT CASE WHEN kind = 'like' THEN actor_did END),
                   COUNT(DISTINCT CASE WHEN kind = 'repost' THEN actor_did END),
                   MIN(CASE WHEN kind = 'like' AND actor_did = ?2 THEN uri END),
                   MIN(CASE WHEN kind = 'repost' AND actor_did = ?2 THEN uri END)
                 FROM interaction
                 WHERE boundary = ?1 AND retained_at > ?3
                   AND subject_uri IN (SELECT value FROM json_each(?4))
                 GROUP BY subject_uri",
            )
            .map_err(StoreError::Open)?;
        statement
            .query_map(params![boundary, viewer, as_of, subjects], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    InteractionSummary {
                        like_count: row.get(1)?,
                        repost_count: row.get(2)?,
                        viewer_like: row.get(3)?,
                        viewer_repost: row.get(4)?,
                    },
                ))
            })
            .map_err(StoreError::Open)?
            .collect::<Result<_, _>>()
            .map_err(StoreError::Open)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn open_store() -> EncryptedStore {
        EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap()
    }

    #[test]
    fn a_summary_request_for_more_than_a_page_of_posts_is_refused() {
        let store = open_store();
        let uris = (0..=crate::cursor::MAX_FEED_LIMIT)
            .map(|index| format!("at://did:plc:spikespiegel/zone.stratos.feed.post/{index}"))
            .collect::<Vec<_>>();

        assert!(matches!(
            store.interaction_summaries("bebop", "did:plc:faye", &uris, "1998-04-03T00:00:00.000Z"),
            Err(StoreError::InvalidProjectionMutation)
        ));
        assert!(
            store
                .interaction_summaries(
                    "bebop",
                    "did:plc:faye",
                    &uris[..usize::from(crate::cursor::MAX_FEED_LIMIT)],
                    "1998-04-03T00:00:00.000Z",
                )
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_summary_request_needs_a_utc_time() {
        let store = open_store();

        assert!(matches!(
            store.interaction_summaries("bebop", "did:plc:faye", &[], "yesterday"),
            Err(StoreError::InvalidProjectionMutation)
        ));
    }

    #[test]
    fn a_summary_covers_only_the_requested_posts() {
        let mut store = open_store();
        let liked = "at://did:plc:spikespiegel/zone.stratos.feed.post/swordfish";
        let unrequested = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop";
        let interactions = [liked, unrequested]
            .into_iter()
            .enumerate()
            .map(|(index, subject)| ProjectionInteraction {
                uri: format!("at://did:plc:fayevalentine/app.bsky.feed.like/{index}"),
                actor_did: "did:plc:fayevalentine".to_owned(),
                kind: InteractionKind::Like,
                subject_uri: subject.to_owned(),
                boundary: "bebop".to_owned(),
                indexed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                retained_at: "1998-04-05T00:00:00.000Z".to_owned(),
            })
            .collect();
        store
            .apply_actor_page(ActorPage {
                authority_did: "did:web:stratos.example.test".to_owned(),
                actor_did: "did:plc:fayevalentine".to_owned(),
                sequence: 1,
                upserts: Vec::new(),
                deletes: Vec::new(),
                updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
                interactions: InteractionChanges {
                    upserts: interactions,
                    deletes: Vec::new(),
                },
            })
            .unwrap();

        let summaries = store
            .interaction_summaries(
                "bebop",
                "did:plc:jetblack",
                &[liked.to_owned()],
                "1998-04-04T00:00:00.000Z",
            )
            .unwrap();

        assert_eq!(summaries.keys().collect::<Vec<_>>(), [liked]);
        assert_eq!(summaries[liked].like_count, 1);
    }

    const NEWEST: &str = "1998-04-03T00:00:03.000Z";
    const MIDDLE: &str = "1998-04-03T00:00:02.000Z";
    const OLDEST: &str = "1998-04-03T00:00:01.000Z";
    const READ_AT: &str = "1998-04-03T12:00:00.000Z";

    fn space_post_uri(rkey: &str) -> String {
        format!(
            "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/{rkey}"
        )
    }

    fn insert_post(store: &EncryptedStore, uri: &str, sort_at: &str) {
        store
            .connection
            .execute(
                "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
                 VALUES (?1, 'did:plc:spikespiegel', 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                         ?2, ?2, '1998-05-03T00:00:00.000Z', 100, x'7b7d', x'5b5d', 1)",
                rusqlite::params![uri, sort_at],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO post_boundary (uri, boundary, sort_at) VALUES (?1, 'bebop', ?2)",
                rusqlite::params![uri, sort_at],
            )
            .unwrap();
    }

    fn listed_after(store: &EncryptedStore, cursor: &crate::cursor::FeedCursor) -> Vec<String> {
        store
            .list_posts_by_boundary("bebop", Some(cursor), 50, READ_AT)
            .unwrap()
            .posts
            .into_iter()
            .map(|post| post.uri)
            .collect()
    }

    #[test]
    fn a_cursor_carrying_a_legacy_uri_is_compared_as_an_opaque_string() {
        const LEGACY_CURSOR_URI: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/eva01";
        let store = open_store();
        for (rkey, sort_at) in [("a", NEWEST), ("b", MIDDLE), ("c", OLDEST)] {
            insert_post(&store, &space_post_uri(rkey), sort_at);
        }
        let stale = crate::cursor::FeedCursor {
            sort_at: MIDDLE.to_owned(),
            uri: LEGACY_CURSOR_URI.to_owned(),
        };

        // The tie at the cursor timestamp is broken by byte order, which puts
        // the current spelling after the previous one.
        assert_eq!(
            listed_after(&store, &stale),
            [space_post_uri("b"), space_post_uri("c")]
        );
    }

    #[test]
    fn a_cursor_in_the_current_spelling_resumes_strictly_after_its_post() {
        let store = open_store();
        for (rkey, sort_at) in [("a", NEWEST), ("b", MIDDLE), ("c", OLDEST)] {
            insert_post(&store, &space_post_uri(rkey), sort_at);
        }
        let cursor = crate::cursor::FeedCursor {
            sort_at: MIDDLE.to_owned(),
            uri: space_post_uri("b"),
        };

        assert_eq!(listed_after(&store, &cursor), [space_post_uri("c")]);
    }

    #[test]
    fn posts_with_one_timestamp_are_ordered_by_the_bytes_of_their_uris() {
        const CUSTODY_URI: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/see-you";
        let store = open_store();
        for uri in [
            space_post_uri("b"),
            CUSTODY_URI.to_owned(),
            space_post_uri("a"),
        ] {
            insert_post(&store, &uri, MIDDLE);
        }

        let uris: Vec<String> = store
            .list_posts_by_boundary("bebop", None, 50, READ_AT)
            .unwrap()
            .posts
            .into_iter()
            .map(|post| post.uri)
            .collect();

        assert_eq!(
            uris,
            [
                CUSTODY_URI.to_owned(),
                space_post_uri("a"),
                space_post_uri("b")
            ]
        );
    }
}
