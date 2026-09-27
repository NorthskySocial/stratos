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
    authority::AuthorityClient,
    blob_service::{BlobService, BlobServiceError},
    config::FeedgenConfig,
    feed_service::{FeedQuery, FeedServiceError},
    feeds::{FeedDescription, FeedRegistry},
    lifecycle::ControlLifecycle,
    pds_space_scheduler::{PdsSpacePass, PdsSpaceSyncStatus},
    readiness::FeedReadinessGate,
    telemetry::FeedTelemetry,
};

mod authorization;
mod blob;
mod feed;
mod identity;
mod response;

use authorization::ensure_viewer_authorization;
#[cfg(test)]
use blob::blob_mime;
use blob::get_blob;
use feed::{feed_error, get_feed};
use identity::{
    describe_feed, did_document, feed_describe_feed, feed_did_document, feed_health, health,
};
use response::{current_timestamp, private_bytes, private_json, xrpc_error};

pub(super) struct ServerState {
    pub(super) config: FeedgenConfig,
    pub(super) feeds: FeedRegistry,
    pub(super) readiness: Arc<Mutex<FeedReadinessGate>>,
    pub(super) pds_space_sync: Option<Arc<Mutex<PdsSpaceSyncStatus>>>,
}

pub type RuntimeVerifier = FeedRequestVerifier<Arc<dyn IdentityKeyResolver>>;

pub struct FeedRuntime {
    pub lifecycle: Arc<ControlLifecycle>,
    pub verifier: RuntimeVerifier,
    pub authority: Arc<dyn AuthorityClient>,
    pub pds_space_sync: Arc<Mutex<PdsSpaceSyncStatus>>,
    pub blobs: Arc<BlobService>,
    pub telemetry: Arc<FeedTelemetry>,
}

const MAX_FEED_ID_BYTES: usize = 256;
const MAX_CURSOR_BYTES: usize = 4 * 1024;
const MAX_GET_FEED_QUERY_BYTES: usize = 8 * 1024;
const MAX_CONCURRENT_FEED_REQUESTS: usize = 4;
const FEED_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const BOUNDARY_AUTHORIZATION_TTL_SECONDS: u64 = 300;

pub(super) struct FeedServerState {
    pub(super) server: Arc<ServerState>,
    pub(super) lifecycle: Arc<ControlLifecycle>,
    pub(super) verifier: RuntimeVerifier,
    pub(super) request_permits: Arc<Semaphore>,
    pub(super) blobs: Option<Arc<BlobService>>,
    pub(super) authority: Option<Arc<dyn AuthorityClient>>,
    pub(super) telemetry: Arc<FeedTelemetry>,
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
    router_with_feed_with_request_limit(
        ServerState {
            config,
            feeds,
            readiness,
            pds_space_sync: None,
        },
        lifecycle,
        verifier,
        MAX_CONCURRENT_FEED_REQUESTS,
        None,
        None,
        Arc::new(FeedTelemetry::disabled()),
    )
}

pub fn router_with_feed_with_pds_space_sync(
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
    runtime: FeedRuntime,
) -> Router {
    router_with_feed_with_request_limit(
        ServerState {
            config,
            feeds,
            readiness,
            pds_space_sync: Some(runtime.pds_space_sync),
        },
        runtime.lifecycle,
        runtime.verifier,
        MAX_CONCURRENT_FEED_REQUESTS,
        Some(runtime.blobs),
        Some(runtime.authority),
        runtime.telemetry,
    )
}

fn router_with_feed_with_request_limit(
    server: ServerState,
    lifecycle: Arc<ControlLifecycle>,
    verifier: RuntimeVerifier,
    request_limit: usize,
    blobs: Option<Arc<BlobService>>,
    authority: Option<Arc<dyn AuthorityClient>>,
    telemetry: Arc<FeedTelemetry>,
) -> Router {
    let server = Arc::new(server);
    let state = feed_server_state(
        server,
        lifecycle,
        verifier,
        request_limit,
        blobs,
        authority,
        telemetry,
    );
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
    authority: Option<Arc<dyn AuthorityClient>>,
    telemetry: Arc<FeedTelemetry>,
) -> Arc<FeedServerState> {
    Arc::new(FeedServerState {
        server,
        lifecycle,
        verifier,
        request_permits: Arc::new(Semaphore::new(request_limit)),
        blobs,
        authority,
        telemetry,
    })
}

#[cfg(test)]
mod tests;
