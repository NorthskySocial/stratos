use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cid::Cid;
use http_body_util::BodyExt;
use p256::ecdsa::{SigningKey, signature::Signer};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use crate::{
    auth::{FeedRequestVerifier, IdentityKeyResolver, IdentityResolutionError},
    authority::{AuthorityClient, AuthorityError, EnrollmentResolution},
    blob_cache::BlobCache,
    blob_service::BlobService,
    blob_upstream::{BlobUpstream, BlobUpstreamError},
    config::{FeedgenConfig, ProjectionRetention, StorageProfile},
    feeds::{FeedDescription, FeedRegistry},
    lifecycle::ControlLifecycle,
    readiness::FeedReadinessGate,
    service::ProjectionReader,
    service_auth::ServiceSigningKey,
    store::{ActorPage, EncryptedStore, ProjectionPost, StorageKey},
};

use super::{
    FeedServerState, ServerState, blob_mime, ensure_viewer_authorization, feed_error, router,
    router_with_feed_with_request_limit,
};

struct StaticAuthority(AtomicUsize);

#[async_trait]
impl AuthorityClient for StaticAuthority {
    async fn resolve_enrollment(
        &self,
        did: &str,
        _now: u64,
    ) -> Result<EnrollmentResolution, AuthorityError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(EnrollmentResolution {
            did: did.to_owned(),
            enrolled: true,
            boundaries: vec!["did:web:stratos.example.test/bebop".to_owned()],
        })
    }
}

struct PanicAuthority;

#[async_trait]
impl AuthorityClient for PanicAuthority {
    async fn resolve_enrollment(
        &self,
        _: &str,
        _: u64,
    ) -> Result<EnrollmentResolution, AuthorityError> {
        panic!("a full request limit must reject before resolving a viewer enrollment")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedLimitFixture {
    version: u8,
    cases: Vec<FeedLimitCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedLimitCase {
    name: String,
    limit: Option<u16>,
    expected_status: u16,
    expected_error: Option<String>,
    expected_applied_limit: Option<u16>,
}

fn config() -> FeedgenConfig {
    FeedgenConfig {
        service_did: "did:web:feedgen.example.test".to_string(),
        public_url: "https://feedgen.example.test".to_string(),
        public_key_multibase: "zTestKey".to_string(),
        signing_key: ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap(),
        stratos_service_url: "https://stratos.example.test".to_string(),
        stratos_public_url: "https://stratos.example.test".to_string(),
        stratos_service_did: "did:web:stratos.example.test".to_string(),
        plc_url: "https://plc.example.test".to_string(),
        plc_private_cidrs: None,
        storage: StorageProfile::Memory,
        retention: ProjectionRetention {
            max_age: std::time::Duration::from_secs(60 * 60),
            max_bytes: 16 * 1024 * 1024,
        },
        actor_max_connections: 8,
    }
}

fn feeds() -> FeedRegistry {
    FeedRegistry::new([FeedDescription {
        id: "bebop".to_string(),
        boundary: "bebop".to_string(),
        display_name: Some("Bebop".to_string()),
        description: None,
    }])
    .unwrap()
}

#[tokio::test]
async fn resolves_viewer_boundaries_once_and_reuses_the_authoritative_cache() {
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    let lifecycle = Arc::new(ControlLifecycle::new(
        ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        ),
        Arc::clone(&readiness),
    ));
    let key = SigningKey::from_bytes(&[11; 32].into()).unwrap();
    let resolver: Arc<dyn IdentityKeyResolver> = Arc::new(StaticResolver(did_key(&key)));
    let authority = Arc::new(StaticAuthority(AtomicUsize::new(0)));
    let state = FeedServerState {
        server: Arc::new(ServerState {
            config: config(),
            feeds: feeds(),
            readiness,
            pds_space_sync: None,
        }),
        lifecycle: Arc::clone(&lifecycle),
        verifier: FeedRequestVerifier::new(
            "did:web:feedgen.example.test",
            ["zone.stratos.feedgen.getFeed".to_owned()],
            resolver,
        ),
        request_permits: Arc::new(tokio::sync::Semaphore::new(4)),
        blobs: None,
        authority: Some(authority.clone()),
    };

    ensure_viewer_authorization(&state, "did:plc:faye", 1)
        .await
        .unwrap();
    ensure_viewer_authorization(&state, "did:plc:faye", 2)
        .await
        .unwrap();

    assert_eq!(authority.0.load(Ordering::SeqCst), 1);
    assert!(lifecycle.has_current_viewer_authorization("did:plc:faye", 2));
}

struct StaticResolver(String);

#[async_trait]
impl IdentityKeyResolver for StaticResolver {
    async fn resolve_atproto_key(
        &self,
        _did: &str,
        _force_refresh: bool,
    ) -> Result<String, IdentityResolutionError> {
        Ok(self.0.clone())
    }
}

fn did_key(key: &SigningKey) -> String {
    let mut bytes = vec![0x80, 0x24];
    bytes.extend_from_slice(key.verifying_key().to_encoded_point(true).as_bytes());
    format!("did:key:z{}", bs58::encode(bytes).into_string())
}

fn jwt(key: &SigningKey, expires_at: u64) -> String {
    jwt_for(key, expires_at, "zone.stratos.feedgen.getFeed")
}

fn jwt_for(key: &SigningKey, expires_at: u64, method: &str) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&serde_json::json!({
            "iss": "did:plc:faye",
            "aud": "did:web:feedgen.example.test",
            "exp": expires_at,
            "lxm": method,
        }))
        .unwrap(),
    );
    let signed = format!("{header}.{claims}");
    let signature: p256::ecdsa::Signature = key.sign(signed.as_bytes());
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

fn authenticated_router(key: &SigningKey) -> axum::Router {
    authenticated_router_with_request_limit(
        key,
        super::MAX_CONCURRENT_FEED_REQUESTS,
        None,
        None,
        Vec::new(),
    )
}

fn authenticated_router_with_request_limit(
    key: &SigningKey,
    request_limit: usize,
    pds_space_sync: Option<Arc<Mutex<crate::pds_space_scheduler::PdsSpaceSyncStatus>>>,
    blobs: Option<Arc<BlobService>>,
    posts: Vec<ProjectionPost>,
) -> axum::Router {
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    let mut store = EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap();
    if !posts.is_empty() {
        store
            .apply_actor_page(ActorPage {
                authority_did: "did:web:stratos.example.test".to_owned(),
                actor_did: "did:plc:spike".to_owned(),
                sequence: 1,
                upserts: posts,
                deletes: Vec::new(),
                updated_at: "1998-04-03T00:00:02.000Z".to_owned(),
            })
            .unwrap();
    }
    let lifecycle = Arc::new(ControlLifecycle::new(
        ProjectionReader::new(store),
        Arc::clone(&readiness),
    ));
    lifecycle
        .apply_viewer_authorization(
            crate::authorization::ViewerAuthorization {
                did: "did:plc:faye".to_owned(),
                boundaries: vec!["bebop".to_owned()],
                expires_at: u64::MAX,
            },
            1,
        )
        .unwrap();
    lifecycle.session_established();
    let generation = lifecycle.begin_reconciliation();
    assert!(lifecycle.complete_reconciliation(
        generation,
        crate::readiness::ReconciliationOutcome {
            errors: 0,
            truncated: false,
        },
    ));
    let resolver: Arc<dyn IdentityKeyResolver> = Arc::new(StaticResolver(did_key(key)));
    let verifier = FeedRequestVerifier::new(
        "did:web:feedgen.example.test",
        [
            "zone.stratos.feedgen.getFeed".to_owned(),
            "zone.stratos.feedgen.getBlob".to_owned(),
        ],
        resolver,
    );
    router_with_feed_with_request_limit(
        ServerState {
            config: config(),
            feeds: feeds(),
            readiness,
            pds_space_sync,
        },
        lifecycle,
        verifier,
        request_limit,
        blobs,
        None,
    )
}

struct StaticBlobUpstream(Vec<u8>);

#[async_trait]
impl BlobUpstream for StaticBlobUpstream {
    async fn get(&self, _did: &str, _cid: &str, _now: u64) -> Result<Vec<u8>, BlobUpstreamError> {
        Ok(self.0.clone())
    }
}

fn blob_cid(bytes: &[u8]) -> String {
    Cid::new_v1(
        0x55,
        multihash::Multihash::<64>::wrap(0x12, &Sha256::digest(bytes)).unwrap(),
    )
    .to_string()
}

fn blob_post(cid: &str) -> ProjectionPost {
    ProjectionPost {
        uri: "at://did:plc:spike/zone.stratos.feed.post/see-you".to_owned(),
        author_did: "did:plc:spike".to_owned(),
        cid: "bafyrecord".to_owned(),
        sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
        indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
        retained_at: "2998-04-04T00:00:00.000Z".to_owned(),
        record_json: b"{}".to_vec(),
        blob_refs_json: serde_json::to_vec(&serde_json::json!([
            { "cid": cid, "mimeType": "image/png" }
        ]))
        .unwrap(),
        boundaries: vec!["bebop".to_owned()],
    }
}

fn feed_post(index: usize) -> ProjectionPost {
    ProjectionPost {
        uri: format!("at://did:plc:spike/zone.stratos.feed.post/{index}"),
        author_did: "did:plc:spike".to_owned(),
        cid: format!("bafyrecord{index}"),
        sort_at: format!("1998-04-03T00:00:{:02}.000Z", index % 60),
        indexed_at: "1998-04-03T00:01:00.000Z".to_owned(),
        retained_at: "2998-04-04T00:00:00.000Z".to_owned(),
        record_json: b"{}".to_vec(),
        blob_refs_json: b"[]".to_vec(),
        boundaries: vec!["bebop".to_owned()],
    }
}

#[tokio::test]
async fn health_starts_unavailable() {
    let app = router(
        config(),
        feeds(),
        Arc::new(Mutex::new(FeedReadinessGate::default())),
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 503);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        body,
        r#"{"ok":false,"feedReady":false,"version":"0.1.0","serviceStreamConnected":false,"actorPoolSize":0}"#
    );
}

#[tokio::test]
async fn health_reports_an_established_authoritative_session() {
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    readiness.lock().unwrap().mark_session_established();
    let app = router(config(), feeds(), readiness);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        body,
        r#"{"ok":false,"feedReady":false,"version":"0.1.0","serviceStreamConnected":true,"actorPoolSize":0}"#
    );
}

#[tokio::test]
async fn health_exposes_a_pds_sync_that_has_not_completed() {
    let key = SigningKey::from_bytes((&[9_u8; 32]).into()).unwrap();
    let app = authenticated_router_with_request_limit(
        &key,
        super::MAX_CONCURRENT_FEED_REQUESTS,
        Some(Arc::new(Mutex::new(
            crate::pds_space_scheduler::PdsSpaceSyncStatus::default(),
        ))),
        None,
        Vec::new(),
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["pdsSpaceSyncHealthy"], false);
    assert!(value.get("pdsSpaceSyncLastPass").is_none());
}

#[tokio::test]
async fn serves_a_did_document_matching_the_typescript_contract() {
    let app = router(
        config(),
        feeds(),
        Arc::new(Mutex::new(FeedReadinessGate::default())),
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/.well-known/did.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["id"], "did:web:feedgen.example.test");
    assert_eq!(
        json["verificationMethod"][0]["id"],
        "did:web:feedgen.example.test#atproto"
    );
    assert_eq!(
        json["service"][0]["serviceEndpoint"],
        "https://feedgen.example.test"
    );
}

#[tokio::test]
async fn describes_the_configured_catalogue() {
    let app = router(
        config(),
        feeds(),
        Arc::new(Mutex::new(FeedReadinessGate::default())),
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/xrpc/zone.stratos.feedgen.describeFeed")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        body,
        r#"{"did":"did:web:feedgen.example.test","feeds":[{"id":"bebop","boundary":"bebop","displayName":"Bebop"}]}"#
    );
}

#[tokio::test]
async fn serves_an_authenticated_current_viewer_with_private_no_store_headers() {
    let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let app = authenticated_router(&key);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/xrpc/zone.stratos.feedgen.getFeed?feed=bebop")
                .header("authorization", format!("Bearer {}", jwt(&key, expires_at)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK, "{response:?}");
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    assert_eq!(response.headers()["vary"], "Authorization");
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body, r#"{"feed":[]}"#);
}

#[tokio::test]
async fn serves_an_authorized_cid_verified_blob_with_private_headers() {
    let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
    let bytes = b"the real folk blues".to_vec();
    let cid = blob_cid(&bytes);
    let blobs = Arc::new(
        BlobService::new(
            Arc::new(Mutex::new(
                BlobCache::new(1024, Duration::from_secs(60)).unwrap(),
            )),
            Arc::new(StaticBlobUpstream(bytes.clone())),
            1,
        )
        .unwrap(),
    );
    let app = authenticated_router_with_request_limit(
        &key,
        super::MAX_CONCURRENT_FEED_REQUESTS,
        None,
        Some(blobs),
        vec![blob_post(&cid)],
    );
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let query = serde_urlencoded::to_string([
        ("uri", "at://did:plc:spike/zone.stratos.feed.post/see-you"),
        ("cid", cid.as_str()),
    ])
    .unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/xrpc/zone.stratos.feedgen.getBlob?{query}"))
                .header(
                    "authorization",
                    format!(
                        "Bearer {}",
                        jwt_for(&key, expires_at, "zone.stratos.feedgen.getBlob")
                    ),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    assert_eq!(response.headers()["vary"], "Authorization");
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.headers()["content-disposition"], "attachment");
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        bytes
    );
}

#[test]
fn preserves_only_the_legacy_safe_blob_media_types() {
    assert_eq!(
        blob_mime(
            br#"[{"cid":"bafyblob","mimeType":"audio/ogg"}]"#,
            "bafyblob"
        ),
        Some("audio/ogg")
    );
    assert_eq!(
        blob_mime(
            br#"[{"cid":"bafyblob","mimeType":"text/html"}]"#,
            "bafyblob"
        ),
        Some("application/octet-stream")
    );
}

#[tokio::test]
async fn rejects_missing_authentication_without_releasing_a_feed() {
    let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
    let response = authenticated_router(&key)
        .oneshot(
            Request::builder()
                .uri("/xrpc/zone.stratos.feedgen.getFeed?feed=bebop")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    assert_eq!(response.headers()["vary"], "Authorization");
}

#[tokio::test]
async fn preserves_the_boundary_mismatch_xrpc_contract() {
    let response = feed_error(crate::feed_service::FeedServiceError::BoundaryMismatch);

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        body,
        r#"{"error":"BoundaryMismatch","message":"viewer is not authorized for the configured feed"}"#
    );
}

#[tokio::test]
async fn refuses_feed_work_before_resolving_a_viewer_when_all_request_permits_are_reserved() {
    let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
    let lifecycle = Arc::new(ControlLifecycle::new(
        ProjectionReader::new(
            EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
        ),
        Arc::clone(&readiness),
    ));
    lifecycle.session_established();
    let generation = lifecycle.begin_reconciliation();
    assert!(lifecycle.complete_reconciliation(
        generation,
        crate::readiness::ReconciliationOutcome {
            errors: 0,
            truncated: false,
        },
    ));
    let resolver: Arc<dyn IdentityKeyResolver> = Arc::new(StaticResolver(did_key(&key)));
    let app = router_with_feed_with_request_limit(
        ServerState {
            config: config(),
            feeds: feeds(),
            readiness,
            pds_space_sync: None,
        },
        lifecycle,
        FeedRequestVerifier::new(
            "did:web:feedgen.example.test",
            ["zone.stratos.feedgen.getFeed".to_owned()],
            resolver,
        ),
        0,
        None,
        Some(Arc::new(PanicAuthority)),
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/xrpc/zone.stratos.feedgen.getFeed?feed=bebop")
                .header("authorization", format!("Bearer {}", jwt(&key, expires_at)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
}

#[tokio::test]
async fn rejects_out_of_range_limits_with_a_private_response() {
    let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let response = authenticated_router(&key)
        .oneshot(
            Request::builder()
                .uri("/xrpc/zone.stratos.feedgen.getFeed?feed=bebop&limit=101")
                .header("authorization", format!("Bearer {}", jwt(&key, expires_at)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
}

#[tokio::test]
async fn follows_the_shared_feed_limit_fixture() {
    let fixture: FeedLimitFixture = serde_json::from_str(include_str!(
        "../../../stratos-feedgen/testdata/conformance/v1/feed-limits.json"
    ))
    .unwrap();
    assert_eq!(fixture.version, 1);
    let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;

    for case in fixture.cases {
        let mut uri = "/xrpc/zone.stratos.feedgen.getFeed?feed=bebop".to_owned();
        if let Some(limit) = case.limit {
            uri.push_str(&format!("&limit={limit}"));
        }
        let posts = (1..=101).map(feed_post).collect();
        let response = authenticated_router_with_request_limit(
            &key,
            super::MAX_CONCURRENT_FEED_REQUESTS,
            None,
            None,
            posts,
        )
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("authorization", format!("Bearer {}", jwt(&key, expires_at)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(
            response.status().as_u16(),
            case.expected_status,
            "{}",
            case.name
        );
        assert_eq!(
            response.headers()["cache-control"],
            "private, no-store",
            "{}",
            case.name
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        if let Some(expected_error) = case.expected_error {
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["error"], expected_error, "{}", case.name);
        }
        if let Some(expected_limit) = case.expected_applied_limit {
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                body["feed"].as_array().unwrap().len(),
                expected_limit as usize,
                "{}",
                case.name
            );
        }
    }
}

#[tokio::test]
async fn rejects_an_oversized_cursor_before_cursor_decoding() {
    let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let cursor = "a".repeat(super::MAX_CURSOR_BYTES + 1);
    let response = authenticated_router(&key)
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/xrpc/zone.stratos.feedgen.getFeed?feed=bebop&cursor={cursor}"
                ))
                .header("authorization", format!("Bearer {}", jwt(&key, expires_at)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
}
