#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde::Deserialize;
    use tower::ServiceExt;

    use crate::{
        config::{FeedgenConfig, StorageProfile},
        cursor::FeedCursor,
        feed_service::build_blob_url,
        feeds::FeedRegistry,
        identifier::RecordUri,
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

    #[derive(Deserialize)]
    struct CursorFixture {
        version: u8,
        cases: Vec<CursorCase>,
    }

    #[derive(Deserialize)]
    struct CursorCase {
        name: String,
        input: String,
        expected: Option<CursorValue>,
    }

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct CursorValue {
        sort_at: String,
        uri: String,
    }

    #[derive(Deserialize)]
    struct SpaceRecordFixture {
        version: u8,
        valid: Vec<ValidSpaceRecordCase>,
        invalid: Vec<InvalidSpaceRecordCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BlobUrlFixture {
        version: u8,
        cases: Vec<BlobUrlCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BlobUrlCase {
        name: String,
        base_url: String,
        uri: String,
        cid: String,
        expected_url: Option<String>,
    }

    #[derive(Deserialize)]
    struct ValidSpaceRecordCase {
        name: String,
        input: String,
        expected: SpaceRecordValue,
    }

    #[derive(Deserialize)]
    struct InvalidSpaceRecordCase {
        name: String,
        input: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SpaceRecordValue {
        space_did: String,
        space_type: String,
        skey: String,
        author_did: String,
        collection: String,
        rkey: String,
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

    #[test]
    fn follows_the_shared_cursor_fixture() {
        let fixture: CursorFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/cursor.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);

        for case in fixture.cases {
            let actual = FeedCursor::decode(&case.input).map(|cursor| CursorValue {
                sort_at: cursor.sort_at,
                uri: cursor.uri,
            });
            assert_eq!(actual, case.expected, "{}", case.name);
            if let Some(expected) = case.expected {
                assert_eq!(
                    FeedCursor {
                        sort_at: expected.sort_at,
                        uri: expected.uri,
                    }
                    .encode(),
                    case.input,
                    "{}",
                    case.name
                );
            }
        }
    }

    #[test]
    fn follows_the_shared_space_record_uri_fixture() {
        let fixture: SpaceRecordFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/space-record-uri.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);

        for case in fixture.valid {
            let uri = RecordUri::parse_space_record(&case.input)
                .unwrap_or_else(|_| panic!("{}", case.name));
            let RecordUri::Space {
                authority,
                space_type,
                space_key,
                author,
                collection,
                rkey,
            } = uri
            else {
                panic!("{}", case.name);
            };
            assert_eq!(authority.as_str(), case.expected.space_did, "{}", case.name);
            assert_eq!(space_type, case.expected.space_type, "{}", case.name);
            assert_eq!(space_key, case.expected.skey, "{}", case.name);
            assert_eq!(author.as_str(), case.expected.author_did, "{}", case.name);
            assert_eq!(collection, case.expected.collection, "{}", case.name);
            assert_eq!(rkey, case.expected.rkey, "{}", case.name);
        }
        for case in fixture.invalid {
            assert!(
                RecordUri::parse_space_record(&case.input).is_err(),
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn follows_the_shared_blob_url_fixture() {
        let fixture: BlobUrlFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/blob-url.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);

        for case in fixture.cases {
            let actual = match RecordUri::parse(&case.uri) {
                Ok(RecordUri::Repo { .. }) => {
                    build_blob_url(&case.base_url, &case.uri, &case.cid).ok()
                }
                _ => None,
            };
            assert_eq!(actual, case.expected_url, "{}", case.name);
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
                signing_key: crate::service_auth::ServiceSigningKey::from_hex(&"11".repeat(32))
                    .unwrap(),
                stratos_service_url: "https://stratos.example.test".to_owned(),
                stratos_public_url: "https://stratos.example.test".to_owned(),
                stratos_service_did: "did:web:stratos.example.test".to_owned(),
                plc_url: "https://plc.example.test".to_owned(),
                plc_private_cidrs: None,
                storage: StorageProfile::Memory,
                retention: crate::config::ProjectionRetention {
                    max_age: std::time::Duration::from_secs(60 * 60),
                    max_bytes: 16 * 1024 * 1024,
                },
                actor_max_connections: 8,
                metrics_export: crate::config::MetricsExportConfig {
                    otlp_http_endpoint: None,
                },
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
