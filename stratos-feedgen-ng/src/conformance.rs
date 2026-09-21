#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde::Deserialize;
    use tower::ServiceExt;

    use crate::{
        config::{FeedgenConfig, StorageProfile},
        feeds::FeedRegistry,
        readiness::{FeedReadinessGate, ReconciliationOutcome},
        server,
    };

    #[derive(Deserialize)]
    struct ReadinessFixture {
        version: u8,
        cases: Vec<ReadinessCase>,
    }

    #[derive(Deserialize)]
    struct ReadinessCase {
        name: String,
        events: Vec<ReadinessEvent>,
        expected_ready: bool,
    }

    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum ReadinessEvent {
        MarkUnavailable,
        MarkSessionEstablished,
        BeginReconciliation,
        CompleteReconciliation { errors: u32, truncated: bool },
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DidFixture {
        version: u8,
        input: DidInput,
        expected: serde_json::Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DidInput {
        service_did: String,
        public_url: String,
        public_key_multibase: String,
    }

    #[test]
    fn follows_the_shared_readiness_fixture() {
        let fixture: ReadinessFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/readiness.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);

        for case in fixture.cases {
            let mut gate = FeedReadinessGate::default();
            let mut generation = None;
            for event in case.events {
                match event {
                    ReadinessEvent::MarkUnavailable => gate.mark_unavailable(),
                    ReadinessEvent::MarkSessionEstablished => gate.mark_session_established(),
                    ReadinessEvent::BeginReconciliation => {
                        generation = Some(gate.begin_reconciliation());
                    }
                    ReadinessEvent::CompleteReconciliation { errors, truncated } => {
                        let generation = generation.expect("reconciliation must begin first");
                        gate.complete_reconciliation(
                            generation,
                            ReconciliationOutcome { errors, truncated },
                        );
                    }
                }
            }
            assert_eq!(gate.is_ready(), case.expected_ready, "{}", case.name);
        }
    }

    #[tokio::test]
    async fn keeps_the_discovery_contract_in_the_shared_fixture() {
        let fixture: DidFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/did-document.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);
        let app = server::router(
            FeedgenConfig {
                service_did: fixture.input.service_did,
                public_url: fixture.input.public_url,
                public_key_multibase: fixture.input.public_key_multibase,
                storage: StorageProfile::Memory,
            },
            FeedRegistry::new(Vec::new()).unwrap(),
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
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let actual: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(actual, fixture.expected);
    }
}
