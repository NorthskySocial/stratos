#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{body::Body, http::Request};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use http_body_util::BodyExt;
    use serde::Deserialize;
    use tower::ServiceExt;

    use crate::{
        actor_event::parse_actor_commit,
        config::{FeedgenConfig, StorageProfile},
        credential_manager::boundary_to_space_uri,
        cursor::FeedCursor,
        feed_service::build_blob_url,
        feeds::FeedRegistry,
        identifier::{Did, FEED_SPACE_TYPE, RecordUri, SpaceUri},
        moderation_label::{LabelSubject, parse_label_page},
        readiness::{FeedReadinessGate, ReconciliationOutcome},
        server,
        store::{InteractionKind, ProjectionInteraction},
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
    #[serde(rename_all = "camelCase")]
    struct ModerationLabelFixture {
        version: u8,
        service_in_tokyo3: serde_json::Value,
        moderation_service: serde_json::Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SpaceUriCorpus {
        spaces: Vec<CorpusSpace>,
        records: Vec<CorpusSpaceRecord>,
        repo_records: Vec<CorpusRepoRecord>,
        boundaries: Vec<CorpusBoundary>,
        invalid: Vec<CorpusInvalid>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CorpusSpace {
        name: String,
        uri: String,
        authority: String,
        space_type: String,
        skey: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CorpusSpaceRecord {
        name: String,
        uri: String,
        authority: String,
        space_type: String,
        skey: String,
        author: String,
        collection: String,
        rkey: String,
    }

    #[derive(Deserialize)]
    struct CorpusRepoRecord {
        name: String,
        uri: String,
        author: String,
        collection: String,
        rkey: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CorpusBoundary {
        name: String,
        boundary: String,
        space_type: String,
        uri: String,
    }

    #[derive(Deserialize)]
    struct CorpusInvalid {
        name: String,
        input: String,
        #[serde(rename = "as")]
        refused_as: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BlobUrlSpaceRecordFixture {
        cases: Vec<BlobUrlSpaceRecordCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BlobUrlSpaceRecordCase {
        name: String,
        base_url: String,
        uri: String,
        blob_ref: String,
        expected_url: Option<String>,
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

    #[test]
    fn follows_the_shared_readiness_fixture() {
        let fixture: ReadinessFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/readiness.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);

        for case in fixture.cases {
            let mut gate = FeedReadinessGate::default();
            gate.mark_labels_current();
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
    fn follows_the_space_uri_corpus() {
        let corpus: SpaceUriCorpus = serde_json::from_str(include_str!(
            "../../test/spaces-alignment/november/fixtures/space-uri-conformance.json"
        ))
        .unwrap();

        for case in corpus.spaces {
            let space = SpaceUri::parse(&case.uri).unwrap_or_else(|_| panic!("{}", case.name));
            assert_eq!(space.authority().as_str(), case.authority, "{}", case.name);
            assert_eq!(space.space_type(), case.space_type, "{}", case.name);
            assert_eq!(space.space_key(), case.skey, "{}", case.name);
            assert_eq!(space.to_string(), case.uri, "{}", case.name);
            assert!(RecordUri::parse(&case.uri).is_err(), "{}", case.name);
        }
        for case in corpus.records {
            let uri = RecordUri::parse_space_record(&case.uri)
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
            assert_eq!(authority.as_str(), case.authority, "{}", case.name);
            assert_eq!(space_type, case.space_type, "{}", case.name);
            assert_eq!(space_key, case.skey, "{}", case.name);
            assert_eq!(author.as_str(), case.author, "{}", case.name);
            assert_eq!(collection, case.collection, "{}", case.name);
            assert_eq!(rkey, case.rkey, "{}", case.name);
            let space = SpaceUri::parse(&format!(
                "at:space/{}/{}/{}",
                case.authority, case.space_type, case.skey
            ))
            .unwrap();
            let author = Did::parse(case.author.as_str()).unwrap();
            assert_eq!(
                space.record_uri(&author, &case.collection, &case.rkey),
                case.uri,
                "{}",
                case.name
            );
            assert!(SpaceUri::parse(&case.uri).is_err(), "{}", case.name);
        }
        for case in corpus.repo_records {
            let Ok(RecordUri::Repo {
                author,
                collection,
                rkey,
            }) = RecordUri::parse(&case.uri)
            else {
                panic!("{}", case.name);
            };
            assert_eq!(author.as_str(), case.author, "{}", case.name);
            assert_eq!(collection, case.collection, "{}", case.name);
            assert_eq!(rkey, case.rkey, "{}", case.name);
            assert!(
                RecordUri::parse_space_record(&case.uri).is_err(),
                "{}",
                case.name
            );
        }
        for case in corpus.invalid {
            let refused_as_space = SpaceUri::parse(&case.input).is_err();
            let refused_as_record = RecordUri::parse_space_record(&case.input).is_err();
            match case.refused_as.as_str() {
                "space" => assert!(refused_as_space, "{}", case.name),
                "record" => assert!(refused_as_record, "{}", case.name),
                "both" => assert!(refused_as_space && refused_as_record, "{}", case.name),
                other => panic!("{}: unknown refusal {other}", case.name),
            }
        }
        for case in corpus.boundaries {
            let expected = SpaceUri::parse(&case.uri).unwrap_or_else(|_| panic!("{}", case.name));
            assert_eq!(expected.space_type(), case.space_type, "{}", case.name);
            assert_eq!(expected.to_string(), case.uri, "{}", case.name);
            let produced = boundary_to_space_uri(&case.boundary).unwrap();
            if case.space_type == FEED_SPACE_TYPE {
                assert_eq!(produced, case.uri, "{}", case.name);
            } else {
                assert_ne!(produced, case.uri, "{}", case.name);
            }
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

    #[test]
    fn never_projects_the_blob_of_a_space_record_in_the_current_spelling() {
        let fixture: BlobUrlSpaceRecordFixture = serde_json::from_str(include_str!(
            "../../test/spaces-alignment/november/fixtures/blob-url-space-record.json"
        ))
        .unwrap();
        assert!(!fixture.cases.is_empty());

        for case in fixture.cases {
            assert!(
                RecordUri::parse_space_record(&case.uri).is_ok(),
                "{}",
                case.name
            );
            let actual = match RecordUri::parse(&case.uri) {
                Ok(RecordUri::Repo { .. }) => {
                    build_blob_url(&case.base_url, &case.uri, &case.blob_ref).ok()
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
                    stage_budget: crate::config::SpaceStageBudget::for_projection(16 * 1024 * 1024)
                        .unwrap(),
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

    #[test]
    fn reads_the_label_pages_stratos_serves_in_the_shared_fixture() {
        const REI_POST: &str = "at://did:plc:rei-ayanami/zone.stratos.feed.post/eva-00";
        const ASUKA_SPACE_POST: &str = "at:space/did:web:stratos.test/zone.stratos.space.feed/tokyo-3/did:plc:asuka/zone.stratos.feed.post/eva-02";
        const GEOFRONT_POST: &str = "at://did:plc:shinji-ikari/zone.stratos.feed.post/eva-01";
        let fixture: ModerationLabelFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/moderation-labels.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);
        let record = |uri: &str, author: &str| LabelSubject::Record {
            uri: uri.to_owned(),
            author_did: author.to_owned(),
        };
        let asuka = LabelSubject::Account {
            did: "did:plc:asuka".to_owned(),
        };
        let subjects_of = |page: &serde_json::Value| {
            let parsed = parse_label_page(&serde_json::to_vec(page).unwrap(), 0, 100).unwrap();
            assert_eq!(parsed.cursor, 4);
            parsed
                .labels
                .into_iter()
                .map(|label| label.subject)
                .collect::<Vec<_>>()
        };

        let scoped = subjects_of(&fixture.service_in_tokyo3);
        let full = subjects_of(&fixture.moderation_service);

        assert_eq!(
            scoped,
            [
                record(REI_POST, "did:plc:rei-ayanami"),
                record(ASUKA_SPACE_POST, "did:plc:asuka"),
                asuka.clone(),
            ]
        );
        assert!(!scoped.iter().any(|subject| matches!(
            subject,
            LabelSubject::Record { uri, .. } if uri == GEOFRONT_POST
        )));
        assert_eq!(
            full,
            [
                record(REI_POST, "did:plc:rei-ayanami"),
                record(ASUKA_SPACE_POST, "did:plc:asuka"),
                record(GEOFRONT_POST, "did:plc:shinji-ikari"),
                asuka,
            ]
        );
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ActorFrameFixture {
        version: u8,
        cases: Vec<ActorFrameCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ActorFrameCase {
        name: String,
        service_did: String,
        actor_did: String,
        authorized_boundaries: Vec<String>,
        frame_base64: String,
        expected: ActorFrameExpectation,
    }

    #[derive(Deserialize)]
    struct ActorFrameExpectation {
        upserts: Vec<ExpectedUpsert>,
        deletes: Vec<String>,
    }

    #[derive(Deserialize)]
    struct ExpectedUpsert {
        uri: String,
        boundaries: Vec<String>,
    }

    #[test]
    fn parses_the_actor_commit_frames_stratos_sends_in_the_shared_fixture() {
        let fixture: ActorFrameFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/actor-commit-frames.json"
        ))
        .unwrap();
        assert_eq!(fixture.version, 1);
        assert!(!fixture.cases.is_empty());

        let mut parsed = Vec::new();
        let mut expected = Vec::new();
        for case in fixture.cases {
            let frame = STANDARD.decode(&case.frame_base64).unwrap();
            let authorized = case.authorized_boundaries.into_iter().collect();
            let page = parse_actor_commit(
                &frame,
                &case.service_did,
                &case.actor_did,
                &authorized,
                "1998-05-03T00:00:00.000Z",
            )
            .unwrap_or_else(|_| panic!("case {} did not parse", case.name))
            .unwrap_or_else(|| panic!("case {} was not a commit", case.name));

            let upserts = page
                .upserts
                .into_iter()
                .map(|post| (post.uri, post.boundaries))
                .collect::<Vec<_>>();
            parsed.push((case.name.clone(), upserts, page.deletes));
            let expected_upserts = case
                .expected
                .upserts
                .into_iter()
                .map(|upsert| (upsert.uri, upsert.boundaries))
                .collect::<Vec<_>>();
            expected.push((case.name, expected_upserts, case.expected.deletes));
        }
        assert_eq!(parsed, expected);

        let boundary_create = parsed
            .iter()
            .find(|(name, _, _)| name.contains("boundary create procedure"))
            .expect("the shared fixture lacks the boundary create case");
        assert_eq!(
            boundary_create.1,
            [(
                "at://did:plc:misato-katsuragi/zone.stratos.feed.post/gaghiel".to_string(),
                vec!["did:web:nerv.tokyo.jp/geofront".to_string()],
            )]
        );
        assert!(boundary_create.2.is_empty());
    }

    fn frame_sequence(frame: &[u8]) -> u64 {
        let mut deserializer = serde_cbor::de::Deserializer::from_slice(frame);
        let _header = serde_cbor::Value::deserialize(&mut deserializer).unwrap();
        let body = serde_cbor::Value::deserialize(&mut deserializer).unwrap();
        let serde_cbor::Value::Map(fields) = body else {
            panic!("the commit body is not a map");
        };
        let sequence = fields
            .get(&serde_cbor::Value::Text("seq".to_string()))
            .expect("the commit carries no seq");
        match sequence {
            serde_cbor::Value::Integer(value) => u64::try_from(*value).unwrap(),
            _ => panic!("the commit seq is not an integer"),
        }
    }

    fn expected_interaction_changes(case_name: &str) -> (Vec<ProjectionInteraction>, Vec<String>) {
        const SUBJECT: &str = "at://did:plc:misato-katsuragi/zone.stratos.feed.post/gaghiel";
        let interaction =
            |kind, collection: &str, rkey: &str, indexed_at: &str| ProjectionInteraction {
                uri: format!("at://did:plc:misato-katsuragi/{collection}/{rkey}"),
                actor_did: "did:plc:misato-katsuragi".to_owned(),
                kind,
                subject_uri: SUBJECT.to_owned(),
                boundary: "did:web:nerv.tokyo.jp/geofront".to_owned(),
                indexed_at: indexed_at.to_owned(),
                retained_at: "1998-05-03T00:00:00.000Z".to_owned(),
            };
        match case_name {
            "a like of a post, written through the generic write procedures" => (
                vec![interaction(
                    InteractionKind::Like,
                    "app.bsky.feed.like",
                    "rei-like",
                    "2026-11-18T11:34:29.831Z",
                )],
                Vec::new(),
            ),
            "a repost of a post, written through the generic write procedures" => (
                vec![interaction(
                    InteractionKind::Repost,
                    "app.bsky.feed.repost",
                    "asuka-repost",
                    "2026-11-18T11:34:29.836Z",
                )],
                Vec::new(),
            ),
            "a delete of the like" => (
                Vec::new(),
                vec!["at://did:plc:misato-katsuragi/app.bsky.feed.like/rei-like".to_owned()],
            ),
            other => panic!("no interaction expectation for case {other}"),
        }
    }

    #[test]
    fn reads_no_post_change_in_the_like_and_repost_frames_stratos_sends() {
        let fixture: ActorFrameFixture = serde_json::from_str(include_str!(
            "../../stratos-feedgen/testdata/conformance/v1/actor-commit-frames.json"
        ))
        .unwrap();

        let mut interactions = Vec::new();
        for case in fixture.cases {
            if !case.name.contains("like") && !case.name.contains("repost") {
                continue;
            }
            let frame = STANDARD.decode(&case.frame_base64).unwrap();
            let authorized = case.authorized_boundaries.into_iter().collect();
            let page = parse_actor_commit(
                &frame,
                &case.service_did,
                &case.actor_did,
                &authorized,
                "1998-05-03T00:00:00.000Z",
            )
            .unwrap_or_else(|_| panic!("case {} did not parse", case.name))
            .unwrap_or_else(|| panic!("case {} was not a commit", case.name));

            assert!(page.upserts.is_empty(), "case {} upserted", case.name);
            assert!(page.deletes.is_empty(), "case {} deleted", case.name);
            assert_eq!(page.sequence, frame_sequence(&frame), "case {}", case.name);
            let (expected_upserts, expected_deletes) = expected_interaction_changes(&case.name);
            assert_eq!(
                page.interactions.upserts, expected_upserts,
                "case {}",
                case.name
            );
            assert_eq!(
                page.interactions.deletes, expected_deletes,
                "case {}",
                case.name
            );
            interactions.push(case.name);
        }
        assert_eq!(
            interactions.len(),
            3,
            "the shared fixture must hold a like, a repost and a like delete"
        );
    }

    const FEED_VIEW_FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../stratos-feedgen/testdata/conformance/v1/feed-view.json"
    );

    fn served_feed_view_with_a_liked_and_reposted_post() -> serde_json::Value {
        use crate::{
            authorization::ViewerAuthorization,
            feed_service::FeedQuery,
            feeds::FeedDescription,
            lifecycle::ControlLifecycle,
            service::ProjectionReader,
            store::{ActorPage, EncryptedStore, InteractionChanges, ProjectionPost, StorageKey},
        };

        const AUTHORITY: &str = "did:web:stratos.example.test";
        const BOUNDARY: &str = "did:web:stratos.example.test/bebop";
        const SPIKE: &str = "did:plc:spikespiegel";
        const FAYE: &str = "did:plc:fayevalentine";
        const JET: &str = "did:plc:jetblack";
        let post_uri = format!("at://{SPIKE}/zone.stratos.feed.post/see-you-space-cowboy");
        let interaction = |kind: InteractionKind, actor: &str, rkey: &str| ProjectionInteraction {
            uri: format!("at://{actor}/{}/{rkey}", kind.collection()),
            actor_did: actor.to_owned(),
            kind,
            subject_uri: post_uri.clone(),
            boundary: BOUNDARY.to_owned(),
            indexed_at: "1998-04-03T00:00:02.000Z".to_owned(),
            retained_at: "1998-05-03T00:00:00.000Z".to_owned(),
        };
        let page_of =
            |actor: &str, upserts: Vec<ProjectionPost>, changes: Vec<ProjectionInteraction>| {
                ActorPage {
                    authority_did: AUTHORITY.to_owned(),
                    actor_did: actor.to_owned(),
                    sequence: 1,
                    upserts,
                    deletes: Vec::new(),
                    updated_at: "1998-04-03T00:00:03.000Z".to_owned(),
                    interactions: InteractionChanges {
                        upserts: changes,
                        deletes: Vec::new(),
                    },
                }
            };
        let lifecycle = ControlLifecycle::for_authority(
            ProjectionReader::new(
                EncryptedStore::open_memory(StorageKey::from_bytes([7; 32])).unwrap(),
            ),
            Arc::new(Mutex::new(FeedReadinessGate::default())),
            AUTHORITY,
        )
        .unwrap();
        lifecycle
            .apply_actor_page(page_of(
                SPIKE,
                vec![ProjectionPost {
                    uri: post_uri.clone(),
                    author_did: SPIKE.to_owned(),
                    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
                    sort_at: "1998-04-03T00:00:00.000Z".to_owned(),
                    indexed_at: "1998-04-03T00:00:01.000Z".to_owned(),
                    retained_at: "1998-05-03T00:00:00.000Z".to_owned(),
                    record_json: serde_json::to_vec(&serde_json::json!({
                        "$type": "zone.stratos.feed.post",
                        "text": "See you, space cowboy",
                        "createdAt": "1998-04-03T00:00:00.000Z"
                    }))
                    .unwrap(),
                    blob_refs_json: b"[]".to_vec(),
                    boundaries: vec![BOUNDARY.to_owned()],
                }],
                Vec::new(),
            ))
            .unwrap();
        lifecycle
            .apply_actor_page(page_of(
                FAYE,
                Vec::new(),
                vec![interaction(InteractionKind::Like, FAYE, "swordfish")],
            ))
            .unwrap();
        lifecycle
            .apply_actor_page(page_of(
                JET,
                Vec::new(),
                vec![
                    interaction(InteractionKind::Like, JET, "hard-boiled"),
                    interaction(InteractionKind::Repost, JET, "bounty"),
                ],
            ))
            .unwrap();
        lifecycle
            .apply_viewer_authorization(
                ViewerAuthorization {
                    did: FAYE.to_owned(),
                    boundaries: vec![BOUNDARY.to_owned()],
                    expires_at: 100,
                },
                1,
            )
            .unwrap();
        lifecycle.session_established();
        lifecycle.mark_labels_current();
        let generation = lifecycle.begin_reconciliation();
        assert!(lifecycle.complete_reconciliation(
            generation,
            ReconciliationOutcome {
                errors: 0,
                truncated: false,
            },
        ));
        let feeds = FeedRegistry::new([FeedDescription {
            id: "bebop".to_owned(),
            boundary: BOUNDARY.to_owned(),
            display_name: None,
            description: None,
        }])
        .unwrap();
        let (body, served) = lifecycle
            .serve_viewer_feed(
                FAYE,
                &feeds,
                FeedQuery {
                    feed_id: "bebop",
                    cursor: None,
                    limit: 50,
                    now: 2,
                    as_of: "1998-04-02T00:00:00.000Z",
                    blob_base_url: "https://feedgen.example.test",
                },
            )
            .unwrap();
        assert_eq!(served, 1);
        serde_json::from_slice(&body).unwrap()
    }

    #[test]
    fn serves_the_feed_view_pinned_in_the_shared_fixture() {
        let served = served_feed_view_with_a_liked_and_reposted_post();
        if std::env::var("WRITE_FEED_VIEW_FIXTURE").as_deref() == Ok("1") {
            let fixture = serde_json::json!({ "version": 1, "output": served });
            std::fs::write(
                FEED_VIEW_FIXTURE_PATH,
                serde_json::to_string_pretty(&fixture).unwrap() + "\n",
            )
            .unwrap();
        }
        let pinned: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(FEED_VIEW_FIXTURE_PATH).unwrap())
                .unwrap();
        assert_eq!(pinned["version"], 1);
        assert_eq!(pinned["output"], served);
    }
}
