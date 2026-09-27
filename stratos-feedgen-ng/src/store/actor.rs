use super::*;

fn load_actor_enrollment(
    transaction: &rusqlite::Transaction<'_>,
    did: &str,
) -> Result<Option<StoredActorEnrollment>, StoreError> {
    transaction
        .query_row(
            "SELECT did, boundaries_json, observed_at, enrolled FROM actor_enrollment WHERE did = ?1",
            [did],
            |row| {
                let boundaries: Vec<String> = serde_json::from_slice(&row.get::<_, Vec<u8>>(1)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let observed_at: String = row.get(2)?;
                let enrolled: bool = row.get(3)?;
                Ok(StoredActorEnrollment {
                    enrollment: enrolled.then_some(ActorEnrollment {
                        did: row.get(0)?,
                        boundaries,
                        observed_at: observed_at.clone(),
                    }),
                    observed_at,
                })
            },
        )
        .optional()
        .map_err(StoreError::Open)
}

fn validate_actor_enrollment(enrollment: &ActorEnrollment) -> Result<(), StoreError> {
    if enrollment.boundaries.len() > 128
        || enrollment
            .boundaries
            .iter()
            .any(|boundary| boundary.is_empty() || boundary.len() > 256 || !boundary.is_ascii())
        || !is_utc_timestamp(&enrollment.observed_at)
    {
        return Err(StoreError::InvalidProjectionMutation);
    }
    let unique = enrollment
        .boundaries
        .iter()
        .collect::<std::collections::BTreeSet<_>>();
    if unique.len() != enrollment.boundaries.len() {
        return Err(StoreError::InvalidProjectionMutation);
    }
    Ok(())
}

impl EncryptedStore {
    pub fn apply_actor_page(&mut self, page: ActorPage) -> Result<(), StoreError> {
        validate_actor_page(&page)?;
        let page = normalize_actor_page(page);
        let sequence =
            i64::try_from(page.sequence).map_err(|_| StoreError::InvalidProjectionMutation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let current_sequence: Option<i64> = transaction
            .query_row(
                "SELECT sequence FROM actor_cursor WHERE authority_did = ?1 AND did = ?2",
                params![page.authority_did, page.actor_did],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?;
        if current_sequence.is_some_and(|current| current > sequence) {
            return Err(StoreError::StaleCursor);
        }
        for post in &page.upserts {
            transaction
                .execute(
                    "INSERT INTO post (uri, author_did, cid, sort_at, indexed_at, retained_at, projection_bytes, record_json, blob_refs_json, row_version)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
                     ON CONFLICT(uri) DO UPDATE SET author_did = excluded.author_did, cid = excluded.cid,
                       sort_at = excluded.sort_at, indexed_at = excluded.indexed_at, retained_at = excluded.retained_at,
                       projection_bytes = excluded.projection_bytes, record_json = excluded.record_json,
                       blob_refs_json = excluded.blob_refs_json, row_version = post.row_version + 1",
                    params![
                        post.uri,
                        post.author_did,
                        post.cid,
                        post.sort_at,
                        post.indexed_at,
                        post.retained_at,
                        projection_bytes(post),
                        post.record_json,
                        post.blob_refs_json,
                    ],
                )
                .map_err(StoreError::Open)?;
            transaction
                .execute("DELETE FROM post_boundary WHERE uri = ?1", [&post.uri])
                .map_err(StoreError::Open)?;
            for boundary in &post.boundaries {
                transaction
                    .execute(
                        "INSERT INTO post_boundary (uri, boundary, sort_at) VALUES (?1, ?2, ?3)",
                        params![post.uri, boundary, post.sort_at],
                    )
                    .map_err(StoreError::Open)?;
            }
        }
        for uri in &page.deletes {
            transaction
                .execute("DELETE FROM post WHERE uri = ?1", [uri])
                .map_err(StoreError::Open)?;
        }
        transaction
            .execute(
                "INSERT INTO actor_cursor (authority_did, did, sequence, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(authority_did, did) DO UPDATE SET sequence = excluded.sequence, updated_at = excluded.updated_at",
                params![page.authority_did, page.actor_did, sequence, page.updated_at],
            )
            .map_err(StoreError::Open)?;
        transaction.commit().map_err(StoreError::Open)
    }

    pub fn list_actor_enrollments_page(
        &self,
        after_did: Option<&str>,
        limit: u16,
    ) -> Result<Vec<ActorEnrollment>, StoreError> {
        if limit == 0 || limit > MAX_ACTOR_ENROLLMENT_PAGE {
            return Err(StoreError::InvalidProjectionMutation);
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT did, boundaries_json, observed_at FROM actor_enrollment
                 WHERE enrolled = 1 AND (?1 IS NULL OR did > ?1)
                 ORDER BY did ASC LIMIT ?2",
            )
            .map_err(StoreError::Open)?;
        statement
            .query_map(params![after_did, i64::from(limit)], |row| {
                let boundaries: Vec<String> = serde_json::from_slice(&row.get::<_, Vec<u8>>(1)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(ActorEnrollment {
                    did: row.get(0)?,
                    boundaries,
                    observed_at: row.get(2)?,
                })
            })
            .map_err(StoreError::Open)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::Open)
    }

    pub fn actor_sync_state(
        &self,
        authority_did: &str,
        did: &str,
    ) -> Result<Option<ActorSyncState>, StoreError> {
        crate::identifier::Did::parse(authority_did.to_owned())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        crate::identifier::Did::parse(did.to_owned())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        let enrollment: Option<Vec<String>> = self
            .connection
            .query_row(
                "SELECT boundaries_json FROM actor_enrollment WHERE did = ?1 AND enrolled = 1",
                [did],
                |row| {
                    serde_json::from_slice(&row.get::<_, Vec<u8>>(0)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)
                },
            )
            .optional()
            .map_err(StoreError::Open)?;
        let Some(boundaries) = enrollment else {
            return Ok(None);
        };
        let cursor: Option<i64> = self
            .connection
            .query_row(
                "SELECT sequence FROM actor_cursor WHERE authority_did = ?1 AND did = ?2",
                params![authority_did, did],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::Open)?;
        let cursor = cursor
            .map(|cursor| u64::try_from(cursor).map_err(|_| StoreError::InvalidProjectionMutation))
            .transpose()?;
        Ok(Some(ActorSyncState { boundaries, cursor }))
    }

    pub fn reconcile_actor_enrollment(
        &mut self,
        did: &str,
        observed_at: &str,
        enrollment: Option<ActorEnrollment>,
    ) -> Result<EnrollmentReconciliation, StoreError> {
        crate::identifier::Did::parse(did.to_owned())
            .map_err(|_| StoreError::InvalidProjectionMutation)?;
        if !is_utc_timestamp(observed_at) {
            return Err(StoreError::InvalidProjectionMutation);
        }
        if let Some(entry) = &enrollment {
            validate_actor_enrollment(entry)?;
            if entry.did != did || entry.observed_at != observed_at {
                return Err(StoreError::InvalidProjectionMutation);
            }
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(StoreError::Open)?;
        let previous = load_actor_enrollment(&transaction, did)?;
        if let Some(previous) = &previous {
            if previous.observed_at.as_str() > observed_at {
                return Err(StoreError::StaleCursor);
            }
            if previous.observed_at == observed_at {
                if previous.enrollment.as_ref() == enrollment.as_ref() {
                    return Ok(EnrollmentReconciliation {
                        removed_boundaries: Vec::new(),
                        removed_posts: 0,
                        enrolled: enrollment.is_some(),
                    });
                }
                return Err(StoreError::EnrollmentConflict);
            }
        }
        let (removed_boundaries, removed_posts, enrolled) = match enrollment {
            Some(entry) => {
                let current = entry
                    .boundaries
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<_>>();
                let removed_boundaries = previous
                    .as_ref()
                    .and_then(|previous| previous.enrollment.as_ref())
                    .map(|previous| {
                        previous
                            .boundaries
                            .iter()
                            .filter(|boundary| !current.contains(*boundary))
                            .cloned()
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for boundary in &removed_boundaries {
                    transaction
                        .execute(
                            "DELETE FROM post_boundary WHERE boundary = ?1 AND uri IN (SELECT uri FROM post WHERE author_did = ?2)",
                            params![boundary, did],
                        )
                        .map_err(StoreError::Open)?;
                    transaction
                        .execute(
                            "DELETE FROM source_coverage WHERE source_id = ?1 AND boundary = ?2",
                            params![did, boundary],
                        )
                        .map_err(StoreError::Open)?;
                    transaction
                        .execute(
                            "DELETE FROM space_cursor WHERE did = ?1 AND (boundary = ?2 OR boundary = '')",
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
                            "DELETE FROM space_sync_pending_verification WHERE did = ?1 AND (boundary = ?2 OR boundary = '')",
                            params![did, boundary],
                        )
                        .map_err(StoreError::Open)?;
                    transaction
                        .execute(
                            "DELETE FROM space_sync_stage WHERE did = ?1 AND boundary = ?2",
                            params![did, boundary],
                        )
                        .map_err(StoreError::Open)?;
                }
                let removed_posts = transaction
                    .execute(
                        "DELETE FROM post WHERE author_did = ?1 AND NOT EXISTS (SELECT 1 FROM post_boundary WHERE post_boundary.uri = post.uri)",
                        [did],
                    )
                    .map_err(StoreError::Open)? as u64;
                let boundaries_json = serde_json::to_vec(&entry.boundaries)
                    .map_err(|_| StoreError::InvalidProjectionMutation)?;
                transaction
                    .execute(
                        "INSERT INTO actor_enrollment (did, boundaries_json, observed_at, enrolled) VALUES (?1, ?2, ?3, 1)
                         ON CONFLICT(did) DO UPDATE SET boundaries_json = excluded.boundaries_json, observed_at = excluded.observed_at, enrolled = excluded.enrolled",
                        params![entry.did, boundaries_json, observed_at],
                    )
                    .map_err(StoreError::Open)?;
                (removed_boundaries, removed_posts, true)
            }
            None => {
                let removed_boundaries = previous
                    .and_then(|previous| previous.enrollment)
                    .map(|previous| previous.boundaries)
                    .unwrap_or_default();
                let removed_posts = transaction
                    .execute("DELETE FROM post WHERE author_did = ?1", [did])
                    .map_err(StoreError::Open)? as u64;
                transaction
                    .execute("DELETE FROM actor_cursor WHERE did = ?1", [did])
                    .map_err(StoreError::Open)?;
                transaction
                    .execute("DELETE FROM source_coverage WHERE source_id = ?1", [did])
                    .map_err(StoreError::Open)?;
                transaction
                    .execute("DELETE FROM suppression_marker WHERE source_id = ?1", [did])
                    .map_err(StoreError::Open)?;
                transaction
                    .execute("DELETE FROM space_cursor WHERE did = ?1", [did])
                    .map_err(StoreError::Open)?;
                transaction
                    .execute("DELETE FROM space_sync_stage_cursor WHERE did = ?1", [did])
                    .map_err(StoreError::Open)?;
                transaction
                    .execute(
                        "DELETE FROM space_sync_pending_verification WHERE did = ?1",
                        [did],
                    )
                    .map_err(StoreError::Open)?;
                transaction
                    .execute("DELETE FROM space_sync_stage WHERE did = ?1", [did])
                    .map_err(StoreError::Open)?;
                transaction
                    .execute(
                        "INSERT INTO actor_enrollment (did, boundaries_json, observed_at, enrolled) VALUES (?1, '[]', ?2, 0)
                         ON CONFLICT(did) DO UPDATE SET boundaries_json = excluded.boundaries_json, observed_at = excluded.observed_at, enrolled = excluded.enrolled",
                        params![did, observed_at],
                    )
                    .map_err(StoreError::Open)?;
                (removed_boundaries, removed_posts, false)
            }
        };
        transaction.commit().map_err(StoreError::Open)?;
        Ok(EnrollmentReconciliation {
            removed_boundaries,
            removed_posts,
            enrolled,
        })
    }

    pub fn list_boundaries_for_uris(&self, uris: &[String]) -> Result<Vec<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT boundary FROM post_boundary WHERE uri = ?1 ORDER BY boundary ASC")
            .map_err(StoreError::Open)?;
        let mut boundaries = Vec::new();
        for uri in uris {
            let rows = statement
                .query_map([uri], |row| row.get(0))
                .map_err(StoreError::Open)?;
            boundaries.extend(
                rows.collect::<Result<Vec<String>, _>>()
                    .map_err(StoreError::Open)?,
            );
        }
        Ok(boundaries)
    }
}
