use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::{RawQuery, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::{sync::Semaphore, time::timeout};

use crate::{
    auth::{FeedRequestVerifier, IdentityKeyResolver},
    config::FeedgenConfig,
    feed_service::{FeedQuery, FeedServiceError},
    feeds::{FeedDescription, FeedRegistry},
    lifecycle::ControlLifecycle,
    readiness::FeedReadinessGate,
};

struct ServerState {
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
}

pub type RuntimeVerifier = FeedRequestVerifier<Arc<dyn IdentityKeyResolver>>;

const MAX_FEED_ID_BYTES: usize = 256;
const MAX_CURSOR_BYTES: usize = 4 * 1024;
const MAX_GET_FEED_QUERY_BYTES: usize = 8 * 1024;
const MAX_CONCURRENT_FEED_REQUESTS: usize = 4;
const FEED_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

struct FeedServerState {
    server: Arc<ServerState>,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    request_permits: Arc<Semaphore>,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    #[serde(rename = "feedReady")]
    feed_ready: bool,
    version: &'static str,
    #[serde(rename = "serviceStreamConnected")]
    service_stream_connected: bool,
    #[serde(rename = "actorPoolSize")]
    actor_pool_size: u32,
}

#[derive(Serialize)]
struct DidDocument {
    #[serde(rename = "@context")]
    context: [&'static str; 2],
    id: String,
    #[serde(rename = "verificationMethod")]
    verification_method: [VerificationMethod; 1],
    service: [Service; 1],
}

#[derive(Serialize)]
struct VerificationMethod {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    controller: String,
    #[serde(rename = "publicKeyMultibase")]
    public_key_multibase: String,
}

#[derive(Serialize)]
struct Service {
    id: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "serviceEndpoint")]
    service_endpoint: String,
}

#[derive(Serialize)]
struct DescribeFeedResponse {
    did: String,
    feeds: Vec<FeedDescription>,
}

pub fn router(
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
) -> Router {
    let state = Arc::new(ServerState {
        config,
        feeds,
        readiness,
    });
    Router::new()
        .route("/health", get(health))
        .route("/.well-known/did.json", get(did_document))
        .route(
            "/xrpc/zone.stratos.feedgen.describeFeed",
            get(describe_feed),
        )
        .with_state(state)
}

pub fn router_with_feed(
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
) -> Router {
    router_with_feed_with_request_limit(
        config,
        feeds,
        readiness,
        lifecycle,
        verifier,
        MAX_CONCURRENT_FEED_REQUESTS,
    )
}

fn router_with_feed_with_request_limit(
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    request_limit: usize,
) -> Router {
    let server = Arc::new(ServerState {
        config,
        feeds,
        readiness,
    });
    let state = feed_server_state(server, lifecycle, verifier, request_limit);
    Router::new()
        .route("/health", get(feed_health))
        .route("/.well-known/did.json", get(feed_did_document))
        .route(
            "/xrpc/zone.stratos.feedgen.describeFeed",
            get(feed_describe_feed),
        )
        .route("/xrpc/zone.stratos.feedgen.getFeed", get(get_feed))
        .with_state(state)
}

fn feed_server_state(
    server: Arc<ServerState>,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    request_limit: usize,
) -> Arc<FeedServerState> {
    Arc::new(FeedServerState {
        server,
        lifecycle,
        verifier,
        request_permits: Arc::new(Semaphore::new(request_limit)),
    })
}

async fn health(State(state): State<Arc<ServerState>>) -> impl IntoResponse {
    let ready = state
        .readiness
        .lock()
        .expect("readiness lock poisoned")
        .is_ready();
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(HealthResponse {
            ok: ready,
            feed_ready: ready,
            version: env!("CARGO_PKG_VERSION"),
            service_stream_connected: false,
            actor_pool_size: 0,
        }),
    )
}

async fn did_document(State(state): State<Arc<ServerState>>) -> Json<DidDocument> {
    Json(DidDocument {
        context: [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/multikey/v1",
        ],
        id: state.config.service_did.clone(),
        verification_method: [VerificationMethod {
            id: format!("{}#atproto", state.config.service_did),
            kind: "Multikey",
            controller: state.config.service_did.clone(),
            public_key_multibase: state.config.public_key_multibase.clone(),
        }],
        service: [Service {
            id: "#stratos_feedgen",
            kind: "NorthskyStratosFeedGen",
            service_endpoint: state.config.public_url.clone(),
        }],
    })
}

async fn describe_feed(State(state): State<Arc<ServerState>>) -> Json<DescribeFeedResponse> {
    Json(DescribeFeedResponse {
        did: state.config.service_did.clone(),
        feeds: state.feeds.list().cloned().collect(),
    })
}

async fn feed_health(State(state): State<Arc<FeedServerState>>) -> impl IntoResponse {
    health(State(Arc::clone(&state.server))).await
}

async fn feed_did_document(State(state): State<Arc<FeedServerState>>) -> Json<DidDocument> {
    did_document(State(Arc::clone(&state.server))).await
}

async fn feed_describe_feed(
    State(state): State<Arc<FeedServerState>>,
) -> Json<DescribeFeedResponse> {
    describe_feed(State(Arc::clone(&state.server))).await
}

#[derive(Deserialize)]
struct GetFeedParameters {
    feed: String,
    cursor: Option<String>,
    limit: Option<u16>,
}

#[derive(Serialize)]
struct XrpcErrorResponse {
    error: &'static str,
    message: &'static str,
}

async fn get_feed(
    State(state): State<Arc<FeedServerState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Response {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let now = OffsetDateTime::now_utc().unix_timestamp().max(0) as u64;
    let verified = match timeout(
        FEED_REQUEST_TIMEOUT,
        state.verifier.verify_authorization(authorization, now),
    )
    .await
    {
        Ok(Ok(verified)) => verified,
        Ok(Err(error)) => {
            return xrpc_error(
                StatusCode::UNAUTHORIZED,
                error.code(),
                "authentication failed",
            );
        }
        Err(_) => {
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let Some(raw_query) = raw_query else {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    };
    if raw_query.len() > MAX_GET_FEED_QUERY_BYTES {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    }
    let parameters: GetFeedParameters = match serde_urlencoded::from_str(&raw_query) {
        Ok(parameters) => parameters,
        Err(_) => {
            return xrpc_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "feed request parameters are invalid",
            );
        }
    };
    if parameters.feed.len() > MAX_FEED_ID_BYTES
        || parameters
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > MAX_CURSOR_BYTES)
    {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "feed request parameters are invalid",
        );
    }
    let limit = parameters.limit.unwrap_or(50);
    if limit == 0 || limit > 100 {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "limit must be between 1 and 100",
        );
    }
    let as_of = current_timestamp();
    let permit = match Arc::clone(&state.request_permits).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let lifecycle = Arc::clone(&state.lifecycle);
    let server = Arc::clone(&state.server);
    let viewer_did = verified.viewer_did;
    let feed_id = parameters.feed;
    let cursor = parameters.cursor;
    let response = timeout(
        FEED_REQUEST_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            lifecycle.serve_viewer_feed(
                &viewer_did,
                &server.feeds,
                FeedQuery {
                    feed_id: &feed_id,
                    cursor: cursor.as_deref(),
                    limit,
                    now,
                    as_of: &as_of,
                },
            )
        }),
    )
    .await;
    match response {
        Ok(Ok(Ok(body))) => private_json(StatusCode::OK, body),
        Ok(Ok(Err(error))) => feed_error(error),
        Ok(Err(_)) => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
        Err(_) => {
            state.lifecycle.interrupt_feed_work();
            state.lifecycle.mark_unavailable();
            xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            )
        }
    }
}

fn feed_error(error: FeedServiceError) -> Response {
    match error {
        FeedServiceError::AuthorizationUnavailable => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
        FeedServiceError::BoundaryMismatch => xrpc_error(
            StatusCode::BAD_REQUEST,
            "BoundaryMismatch",
            "viewer is not authorized for the configured feed",
        ),
        FeedServiceError::UnknownFeed => xrpc_error(
            StatusCode::BAD_REQUEST,
            "UnknownFeed",
            "configured feed was not found",
        ),
        FeedServiceError::FeedNotReady => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
        FeedServiceError::InvalidProjection | FeedServiceError::Store(_) => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        ),
    }
}

fn xrpc_error(status: StatusCode, error: &'static str, message: &'static str) -> Response {
    let body = serde_json::to_vec(&XrpcErrorResponse { error, message })
        .expect("static XRPC error serializes");
    private_json(status, body)
}

fn private_json(status: StatusCode, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

fn current_timestamp() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use http_body_util::BodyExt;
    use p256::ecdsa::{SigningKey, signature::Signer};
    use tower::ServiceExt;

    use crate::{
        auth::{FeedRequestVerifier, IdentityKeyResolver, IdentityResolutionError},
        config::{FeedgenConfig, StorageProfile},
        feeds::{FeedDescription, FeedRegistry},
        lifecycle::ControlLifecycle,
        readiness::FeedReadinessGate,
        service::ProjectionReader,
        service_auth::ServiceSigningKey,
        store::{EncryptedStore, StorageKey},
    };

    use super::{feed_error, router, router_with_feed_with_request_limit};

    fn config() -> FeedgenConfig {
        FeedgenConfig {
            service_did: "did:web:feedgen.example.test".to_string(),
            public_url: "https://feedgen.example.test".to_string(),
            public_key_multibase: "zTestKey".to_string(),
            signing_key: ServiceSigningKey::from_hex(&"11".repeat(32)).unwrap(),
            plc_url: "https://plc.example.test".to_string(),
            storage: StorageProfile::Memory,
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
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&serde_json::json!({
                "iss": "did:plc:faye",
                "aud": "did:web:feedgen.example.test",
                "exp": expires_at,
                "lxm": "zone.stratos.feedgen.getFeed",
            }))
            .unwrap(),
        );
        let signed = format!("{header}.{claims}");
        let signature: p256::ecdsa::Signature = key.sign(signed.as_bytes());
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    fn authenticated_router(key: &SigningKey) -> axum::Router {
        authenticated_router_with_request_limit(key, super::MAX_CONCURRENT_FEED_REQUESTS)
    }

    fn authenticated_router_with_request_limit(
        key: &SigningKey,
        request_limit: usize,
    ) -> axum::Router {
        let readiness = Arc::new(Mutex::new(FeedReadinessGate::default()));
        let lifecycle = Arc::new(ControlLifecycle::new(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
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
            ["zone.stratos.feedgen.getFeed".to_owned()],
            resolver,
        );
        router_with_feed_with_request_limit(
            config(),
            feeds(),
            readiness,
            lifecycle,
            verifier,
            request_limit,
        )
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
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, r#"{"feed":[]}"#);
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
    async fn refuses_feed_work_when_all_request_permits_are_reserved() {
        let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 60;
        let response = authenticated_router_with_request_limit(&key, 0)
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
}
