use std::sync::{Arc, Mutex};

use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use serde::Serialize;

use crate::{
    config::FeedgenConfig,
    feeds::{FeedDescription, FeedRegistry},
    readiness::FeedReadinessGate,
};

struct ServerState {
    config: FeedgenConfig,
    feeds: FeedRegistry,
    readiness: Arc<Mutex<FeedReadinessGate>>,
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use crate::{
        config::{FeedgenConfig, StorageProfile},
        feeds::{FeedDescription, FeedRegistry},
        readiness::FeedReadinessGate,
    };

    use super::router;

    fn config() -> FeedgenConfig {
        FeedgenConfig {
            service_did: "did:web:feedgen.example.test".to_string(),
            public_url: "https://feedgen.example.test".to_string(),
            public_key_multibase: "zTestKey".to_string(),
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
}
