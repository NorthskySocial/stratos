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
    ) -> Result<Vec<u8>, FeedServiceError> {
        let (token, response) = self.prepare(authorization, query)?;
        let response =
            serde_json::to_vec(&response).map_err(|_| FeedServiceError::InvalidProjection)?;
        self.reader
            .release(token, response, query.now)
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
        let response = FeedResponse {
            cursor: page.cursor.map(|cursor| cursor.encode()),
            feed: page
                .posts
                .into_iter()
                .map(|post| to_feed_view_post(post, authorization.boundaries, &blob_urls))
                .collect::<Result<_, _>>()?,
        };
        Ok((token, response))
    }
}

fn to_feed_view_post(
    post: crate::store::FeedPost,
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
    use super::{FeedQuery, FeedService, FeedServiceError, ViewerAuthorization};
    use crate::{
        feeds::{FeedDescription, FeedRegistry},
        service::ProjectionReader,
        store::{ActorPage, EncryptedStore, ProjectionPost, StorageKey},
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

        let response = service
            .serve_serialized(
                ViewerAuthorization {
                    did: "did:plc:faye",
                    boundaries: &boundaries,
                    expires_at: NOW + 60,
                },
                query("bebop", None),
            )
            .unwrap();

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
}
