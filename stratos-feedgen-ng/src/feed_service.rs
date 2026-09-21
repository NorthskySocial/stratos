use serde::Serialize;

use crate::{
    cursor::FeedCursor,
    feeds::FeedRegistry,
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
    #[serde(rename = "indexedAt")]
    pub indexed_at: String,
    pub boundaries: Vec<String>,
}

#[derive(Serialize)]
pub struct AuthorView {
    pub did: String,
}

#[derive(Debug)]
pub enum FeedServiceError {
    UnknownFeed,
    BoundaryMismatch,
    FeedNotReady,
    InvalidProjection,
    Store(StoreError),
}

impl std::fmt::Display for FeedServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
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

    pub fn serve(
        &self,
        authorization: ViewerAuthorization<'_>,
        query: FeedQuery<'_>,
    ) -> Result<FeedResponse, FeedServiceError> {
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
                .map(|post| to_feed_view_post(post, authorization.boundaries))
                .collect::<Result<_, _>>()?,
        };
        self.reader
            .release(token, response, query.now)
            .ok_or(FeedServiceError::FeedNotReady)
    }
}

fn to_feed_view_post(
    post: crate::store::FeedPost,
    viewer_boundaries: &[String],
) -> Result<FeedViewPost, FeedServiceError> {
    Ok(FeedViewPost {
        post: PostView {
            uri: post.uri,
            cid: post.cid,
            author: AuthorView {
                did: post.author_did,
            },
            record: serde_json::from_slice(&post.record_json)
                .map_err(|_| FeedServiceError::InvalidProjection)?,
            indexed_at: post.indexed_at,
            boundaries: post
                .boundaries
                .into_iter()
                .filter(|boundary| viewer_boundaries.contains(boundary))
                .collect(),
        },
    })
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
                upserts: vec![ProjectionPost {
                    uri: "at://did:plc:spike/zone.stratos.feed.post/see-you".to_owned(),
                    author_did: "did:plc:spike".to_owned(),
                    cid: "bafyreia".to_owned(),
                    sort_at: "2026-09-21T01:00:00.000Z".to_owned(),
                    indexed_at: "2026-09-21T01:00:00.000Z".to_owned(),
                    retained_at: "2026-09-22T01:00:00.000Z".to_owned(),
                    record_json: br#"{"$type":"zone.stratos.feed.post","text":"Bang"}"#.to_vec(),
                    blob_refs_json: b"[]".to_vec(),
                    boundaries: vec!["bebop".to_owned(), "red-tail".to_owned()],
                }],
                deletes: Vec::new(),
                updated_at: "2026-09-21T01:00:00.000Z".to_owned(),
            })
            .unwrap();
        let mut reader = ProjectionReader::new(store);
        reader.establish_session();
        reader
    }

    fn query<'a>(feed_id: &'a str, cursor: Option<&'a str>) -> FeedQuery<'a> {
        FeedQuery {
            feed_id,
            cursor,
            limit: 50,
            now: NOW,
            as_of: AS_OF,
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
