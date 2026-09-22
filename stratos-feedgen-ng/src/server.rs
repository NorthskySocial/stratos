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
    blob_service::{BlobService, BlobServiceError},
    config::FeedgenConfig,
    feed_service::{FeedQuery, FeedServiceError},
    feeds::{FeedDescription, FeedRegistry},
    lifecycle::ControlLifecycle,
    pds_space_scheduler::{PdsSpacePass, PdsSpaceSyncStatus},
    readiness::FeedReadinessGate,
};

struct ServerState {
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    pds_space_sync: Option<Arc<Mutex<PdsSpaceSyncStatus>>>,
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
    blobs: Option<Arc<BlobService>>,
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
    #[serde(
        rename = "pdsSpaceSyncHealthy",
        skip_serializing_if = "Option::is_none"
    )]
    pds_space_sync_healthy: Option<bool>,
    #[serde(
        rename = "pdsSpaceSyncLastPass",
        skip_serializing_if = "Option::is_none"
    )]
    pds_space_sync_last_pass: Option<PdsSpacePass>,
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
        pds_space_sync: None,
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
    router_with_feed_with_sync_status(config, feeds, readiness, lifecycle, verifier, None, None)
}

pub fn router_with_feed_with_pds_space_sync(
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    pds_space_sync: Arc<Mutex<PdsSpaceSyncStatus>>,
    blobs: Arc<BlobService>,
) -> Router {
    router_with_feed_with_sync_status(
        config,
        feeds,
        readiness,
        lifecycle,
        verifier,
        Some(pds_space_sync),
        Some(blobs),
    )
}

fn router_with_feed_with_sync_status(
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    pds_space_sync: Option<Arc<Mutex<PdsSpaceSyncStatus>>>,
    blobs: Option<Arc<BlobService>>,
) -> Router {
    router_with_feed_with_request_limit(
        ServerState {
            config,
            feeds,
            readiness,
            pds_space_sync,
        },
        lifecycle,
        verifier,
        MAX_CONCURRENT_FEED_REQUESTS,
        blobs,
    )
}

fn router_with_feed_with_request_limit(
    server: ServerState,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    request_limit: usize,
    blobs: Option<Arc<BlobService>>,
) -> Router {
    let server = Arc::new(server);
    let state = feed_server_state(server, lifecycle, verifier, request_limit, blobs);
    Router::new()
        .route("/health", get(feed_health))
        .route("/.well-known/did.json", get(feed_did_document))
        .route(
            "/xrpc/zone.stratos.feedgen.describeFeed",
            get(feed_describe_feed),
        )
        .route("/xrpc/zone.stratos.feedgen.getFeed", get(get_feed))
        .route("/xrpc/zone.stratos.feedgen.getBlob", get(get_blob))
        .with_state(state)
}

fn feed_server_state(
    server: Arc<ServerState>,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    request_limit: usize,
    blobs: Option<Arc<BlobService>>,
) -> Arc<FeedServerState> {
    Arc::new(FeedServerState {
        server,
        lifecycle,
        verifier,
        request_permits: Arc::new(Semaphore::new(request_limit)),
        blobs,
    })
}

async fn health(State(state): State<Arc<ServerState>>) -> impl IntoResponse {
    let readiness = state.readiness.lock().expect("readiness lock poisoned");
    let ready = readiness.is_ready();
    let service_stream_connected = readiness.has_authoritative_session();
    let (pds_space_sync_healthy, pds_space_sync_last_pass) = state
        .pds_space_sync
        .as_ref()
        .map(|status| {
            let status = status.lock().expect("PDS space scheduler status poisoned");
            (Some(status.is_healthy()), status.last_pass())
        })
        .unwrap_or((None, None));
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
            service_stream_connected,
            actor_pool_size: 0,
            pds_space_sync_healthy,
            pds_space_sync_last_pass,
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

#[derive(Deserialize)]
struct GetBlobParameters {
    uri: String,
    cid: String,
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
                    blob_base_url: &server.config.public_url,
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

async fn get_blob(
    State(state): State<Arc<FeedServerState>>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Response {
    let Some(blobs) = &state.blobs else {
        return xrpc_error(StatusCode::NOT_FOUND, "BlobNotFound", "blob is unavailable");
    };
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
        Ok(Ok(value)) => value,
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
    let Some(query) = raw_query else {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "blob request parameters are invalid",
        );
    };
    if query.len() > MAX_GET_FEED_QUERY_BYTES {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "blob request parameters are invalid",
        );
    }
    let parameters: GetBlobParameters = match serde_urlencoded::from_str(&query) {
        Ok(value) => value,
        Err(_) => {
            return xrpc_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "blob request parameters are invalid",
            );
        }
    };
    if parameters.uri.len() > 2_048 || parameters.cid.len() > 256 {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "blob request parameters are invalid",
        );
    }
    let _permit = match Arc::clone(&state.request_permits).try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let as_of = current_timestamp();
    let lifecycle = Arc::clone(&state.lifecycle);
    let server = Arc::clone(&state.server);
    let viewer = verified.viewer_did;
    let uri = parameters.uri;
    let cid = parameters.cid;
    let prepared = match tokio::task::spawn_blocking(move || {
        lifecycle.prepare_viewer_blob(&viewer, &server.feeds, &uri, now, &as_of)
    })
    .await
    {
        Ok(Ok(Some(value))) => value,
        Ok(Ok(None)) => {
            return xrpc_error(
                StatusCode::BAD_REQUEST,
                "BlobNotFound",
                "blob is unavailable",
            );
        }
        _ => {
            return xrpc_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "FeedNotReady",
                "feed is unavailable",
            );
        }
    };
    let (token, post) = prepared;
    let mime = blob_mime(&post.blob_refs_json, &cid);
    if mime.is_none() {
        return xrpc_error(
            StatusCode::BAD_REQUEST,
            "BlobNotFound",
            "blob is unavailable",
        );
    }
    let bytes = match blobs.get(&post.author_did, &cid, now).await {
        Ok(bytes) => bytes,
        Err(error) => return blob_error(error),
    };
    if state.lifecycle.release_blob(token, (), now).is_none() {
        blobs.remove(&post.author_did, &cid);
        return xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "feed is unavailable",
        );
    }
    private_bytes(bytes.to_vec(), mime.unwrap_or("application/octet-stream"))
}

fn blob_mime(references: &[u8], cid: &str) -> Option<&'static str> {
    let values: Vec<serde_json::Value> = serde_json::from_slice(references).ok()?;
    let mime = values
        .iter()
        .find(|value| value.get("cid").and_then(serde_json::Value::as_str) == Some(cid))?
        .get("mimeType")
        .and_then(serde_json::Value::as_str);
    match mime {
        Some("image/jpeg") => Some("image/jpeg"),
        Some("image/png") => Some("image/png"),
        Some("image/gif") => Some("image/gif"),
        Some("image/webp") => Some("image/webp"),
        Some("image/avif") => Some("image/avif"),
        Some("video/mp4") => Some("video/mp4"),
        Some("video/webm") => Some("video/webm"),
        Some("audio/mpeg") => Some("audio/mpeg"),
        Some("audio/ogg") => Some("audio/ogg"),
        Some("audio/wav") => Some("audio/wav"),
        _ => Some("application/octet-stream"),
    }
}

fn blob_error(error: BlobServiceError) -> Response {
    match error {
        BlobServiceError::TooLarge => xrpc_error(
            StatusCode::BAD_REQUEST,
            "BlobTooLarge",
            "blob is unavailable",
        ),
        BlobServiceError::Busy => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "BlobBusy",
            "blob is unavailable",
        ),
        BlobServiceError::Unavailable => xrpc_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "FeedNotReady",
            "blob is unavailable",
        ),
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
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response
}

fn private_bytes(body: Vec<u8>, content_type: &'static str) -> Response {
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Authorization"));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    response.headers_mut().insert(
        "content-disposition",
        HeaderValue::from_static("attachment"),
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
    use std::{
        sync::{Arc, Mutex},
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

    use super::{ServerState, blob_mime, feed_error, router, router_with_feed_with_request_limit};

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
        )
    }

    struct StaticBlobUpstream(Vec<u8>);

    #[async_trait]
    impl BlobUpstream for StaticBlobUpstream {
        async fn get(
            &self,
            _did: &str,
            _cid: &str,
            _now: u64,
        ) -> Result<Vec<u8>, BlobUpstreamError> {
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
    async fn refuses_feed_work_when_all_request_permits_are_reserved() {
        let key = SigningKey::from_bytes((&[7_u8; 32]).into()).unwrap();
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 60;
        let response = authenticated_router_with_request_limit(&key, 0, None, None, Vec::new())
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
            "../../stratos-feedgen/testdata/conformance/v1/feed-limits.json"
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
}
