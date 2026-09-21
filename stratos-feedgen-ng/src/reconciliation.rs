use crate::{
    authority::AuthorityClient,
    lifecycle::ControlLifecycle,
    readiness::ReconciliationOutcome,
    store::{ActorEnrollment, EnrollmentReconciliation, StoreError},
};

const DEFAULT_PAGE_SIZE: u16 = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReconciliationOptions {
    pub page_size: u16,
    pub max_actors: u32,
}

impl Default for ReconciliationOptions {
    fn default() -> Self {
        Self {
            page_size: DEFAULT_PAGE_SIZE,
            max_actors: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ReconciliationSummary {
    pub examined: u32,
    pub errors: u32,
    pub truncated: bool,
    pub unenrolled: u32,
    pub shrunk: u32,
    pub removed_posts: u64,
}

impl ReconciliationSummary {
    fn outcome(self) -> ReconciliationOutcome {
        ReconciliationOutcome {
            errors: self.errors,
            truncated: self.truncated,
        }
    }
}

/// Runs one reconciliation generation and leaves feed admission closed unless
/// every persisted actor was resolved and applied successfully.
pub async fn reconcile_current_session(
    lifecycle: &ControlLifecycle,
    authority: &dyn AuthorityClient,
    now: u64,
    observed_at: &str,
    options: ReconciliationOptions,
) -> Result<ReconciliationSummary, StoreError> {
    let generation = lifecycle.begin_reconciliation();
    match reconcile_actor_enrollments(lifecycle, authority, now, observed_at, options).await {
        Ok(summary) => {
            lifecycle.complete_reconciliation(generation, summary.outcome());
            Ok(summary)
        }
        Err(error) => {
            lifecycle.complete_reconciliation(
                generation,
                ReconciliationOutcome {
                    errors: 1,
                    truncated: false,
                },
            );
            Err(error)
        }
    }
}

/// Re-resolves the durable enrollment snapshot in bounded pages. Authority
/// requests and projection writes are intentionally serialized: this keeps the
/// 1-vCPU deployment within a fixed IO and SQLite write budget.
pub async fn reconcile_actor_enrollments(
    lifecycle: &ControlLifecycle,
    authority: &dyn AuthorityClient,
    now: u64,
    observed_at: &str,
    options: ReconciliationOptions,
) -> Result<ReconciliationSummary, StoreError> {
    let mut after_did = None;
    let mut summary = ReconciliationSummary::default();
    loop {
        let page =
            lifecycle.list_actor_enrollments_page(after_did.as_deref(), options.page_size)?;
        if page.is_empty() {
            return Ok(summary);
        }
        for actor in &page {
            if options.max_actors != 0 && summary.examined >= options.max_actors {
                summary.truncated = true;
                return Ok(summary);
            }
            summary.examined += 1;
            let resolution = match authority.resolve_enrollment(&actor.did, now).await {
                Ok(resolution) => resolution,
                Err(_) => {
                    summary.errors += 1;
                    continue;
                }
            };
            if resolution.did != actor.did {
                summary.errors += 1;
                continue;
            }
            let enrollment = resolution.enrolled.then_some(ActorEnrollment {
                did: resolution.did,
                boundaries: resolution.boundaries,
                observed_at: observed_at.to_owned(),
            });
            match lifecycle.reconcile_actor_enrollment(&actor.did, observed_at, enrollment) {
                Ok(result) => update_summary(&mut summary, result),
                Err(_) => summary.errors += 1,
            }
        }
        after_did = page.last().map(|actor| actor.did.clone());
    }
}

fn update_summary(summary: &mut ReconciliationSummary, result: EnrollmentReconciliation) {
    if !result.enrolled {
        summary.unenrolled += 1;
    } else if !result.removed_boundaries.is_empty() {
        summary.shrunk += 1;
    }
    summary.removed_posts += result.removed_posts;
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Arc};

    use async_trait::async_trait;

    use crate::{
        authority::{AuthorityClient, AuthorityError, EnrollmentResolution},
        lifecycle::ControlLifecycle,
        readiness::FeedReadinessGate,
        service::ProjectionReader,
        store::{ActorEnrollment, EncryptedStore, ProjectionPost, StorageKey},
    };

    use super::{ReconciliationOptions, reconcile_actor_enrollments, reconcile_current_session};

    struct TestAuthority {
        resolutions: BTreeMap<String, EnrollmentResolution>,
    }

    #[async_trait]
    impl AuthorityClient for TestAuthority {
        async fn resolve_enrollment(
            &self,
            did: &str,
            _: u64,
        ) -> Result<EnrollmentResolution, AuthorityError> {
            self.resolutions
                .get(did)
                .cloned()
                .ok_or(AuthorityError::Unavailable)
        }
    }

    fn lifecycle_with_enrollments() -> ControlLifecycle {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        for did in ["did:plc:faye", "did:plc:spike"] {
            store
                .reconcile_actor_enrollment(
                    did,
                    "1998-04-03T00:00:00.000Z",
                    Some(ActorEnrollment {
                        did: did.to_owned(),
                        boundaries: vec!["bebop".to_owned(), "crew".to_owned()],
                        observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                    }),
                )
                .unwrap();
        }
        store
            .apply_actor_page(crate::store::ActorPage {
                authority_did: "did:web:stratos.example.test".to_owned(),
                actor_did: "did:plc:faye".to_owned(),
                sequence: 1,
                upserts: vec![ProjectionPost {
                    uri: "at://did:plc:faye/zone.stratos.feed.post/see-you".to_owned(),
                    author_did: "did:plc:faye".to_owned(),
                    cid: "bafyreia".to_owned(),
                    sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
                    indexed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                    retained_at: "1998-04-04T00:00:00.000Z".to_owned(),
                    record_json: b"{}".to_vec(),
                    blob_refs_json: b"[]".to_vec(),
                    boundaries: vec!["bebop".to_owned(), "crew".to_owned()],
                }],
                deletes: Vec::new(),
                updated_at: "1998-04-03T00:00:00.000Z".to_owned(),
            })
            .unwrap();
        ControlLifecycle::new(
            ProjectionReader::new(store),
            Arc::new(std::sync::Mutex::new(FeedReadinessGate::default())),
        )
    }

    #[tokio::test]
    async fn purges_unenrolled_actors_and_persists_boundary_shrinks() {
        let lifecycle = lifecycle_with_enrollments();
        let authority = TestAuthority {
            resolutions: BTreeMap::from([
                (
                    "did:plc:faye".to_owned(),
                    EnrollmentResolution {
                        did: "did:plc:faye".to_owned(),
                        enrolled: false,
                        boundaries: Vec::new(),
                    },
                ),
                (
                    "did:plc:spike".to_owned(),
                    EnrollmentResolution {
                        did: "did:plc:spike".to_owned(),
                        enrolled: true,
                        boundaries: vec!["bebop".to_owned()],
                    },
                ),
            ]),
        };

        let summary = reconcile_actor_enrollments(
            &lifecycle,
            &authority,
            1,
            "1998-04-03T00:00:01.000Z",
            ReconciliationOptions {
                page_size: 1,
                max_actors: 0,
            },
        )
        .await
        .unwrap();

        assert_eq!(summary.examined, 2);
        assert_eq!(summary.unenrolled, 1);
        assert_eq!(summary.shrunk, 1);
        assert_eq!(summary.removed_posts, 1);
        assert_eq!(summary.errors, 0);
        let enrolled = lifecycle.list_actor_enrollments_page(None, 8).unwrap();
        assert_eq!(enrolled.len(), 1);
        assert_eq!(enrolled[0].did, "did:plc:spike");
        assert_eq!(enrolled[0].boundaries, ["bebop"]);
    }

    #[tokio::test]
    async fn leaves_a_failed_authority_snapshot_unchanged_and_marks_the_pass_incomplete() {
        let lifecycle = lifecycle_with_enrollments();
        let authority = TestAuthority {
            resolutions: BTreeMap::new(),
        };

        let summary = reconcile_actor_enrollments(
            &lifecycle,
            &authority,
            1,
            "1998-04-03T00:00:01.000Z",
            ReconciliationOptions {
                page_size: 8,
                max_actors: 1,
            },
        )
        .await
        .unwrap();

        assert_eq!(summary.examined, 1);
        assert_eq!(summary.errors, 1);
        assert!(summary.truncated);
        assert_eq!(
            lifecycle
                .list_actor_enrollments_page(None, 8)
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn closes_a_ready_session_when_reconciliation_is_incomplete() {
        let readiness = Arc::new(std::sync::Mutex::new(FeedReadinessGate::default()));
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .reconcile_actor_enrollment(
                "did:plc:faye",
                "1998-04-03T00:00:00.000Z",
                Some(ActorEnrollment {
                    did: "did:plc:faye".to_owned(),
                    boundaries: vec!["bebop".to_owned()],
                    observed_at: "1998-04-03T00:00:00.000Z".to_owned(),
                }),
            )
            .unwrap();
        let lifecycle = ControlLifecycle::new(ProjectionReader::new(store), Arc::clone(&readiness));
        lifecycle.session_established();
        let initial = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            initial,
            crate::readiness::ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        assert!(readiness.lock().unwrap().is_ready());

        let summary = reconcile_current_session(
            &lifecycle,
            &TestAuthority {
                resolutions: BTreeMap::new(),
            },
            1,
            "1998-04-03T00:00:01.000Z",
            ReconciliationOptions::default(),
        )
        .await
        .unwrap();

        assert_eq!(summary.errors, 1);
        assert!(!readiness.lock().unwrap().is_ready());
    }
}
