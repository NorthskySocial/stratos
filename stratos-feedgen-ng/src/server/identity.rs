use super::*;

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
pub(super) struct DidDocument {
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
pub(super) struct DescribeFeedResponse {
    did: String,
    feeds: Vec<FeedDescription>,
}

pub(super) async fn health(State(state): State<Arc<ServerState>>) -> impl IntoResponse {
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

pub(super) async fn did_document(State(state): State<Arc<ServerState>>) -> Json<DidDocument> {
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

pub(super) async fn describe_feed(
    State(state): State<Arc<ServerState>>,
) -> Json<DescribeFeedResponse> {
    Json(DescribeFeedResponse {
        did: state.config.service_did.clone(),
        feeds: state.feeds.list().cloned().collect(),
    })
}

pub(super) async fn feed_health(State(state): State<Arc<FeedServerState>>) -> impl IntoResponse {
    health(State(Arc::clone(&state.server))).await
}

pub(super) async fn feed_did_document(
    State(state): State<Arc<FeedServerState>>,
) -> Json<DidDocument> {
    did_document(State(Arc::clone(&state.server))).await
}

pub(super) async fn feed_describe_feed(
    State(state): State<Arc<FeedServerState>>,
) -> Json<DescribeFeedResponse> {
    describe_feed(State(Arc::clone(&state.server))).await
}
