use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    cursor::FeedCursor,
    feeds::FeedRegistry,
    identifier::RecordUri,
    service::{ProjectionReader, ReadRequest},
    store::StoreError,
};

#[derive(Clone, Copy)]
pub struct ViewerAuthorization<'a> {
    pub did: &'a str,
    pub boundaries: &'a [String],
    pub expires_at: u64,
}

#[derive(Clone, Copy)]
pub struct FeedQuery<'a> {
    pub feed_id: &'a str,
    pub cursor: Option<&'a str>,
    pub limit: u16,
    pub now: u64,
    pub as_of: &'a str,
    pub blob_base_url: &'a str,
}

#[derive(Serialize)]
pub struct FeedResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub feed: Vec<FeedViewPost>,
}

#[derive(Serialize)]
pub struct FeedViewPost {
    pub post: PostView,
}

#[derive(Serialize)]
pub struct PostView {
    pub uri: String,
    pub cid: String,
    pub author: AuthorView,
    pub record: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blobs: Option<Vec<BlobView>>,
    #[serde(rename = "indexedAt")]
    pub indexed_at: String,
    pub boundaries: Vec<String>,
    #[serde(rename = "likeCount")]
    pub like_count: u32,
    #[serde(rename = "repostCount")]
    pub repost_count: u32,
    pub viewer: ViewerState,
}

#[derive(Serialize)]
pub struct ViewerState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub like: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repost: Option<String>,
}

#[derive(Serialize)]
pub struct BlobView {
    pub cid: String,
    pub url: String,
    #[serde(rename = "mimeType")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Deserialize)]
struct StoredBlobReference {
    cid: String,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

struct BlobUrlBuilder(Url);

impl BlobUrlBuilder {
    fn new(base_url: &str) -> Result<Self, FeedServiceError> {
        let base_url = Url::parse(base_url).map_err(|_| FeedServiceError::InvalidProjection)?;
        if !matches!(base_url.scheme(), "http" | "https")
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(FeedServiceError::InvalidProjection);
        }
        Ok(Self(base_url))
    }

    fn build(&self, uri: &str, cid: &str) -> String {
        let mut url = self.0.clone();
        let base = url.path().trim_end_matches('/');
        url.set_path(&format!("{base}/xrpc/zone.stratos.feedgen.getBlob"));
        url.query_pairs_mut()
            .append_pair("uri", uri)
            .append_pair("cid", cid);
        url.to_string()
    }
}

#[cfg(test)]
pub(crate) fn build_blob_url(
    base_url: &str,
    uri: &str,
    cid: &str,
) -> Result<String, FeedServiceError> {
    Ok(BlobUrlBuilder::new(base_url)?.build(uri, cid))
}

#[derive(Serialize)]
pub struct AuthorView {
    pub did: String,
}

#[derive(Debug)]
pub enum FeedServiceError {
    AuthorizationUnavailable,
    UnknownFeed,
    BoundaryMismatch,
    FeedNotReady,
    InvalidProjection,
    Store(StoreError),
}

impl std::fmt::Display for FeedServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::AuthorizationUnavailable => "viewer authorization is unavailable",
            Self::UnknownFeed => "configured feed was not found",
            Self::BoundaryMismatch => "viewer is not authorized for the configured feed",
            Self::FeedNotReady => "feed is unavailable while authorization state is reconciling",
            Self::InvalidProjection => "feed projection contains an invalid record",
            Self::Store(error) => return write!(formatter, "feed projection failed: {error}"),
        })
    }
}

impl std::error::Error for FeedServiceError {}

pub struct FeedService<'a> {
    feeds: &'a FeedRegistry,
    reader: &'a ProjectionReader,
}

impl<'a> FeedService<'a> {
    pub fn new(feeds: &'a FeedRegistry, reader: &'a ProjectionReader) -> Self {
        Self { feeds, reader }
    }

    #[cfg(test)]
    pub(crate) fn serve(
        &self,
        authorization: ViewerAuthorization<'_>,
        query: FeedQuery<'_>,
    ) -> Result<FeedResponse, FeedServiceError> {
        let (token, response) = self.prepare(authorization, query)?;
        self.reader
            .release(token, response, query.now)
            .ok_or(FeedServiceError::FeedNotReady)
    }

    pub(crate) fn serve_serialized(
        &self,
        authorization: ViewerAuthorization<'_>,
        query: FeedQuery<'_>,
    ) -> Result<(Vec<u8>, usize), FeedServiceError> {
        let (token, response) = self.prepare(authorization, query)?;
        let post_count = response.feed.len();
        let response =
            serde_json::to_vec(&response).map_err(|_| FeedServiceError::InvalidProjection)?;
        self.reader
            .release(token, response, query.now)
            .map(|response| (response, post_count))
            .ok_or(FeedServiceError::FeedNotReady)
    }

    fn prepare(
        &self,
        authorization: ViewerAuthorization<'_>,
        query: FeedQuery<'_>,
    ) -> Result<(crate::admission::ReadToken, FeedResponse), FeedServiceError> {
        let feed = self
            .feeds
            .get(query.feed_id)
            .ok_or(FeedServiceError::UnknownFeed)?;
        if !authorization
            .boundaries
            .iter()
            .any(|boundary| boundary == &feed.boundary)
        {
            return Err(FeedServiceError::BoundaryMismatch);
        }
        let cursor = query.cursor.and_then(FeedCursor::decode);
        let blob_urls = BlobUrlBuilder::new(query.blob_base_url)?;
        let Some((token, page)) = self
            .reader
            .prepare(ReadRequest {
                viewer: authorization.did,
                boundary: &feed.boundary,
                authority_expires_at: authorization.expires_at,
                now: query.now,
                cursor: cursor.as_ref(),
                limit: query.limit,
                as_of: query.as_of,
            })
            .map_err(FeedServiceError::Store)?
        else {
            return Err(FeedServiceError::FeedNotReady);
        };
        let mut summaries = page.summaries;
        let response = FeedResponse {
            cursor: page.cursor.map(|cursor| cursor.encode()),
            feed: page
                .posts
                .into_iter()
                .map(|post| {
                    let summary = summaries.remove(&post.uri).unwrap_or_default();
                    to_feed_view_post(post, summary, authorization.boundaries, &blob_urls)
                })
                .collect::<Result<_, _>>()?,
        };
        Ok((token, response))
    }
}

fn to_feed_view_post(
    post: crate::store::FeedPost,
    summary: crate::store::InteractionSummary,
    viewer_boundaries: &[String],
    blob_urls: &BlobUrlBuilder,
) -> Result<FeedViewPost, FeedServiceError> {
    let blobs = blob_views(&post, blob_urls);
    Ok(FeedViewPost {
        post: PostView {
            uri: post.uri,
            cid: post.cid,
            author: AuthorView {
                did: post.author_did,
            },
            record: serde_json::from_slice(&post.record_json)
                .map_err(|_| FeedServiceError::InvalidProjection)?,
            blobs,
            indexed_at: post.indexed_at,
            boundaries: post
                .boundaries
                .into_iter()
                .filter(|boundary| viewer_boundaries.contains(boundary))
                .collect(),
            like_count: summary.like_count,
            repost_count: summary.repost_count,
            viewer: ViewerState {
                like: summary.viewer_like,
                repost: summary.viewer_repost,
            },
        },
    })
}

fn blob_views(post: &crate::store::FeedPost, urls: &BlobUrlBuilder) -> Option<Vec<BlobView>> {
    if !matches!(RecordUri::parse(&post.uri), Ok(RecordUri::Repo { .. })) {
        return None;
    }
    let references =
        serde_json::from_slice::<Vec<StoredBlobReference>>(&post.blob_refs_json).ok()?;
    let blobs = references
        .into_iter()
        .filter(|reference| cid::Cid::try_from(reference.cid.as_str()).is_ok())
        .map(|reference| BlobView {
            url: urls.build(&post.uri, &reference.cid),
            cid: reference.cid,
            mime_type: reference.mime_type,
        })
        .collect::<Vec<_>>();
    (!blobs.is_empty()).then_some(blobs)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::{FeedQuery, FeedService, FeedServiceError, ViewerAuthorization};
    use crate::{
        authorization::ViewerAuthorization as AuthorityGrant,
        feeds::{FeedDescription, FeedRegistry},
        lifecycle::ControlLifecycle,
        readiness::{FeedReadinessGate, ReconciliationOutcome},
        service::ProjectionReader,
        store::{
            ActorPage, EncryptedStore, InteractionChanges, InteractionKind, ProjectionInteraction,
            ProjectionPost, StorageKey,
        },
    };

    const NOW: u64 = 1_790_000_000;
    const AS_OF: &str = "2026-09-21T00:00:00.000Z";

    fn registry() -> FeedRegistry {
        FeedRegistry::new([
            FeedDescription {
                id: "bebop".to_owned(),
                boundary: "bebop".to_owned(),
                display_name: Some("Bebop".to_owned()),
                description: None,
            },
            FeedDescription {
                id: "red-tail".to_owned(),
                boundary: "red-tail".to_owned(),
                display_name: None,
                description: None,
            },
        ])
        .unwrap()
    }

    fn reader_with_post() -> ProjectionReader {
        let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        store
            .apply_actor_page(ActorPage {
                authority_did: "did:plc:stratos".to_owned(),
                actor_did: "did:plc:spike".to_owned(),
                sequence: 1,
                upserts: vec![reader_post()],
                deletes: Vec::new(),
                updated_at: "2026-09-21T01:00:00.000Z".to_owned(),
                interactions: crate::store::InteractionChanges::default(),
            })
            .unwrap();
        let mut reader = ProjectionReader::new(store);
        reader.establish_session();
        reader
    }

    fn reader_post() -> ProjectionPost {
        ProjectionPost {
            uri: "at://did:plc:spike/zone.stratos.feed.post/see-you".to_owned(),
            author_did: "did:plc:spike".to_owned(),
            cid: "bafyreia".to_owned(),
            sort_at: "2026-09-21T01:00:00.000Z".to_owned(),
            indexed_at: "2026-09-21T01:00:00.000Z".to_owned(),
            retained_at: "2026-09-22T01:00:00.000Z".to_owned(),
            record_json: br#"{"$type":"zone.stratos.feed.post","text":"Bang"}"#.to_vec(),
            blob_refs_json: b"[]".to_vec(),
            boundaries: vec!["bebop".to_owned(), "red-tail".to_owned()],
        }
    }

    fn query<'a>(feed_id: &'a str, cursor: Option<&'a str>) -> FeedQuery<'a> {
        FeedQuery {
            feed_id,
            cursor,
            limit: 50,
            now: NOW,
            as_of: AS_OF,
            blob_base_url: "https://feedgen.example.test/service/",
        }
    }

    #[test]
    fn serves_a_configured_boundary_and_preserves_the_post_contract() {
        let feeds = registry();
        let reader = reader_with_post();
        let service = FeedService::new(&feeds, &reader);
        let boundaries = ["bebop".to_owned()];

        let response = service
            .serve(
                ViewerAuthorization {
                    did: "did:plc:faye",
                    boundaries: &boundaries,
                    expires_at: NOW + 60,
                },
                query("bebop", None),
            )
            .unwrap();

        assert_eq!(response.feed.len(), 1);
        let post = &response.feed[0].post;
        assert_eq!(post.author.did, "did:plc:spike");
        assert_eq!(post.record["text"], "Bang");
        assert_eq!(post.boundaries, ["bebop"]);
    }

    #[test]
    fn rejects_unknown_or_unauthorized_configured_feeds() {
        let feeds = registry();
        let reader = reader_with_post();
        let service = FeedService::new(&feeds, &reader);
        let boundaries = ["bebop".to_owned()];
        let authorization = ViewerAuthorization {
            did: "did:plc:faye",
            boundaries: &boundaries,
            expires_at: NOW + 60,
        };

        assert!(matches!(
            service.serve(authorization, query("unknown", None)),
            Err(FeedServiceError::UnknownFeed)
        ));
        assert!(matches!(
            service.serve(authorization, query("red-tail", None)),
            Err(FeedServiceError::BoundaryMismatch)
        ));
    }

    #[test]
    fn serializes_before_releasing_the_admitted_page() {
        let feeds = registry();
        let reader = reader_with_post();
        let service = FeedService::new(&feeds, &reader);
        let boundaries = ["bebop".to_owned()];

        let (response, post_count) = service
            .serve_serialized(
                ViewerAuthorization {
                    did: "did:plc:faye",
                    boundaries: &boundaries,
                    expires_at: NOW + 60,
                },
                query("bebop", None),
            )
            .unwrap();

        assert_eq!(post_count, 1);
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(response["feed"][0]["post"]["record"]["text"], "Bang");
    }

    #[test]
    fn exposes_only_verified_repository_blob_urls() {
        let feeds = registry();
        let mut reader = reader_with_post();
        let cid = cid::Cid::new_v1(
            0x55,
            multihash::Multihash::<64>::wrap(0x12, &[7; 32]).unwrap(),
        )
        .to_string();
        reader
            .apply_actor_page(ActorPage {
                authority_did: "did:plc:stratos".to_owned(),
                actor_did: "did:plc:spike".to_owned(),
                sequence: 2,
                upserts: vec![ProjectionPost {
                    blob_refs_json: serde_json::to_vec(&serde_json::json!([
                        { "cid": cid, "mimeType": "image/png" },
                        { "cid": "not-a-cid" }
                    ]))
                    .unwrap(),
                    ..reader_post()
                }],
                deletes: Vec::new(),
                updated_at: "2026-09-21T01:00:01.000Z".to_owned(),
                interactions: crate::store::InteractionChanges::default(),
            })
            .unwrap();
        let service = FeedService::new(&feeds, &reader);
        let boundaries = ["bebop".to_owned()];

        let response = service
            .serve(
                ViewerAuthorization {
                    did: "did:plc:faye",
                    boundaries: &boundaries,
                    expires_at: NOW + 60,
                },
                query("bebop", None),
            )
            .unwrap();

        let blob = &response.feed[0].post.blobs.as_ref().unwrap()[0];
        assert_eq!(blob.mime_type.as_deref(), Some("image/png"));
        assert!(
            blob.url
                .starts_with("https://feedgen.example.test/service/xrpc/")
        );
        assert!(blob.url.contains("uri=at%3A%2F%2Fdid%3Aplc%3Aspike"));
    }

    #[test]
    fn treats_a_malformed_cursor_as_the_first_page() {
        let feeds = registry();
        let reader = reader_with_post();
        let service = FeedService::new(&feeds, &reader);
        let boundaries = ["bebop".to_owned()];

        let response = service
            .serve(
                ViewerAuthorization {
                    did: "did:plc:faye",
                    boundaries: &boundaries,
                    expires_at: NOW + 60,
                },
                query("bebop", Some("not-a-cursor")),
            )
            .unwrap();

        assert_eq!(response.feed.len(), 1);
    }

    #[test]
    fn fails_closed_without_an_authoritative_session() {
        let feeds = registry();
        let store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
        let reader = ProjectionReader::new(store);
        let service = FeedService::new(&feeds, &reader);
        let boundaries = ["bebop".to_owned()];

        assert!(matches!(
            service.serve(
                ViewerAuthorization {
                    did: "did:plc:faye",
                    boundaries: &boundaries,
                    expires_at: NOW + 60,
                },
                query("bebop", None),
            ),
            Err(FeedServiceError::FeedNotReady)
        ));
    }

    const AUTHORITY: &str = "did:web:stratos.example.test";
    const FAYE: &str = "did:plc:faye";
    const JET: &str = "did:plc:jetblack";
    const ED: &str = "did:plc:ed";
    const SPIKE: &str = "did:plc:spike";
    const SPIKE_POST: &str = "at://did:plc:spike/zone.stratos.feed.post/see-you";
    const LIVE_UNTIL: &str = "2026-09-22T00:00:00.000Z";
    const EXPIRED_AT: &str = "2026-09-20T00:00:00.000Z";

    fn serving_lifecycle(viewers: &[&str]) -> ControlLifecycle {
        let lifecycle = ControlLifecycle::for_authority(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            AUTHORITY,
        )
        .unwrap();
        for viewer in viewers {
            lifecycle
                .apply_viewer_authorization(
                    AuthorityGrant {
                        did: (*viewer).to_owned(),
                        boundaries: vec!["bebop".to_owned()],
                        expires_at: NOW + 60,
                    },
                    NOW,
                )
                .unwrap();
        }
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        lifecycle
    }

    fn publish_post(lifecycle: &ControlLifecycle, sequence: u64) {
        lifecycle
            .apply_actor_page(ActorPage {
                authority_did: AUTHORITY.to_owned(),
                actor_did: SPIKE.to_owned(),
                sequence,
                upserts: vec![reader_post()],
                deletes: Vec::new(),
                updated_at: "2026-09-21T01:00:00.000Z".to_owned(),
                interactions: InteractionChanges::default(),
            })
            .unwrap();
    }

    fn interaction(
        kind: InteractionKind,
        actor: &str,
        rkey: &str,
        subject: &str,
        boundary: &str,
        retained_at: &str,
    ) -> ProjectionInteraction {
        ProjectionInteraction {
            uri: format!("at://{actor}/{}/{rkey}", kind.collection()),
            actor_did: actor.to_owned(),
            kind,
            subject_uri: subject.to_owned(),
            boundary: boundary.to_owned(),
            indexed_at: "2026-09-21T01:00:00.000Z".to_owned(),
            retained_at: retained_at.to_owned(),
        }
    }

    fn like(actor: &str, rkey: &str) -> ProjectionInteraction {
        interaction(
            InteractionKind::Like,
            actor,
            rkey,
            SPIKE_POST,
            "bebop",
            LIVE_UNTIL,
        )
    }

    fn repost(actor: &str, rkey: &str) -> ProjectionInteraction {
        interaction(
            InteractionKind::Repost,
            actor,
            rkey,
            SPIKE_POST,
            "bebop",
            LIVE_UNTIL,
        )
    }

    fn apply_interactions(
        lifecycle: &ControlLifecycle,
        actor: &str,
        sequence: u64,
        changes: InteractionChanges,
    ) {
        lifecycle
            .apply_actor_page(ActorPage {
                authority_did: AUTHORITY.to_owned(),
                actor_did: actor.to_owned(),
                sequence,
                upserts: Vec::new(),
                deletes: Vec::new(),
                updated_at: "2026-09-21T01:00:00.000Z".to_owned(),
                interactions: changes,
            })
            .unwrap();
    }

    fn upserting(upserts: Vec<ProjectionInteraction>) -> InteractionChanges {
        InteractionChanges {
            upserts,
            deletes: Vec::new(),
        }
    }

    fn serve_as(lifecycle: &ControlLifecycle, viewer: &str) -> (serde_json::Value, String) {
        let (bytes, _) = lifecycle
            .serve_viewer_feed(viewer, &registry(), query("bebop", None))
            .unwrap();
        let body = String::from_utf8(bytes).unwrap();
        (serde_json::from_str(&body).unwrap(), body)
    }

    fn first_post(page: &serde_json::Value) -> &serde_json::Value {
        &page["feed"][0]["post"]
    }

    #[test]
    fn a_served_post_carries_its_counts_and_the_viewers_own_records() {
        let lifecycle = serving_lifecycle(&[FAYE]);
        publish_post(&lifecycle, 1);
        apply_interactions(
            &lifecycle,
            FAYE,
            1,
            upserting(vec![like(FAYE, "one"), repost(FAYE, "two")]),
        );
        apply_interactions(&lifecycle, JET, 1, upserting(vec![like(JET, "three")]));
        apply_interactions(&lifecycle, ED, 1, upserting(vec![like(ED, "four")]));

        let (page, _) = serve_as(&lifecycle, FAYE);

        let post = first_post(&page);
        assert_eq!(post["likeCount"], 3);
        assert_eq!(post["repostCount"], 1);
        assert_eq!(
            post["viewer"],
            serde_json::json!({
                "like": like(FAYE, "one").uri,
                "repost": repost(FAYE, "two").uri,
            })
        );
    }

    #[test]
    fn a_post_nobody_touched_serves_zero_counts_and_an_empty_viewer() {
        let lifecycle = serving_lifecycle(&[FAYE]);
        publish_post(&lifecycle, 1);

        let (page, _) = serve_as(&lifecycle, FAYE);

        let post = first_post(&page);
        assert_eq!(post.get("likeCount"), Some(&serde_json::json!(0)));
        assert_eq!(post.get("repostCount"), Some(&serde_json::json!(0)));
        assert_eq!(post.get("viewer"), Some(&serde_json::json!({})));
    }

    #[test]
    fn likes_in_another_boundary_of_likes_and_in_the_other_uri_form_count_for_nothing() {
        let lifecycle = serving_lifecycle(&[FAYE]);
        publish_post(&lifecycle, 1);
        let space_form = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:spike/zone.stratos.feed.post/see-you";
        apply_interactions(&lifecycle, JET, 1, upserting(vec![like(JET, "counted")]));
        apply_interactions(
            &lifecycle,
            ED,
            1,
            upserting(vec![interaction(
                InteractionKind::Like,
                ED,
                "elsewhere",
                SPIKE_POST,
                "red-tail",
                LIVE_UNTIL,
            )]),
        );
        apply_interactions(
            &lifecycle,
            FAYE,
            1,
            upserting(vec![
                interaction(
                    InteractionKind::Like,
                    FAYE,
                    "of-a-like",
                    &like(ED, "x").uri,
                    "bebop",
                    LIVE_UNTIL,
                ),
                interaction(
                    InteractionKind::Repost,
                    FAYE,
                    "other-form",
                    space_form,
                    "bebop",
                    LIVE_UNTIL,
                ),
            ]),
        );

        let (page, _) = serve_as(&lifecycle, FAYE);

        let post = first_post(&page);
        assert_eq!(post["likeCount"], 1);
        assert_eq!(post["repostCount"], 0);
    }

    #[test]
    fn two_likes_by_one_actor_count_once_and_deleting_one_leaves_one() {
        let lifecycle = serving_lifecycle(&[FAYE]);
        publish_post(&lifecycle, 1);
        apply_interactions(
            &lifecycle,
            JET,
            1,
            upserting(vec![
                like(JET, "one"),
                like(JET, "two"),
                repost(JET, "three"),
                repost(JET, "four"),
            ]),
        );
        let (page, _) = serve_as(&lifecycle, FAYE);
        assert_eq!(first_post(&page)["likeCount"], 1);
        assert_eq!(first_post(&page)["repostCount"], 1);

        apply_interactions(
            &lifecycle,
            JET,
            2,
            InteractionChanges {
                upserts: Vec::new(),
                deletes: vec![like(JET, "one").uri, repost(JET, "three").uri],
            },
        );

        let (page, _) = serve_as(&lifecycle, FAYE);
        assert_eq!(first_post(&page)["likeCount"], 1);
        assert_eq!(first_post(&page)["repostCount"], 1);
    }

    #[test]
    fn a_viewer_never_sees_another_viewers_record_uris() {
        let lifecycle = serving_lifecycle(&[FAYE, JET, ED]);
        publish_post(&lifecycle, 1);
        apply_interactions(
            &lifecycle,
            FAYE,
            1,
            upserting(vec![like(FAYE, "one"), repost(FAYE, "two")]),
        );
        apply_interactions(
            &lifecycle,
            JET,
            1,
            upserting(vec![like(JET, "three"), repost(JET, "four")]),
        );

        let (faye_page, faye_body) = serve_as(&lifecycle, FAYE);
        let (jet_page, jet_body) = serve_as(&lifecycle, JET);
        let (ed_page, ed_body) = serve_as(&lifecycle, ED);

        assert_eq!(
            first_post(&faye_page)["viewer"]["like"],
            like(FAYE, "one").uri
        );
        assert_eq!(
            first_post(&jet_page)["viewer"]["like"],
            like(JET, "three").uri
        );
        assert_eq!(
            first_post(&jet_page)["viewer"]["repost"],
            repost(JET, "four").uri
        );
        assert_eq!(first_post(&ed_page)["viewer"], serde_json::json!({}));
        assert!(!faye_body.contains(JET) && !jet_body.contains(FAYE));
        assert!(!ed_body.contains(FAYE) && !ed_body.contains(JET));
    }

    #[test]
    fn a_like_that_arrives_before_its_post_counts_once_the_post_arrives() {
        let lifecycle = serving_lifecycle(&[FAYE]);
        apply_interactions(&lifecycle, JET, 1, upserting(vec![like(JET, "early")]));
        let (page, _) = serve_as(&lifecycle, FAYE);
        assert!(page["feed"].as_array().unwrap().is_empty());

        publish_post(&lifecycle, 1);

        let (page, _) = serve_as(&lifecycle, FAYE);
        assert_eq!(first_post(&page)["likeCount"], 1);
    }

    #[test]
    fn an_expired_like_is_not_counted_and_no_liker_is_named() {
        let lifecycle = serving_lifecycle(&[ED]);
        publish_post(&lifecycle, 1);
        let expired = interaction(
            InteractionKind::Like,
            FAYE,
            "old",
            SPIKE_POST,
            "bebop",
            EXPIRED_AT,
        );
        apply_interactions(&lifecycle, FAYE, 1, upserting(vec![expired]));
        apply_interactions(&lifecycle, JET, 1, upserting(vec![like(JET, "live")]));
        let before_expiry = FeedQuery {
            as_of: "2026-09-19T00:00:00.000Z",
            ..query("bebop", None)
        };
        let (earlier, _) = lifecycle
            .serve_viewer_feed(ED, &registry(), before_expiry)
            .unwrap();
        let earlier: serde_json::Value = serde_json::from_slice(&earlier).unwrap();
        assert_eq!(
            first_post(&earlier)["likeCount"],
            2,
            "the expired row is still stored"
        );

        let (page, body) = serve_as(&lifecycle, ED);

        assert_eq!(first_post(&page)["likeCount"], 1);
        assert!(!body.contains(FAYE) && !body.contains(JET));
    }

    fn fifty_posts() -> Vec<ProjectionPost> {
        (0..50)
            .map(|index| ProjectionPost {
                uri: format!("at://did:plc:spike/zone.stratos.feed.post/bang-{index:02}"),
                sort_at: format!("2026-09-21T01:{index:02}:00.000Z"),
                boundaries: vec!["bebop".to_owned()],
                ..reader_post()
            })
            .collect()
    }

    fn median_and_worst(
        mut samples: Vec<std::time::Duration>,
    ) -> (std::time::Duration, std::time::Duration) {
        samples.sort();
        (samples[samples.len() / 2], samples[samples.len() - 1])
    }

    #[test]
    fn a_fifty_post_page_with_ten_likes_each_serves_every_count() {
        const SAMPLES: usize = 25;
        let lifecycle = serving_lifecycle(&[FAYE]);
        lifecycle
            .apply_actor_page(ActorPage {
                authority_did: AUTHORITY.to_owned(),
                actor_did: SPIKE.to_owned(),
                sequence: 1,
                upserts: fifty_posts(),
                deletes: Vec::new(),
                updated_at: "2026-09-21T01:00:00.000Z".to_owned(),
                interactions: InteractionChanges::default(),
            })
            .unwrap();
        let measure = || {
            (0..SAMPLES)
                .map(|_| {
                    let started = std::time::Instant::now();
                    let served = serve_as(&lifecycle, FAYE);
                    let elapsed = started.elapsed();
                    assert_eq!(served.0["feed"].as_array().unwrap().len(), 50);
                    elapsed
                })
                .collect::<Vec<_>>()
        };
        let (bare_median, bare_worst) = median_and_worst(measure());

        for liker in 0..10 {
            let did = format!("did:plc:crew-{liker}");
            let likes = fifty_posts()
                .iter()
                .map(|post| {
                    interaction(
                        InteractionKind::Like,
                        &did,
                        post.uri.rsplit('/').next().unwrap(),
                        &post.uri,
                        "bebop",
                        LIVE_UNTIL,
                    )
                })
                .collect();
            apply_interactions(&lifecycle, &did, 1, upserting(likes));
        }
        let (liked_median, liked_worst) = median_and_worst(measure());

        let (page, _) = serve_as(&lifecycle, FAYE);
        assert!(
            page["feed"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["post"]["likeCount"] == 10)
        );
        eprintln!(
            "page_timing posts=50 samples={SAMPLES} without_interactions_median_us={} without_interactions_worst_us={} likes_per_post=10 with_interactions_median_us={} with_interactions_worst_us={}",
            bare_median.as_micros(),
            bare_worst.as_micros(),
            liked_median.as_micros(),
            liked_worst.as_micros(),
        );
    }
}
