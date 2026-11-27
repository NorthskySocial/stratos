//! Discovery of an author's `#atproto_kem` key, kept apart from the signing key
//! lookup: it has its own consumer-owned trait, its own selection rules and its
//! own cache entries.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;

use crate::space_kem::{AuthorKemKey, SpaceKemError};

const KEM_METHOD_FRAGMENT: &str = "#atproto_kem";
const MULTIKEY_TYPE: &str = "Multikey";
const LEGACY_P256_TYPE: &str = "EcdsaSecp256r1VerificationKey2019";
const BASE58_MULTIBASE_PREFIX: char = 'z';
const DID_KEY_PREFIX: &str = "did:key:";
// A bare P-256 key is at most 65 bytes, 89 base58 characters.
const MAX_BARE_KEY_TEXT_LENGTH: usize = 128;

/// Why a lookup produced no key. A target whose lookup is `Unavailable` is
/// deferred; one whose lookup is `Invalid` has failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KemKeyLookupError {
    Unavailable,
    Invalid,
}

impl std::fmt::Display for KemKeyLookupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "author key service is unavailable",
            Self::Invalid => "author has no usable KEM key",
        })
    }
}

impl std::error::Error for KemKeyLookupError {}

/// What is wrong with a DID document or its KEM key.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KemKeyDefect {
    DidKeyHasNoKemKey,
    InvalidDocument,
    DocumentIdMismatch,
    MissingKemMethod,
    AmbiguousKemMethod,
    UnsupportedMethodType,
    InvalidKey,
}

#[async_trait]
pub trait AuthorKemKeyResolver: Send + Sync {
    /// May answer from cache.
    async fn author_kem_key(&self, did: &str) -> Result<AuthorKemKey, KemKeyLookupError>;

    /// Always reads the author's current DID document.
    async fn refreshed_author_kem_key(&self, did: &str) -> Result<AuthorKemKey, KemKeyLookupError>;
}

#[async_trait]
impl<T> AuthorKemKeyResolver for Arc<T>
where
    T: AuthorKemKeyResolver + ?Sized,
{
    async fn author_kem_key(&self, did: &str) -> Result<AuthorKemKey, KemKeyLookupError> {
        self.as_ref().author_kem_key(did).await
    }

    async fn refreshed_author_kem_key(&self, did: &str) -> Result<AuthorKemKey, KemKeyLookupError> {
        self.as_ref().refreshed_author_kem_key(did).await
    }
}

#[derive(Deserialize)]
struct KemDocument {
    id: String,
    #[serde(rename = "verificationMethod", default)]
    verification_methods: Vec<KemMethod>,
}

#[derive(Deserialize)]
struct KemMethod {
    id: String,
    #[serde(rename = "type")]
    method_type: Option<String>,
    #[serde(rename = "publicKeyMultibase")]
    public_key_multibase: Option<String>,
}

pub(crate) fn is_did_key(did: &str) -> bool {
    did.starts_with(DID_KEY_PREFIX)
}

/// Selects and decodes the `#atproto_kem` key of `did` from its DID document.
pub fn kem_key_from_document(did: &str, document: &str) -> Result<AuthorKemKey, KemKeyDefect> {
    if is_did_key(did) {
        return Err(KemKeyDefect::DidKeyHasNoKemKey);
    }
    let document: KemDocument =
        serde_json::from_str(document).map_err(|_| KemKeyDefect::InvalidDocument)?;
    if document.id != did {
        return Err(KemKeyDefect::DocumentIdMismatch);
    }
    let absolute_id = format!("{did}{KEM_METHOD_FRAGMENT}");
    let mut candidates = document
        .verification_methods
        .iter()
        .filter(|method| method.id == KEM_METHOD_FRAGMENT || method.id == absolute_id);
    let method = candidates.next().ok_or(KemKeyDefect::MissingKemMethod)?;
    if candidates.next().is_some() {
        return Err(KemKeyDefect::AmbiguousKemMethod);
    }
    let key = match method.method_type.as_deref() {
        Some(MULTIKEY_TYPE) => decode_with(method, AuthorKemKey::from_multikey),
        Some(LEGACY_P256_TYPE) => decode_with(method, key_from_bare_multibase),
        _ => return Err(KemKeyDefect::UnsupportedMethodType),
    };
    key.map_err(|_| KemKeyDefect::InvalidKey)
}

fn decode_with(
    method: &KemMethod,
    decode: fn(&str) -> Result<AuthorKemKey, SpaceKemError>,
) -> Result<AuthorKemKey, SpaceKemError> {
    decode(
        method
            .public_key_multibase
            .as_deref()
            .ok_or(SpaceKemError::InvalidKey)?,
    )
}

/// The legacy method type holds `z` and base58btc of the bare key bytes.
fn key_from_bare_multibase(multibase: &str) -> Result<AuthorKemKey, SpaceKemError> {
    if multibase.len() > MAX_BARE_KEY_TEXT_LENGTH {
        return Err(SpaceKemError::InvalidKey);
    }
    let encoded = multibase
        .strip_prefix(BASE58_MULTIBASE_PREFIX)
        .ok_or(SpaceKemError::InvalidKey)?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|_| SpaceKemError::InvalidKey)?;
    AuthorKemKey::from_sec1_bytes(&bytes)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use async_trait::async_trait;
    use serde_json::{Value, json};

    use super::*;
    use crate::{
        auth::{IdentityKeyResolver, IdentityResolutionError},
        identity::{DidDocumentSource, HttpIdentityKeyResolver},
    };

    const KEM_KEYS: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/kem-keys.json");
    const AUTHOR_DID: &str = "did:plc:spike";
    const OTHER_AUTHOR_DID: &str = "did:plc:faye";

    fn fixture() -> Value {
        serde_json::from_str(KEM_KEYS).expect("fixture is json")
    }

    fn fixture_case(name: &str) -> Value {
        fixture()["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .find(|candidate| candidate["name"] == name)
            .unwrap_or_else(|| panic!("no case named {name}"))
            .clone()
    }

    fn multibase_of(case: &Value, method_index: usize) -> String {
        case["document"]["verificationMethod"][method_index]["publicKeyMultibase"]
            .as_str()
            .expect("multibase")
            .to_string()
    }

    // The two keys the tests tell apart, both encoded by the oracle's crypto package.
    fn kem_multibase() -> String {
        multibase_of(&fixture_case("a Multikey method with a relative id"), 0)
    }

    fn signing_multibase() -> String {
        multibase_of(&fixture_case("a KEM key different from the signing key"), 0)
    }

    fn did_key_text(multibase: &str) -> String {
        format!("did:key:{multibase}")
    }

    fn document_with(did: &str, signing: &str, kem: &str) -> String {
        json!({
            "id": did,
            "verificationMethod": [
                { "id": "#atproto", "type": "Multikey", "publicKeyMultibase": signing },
                { "id": "#atproto_kem", "type": "Multikey", "publicKeyMultibase": kem },
            ],
        })
        .to_string()
    }

    fn defect_for(reason: &str) -> KemKeyDefect {
        match reason {
            "no-kem-method" => KemKeyDefect::MissingKemMethod,
            "wrong-curve" | "malformed-key" => KemKeyDefect::InvalidKey,
            "document-id-mismatch" => KemKeyDefect::DocumentIdMismatch,
            "ambiguous-kem-method" => KemKeyDefect::AmbiguousKemMethod,
            other => panic!("unmapped reason {other}"),
        }
    }

    // Oracle vector: documents written by hand, keys encoded by the oracle's crypto package.
    #[test]
    fn every_document_in_the_oracle_key_fixture_gives_its_expected_result() {
        let fixture = fixture();
        let did = fixture["did"].as_str().expect("did");
        let cases = fixture["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), 9);
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let document = case["document"].to_string();
            let result = kem_key_from_document(did, &document);
            match case["expected"]["kemKey"].as_str() {
                Some(expected) => {
                    assert_eq!(
                        result.map(|key| key.did_key()),
                        Ok(expected.to_string()),
                        "{name}"
                    );
                }
                None => {
                    let reason = case["expected"]["refused"].as_str().expect("reason");
                    assert_eq!(result.err(), Some(defect_for(reason)), "{name}");
                }
            }
            if case["oracleKeyVerdict"]
                .as_str()
                .is_some_and(|verdict| verdict.starts_with("refused"))
            {
                assert!(kem_key_from_document(did, &document).is_err(), "{name}");
            }
        }
    }

    #[test]
    fn a_kem_method_of_another_type_or_without_a_key_is_refused() {
        let methods = |method: Value| json!({ "id": AUTHOR_DID, "verificationMethod": [method] });
        let cases = [
            (
                json!({ "id": "#atproto_kem", "type": "JsonWebKey2020", "publicKeyMultibase": kem_multibase() }),
                KemKeyDefect::UnsupportedMethodType,
            ),
            (
                json!({ "id": "#atproto_kem", "publicKeyMultibase": kem_multibase() }),
                KemKeyDefect::UnsupportedMethodType,
            ),
            (
                json!({ "id": "#atproto_kem", "type": "Multikey" }),
                KemKeyDefect::InvalidKey,
            ),
        ];
        for (method, defect) in cases {
            assert_eq!(
                kem_key_from_document(AUTHOR_DID, &methods(method.clone()).to_string()).err(),
                Some(defect),
                "{method}"
            );
        }
        assert_eq!(
            kem_key_from_document(AUTHOR_DID, "not json").err(),
            Some(KemKeyDefect::InvalidDocument)
        );
    }

    // The P-256 point of the fixture's KEM key under the secp256k1 codec: the
    // bytes are a valid P-256 point, so only the codec says it is the wrong curve.
    #[test]
    fn a_valid_p256_point_under_the_secp256k1_codec_is_refused() {
        const SECP256K1_PREFIX: [u8; 2] = [0xe7, 0x01];
        const P256_PREFIX_LENGTH: usize = 2;
        let multikey = kem_multibase();
        let prefixed = bs58::decode(&multikey[1..]).into_vec().expect("base58");
        let mut relabelled = SECP256K1_PREFIX.to_vec();
        relabelled.extend_from_slice(&prefixed[P256_PREFIX_LENGTH..]);
        let document = json!({
            "id": AUTHOR_DID,
            "verificationMethod": [{
                "id": "#atproto_kem",
                "type": "Multikey",
                "publicKeyMultibase": format!("z{}", bs58::encode(relabelled).into_string()),
            }],
        })
        .to_string();

        assert_eq!(
            kem_key_from_document(AUTHOR_DID, &document).err(),
            Some(KemKeyDefect::InvalidKey)
        );
    }

    #[test]
    fn a_signing_key_method_alone_never_stands_in_for_the_kem_key() {
        let document = json!({
            "id": AUTHOR_DID,
            "verificationMethod": [
                { "id": "#atproto", "type": "Multikey", "publicKeyMultibase": signing_multibase() },
                { "id": format!("{AUTHOR_DID}#atproto"), "type": "Multikey", "publicKeyMultibase": signing_multibase() },
            ],
        })
        .to_string();
        assert_eq!(
            kem_key_from_document(AUTHOR_DID, &document).err(),
            Some(KemKeyDefect::MissingKemMethod)
        );
    }

    struct ScriptedDocuments {
        documents: Mutex<BTreeMap<String, Result<String, IdentityResolutionError>>>,
        fetches: AtomicUsize,
    }

    impl ScriptedDocuments {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                documents: Mutex::new(BTreeMap::new()),
                fetches: AtomicUsize::new(0),
            })
        }

        fn publish(&self, did: &str, document: Result<String, IdentityResolutionError>) {
            self.documents
                .lock()
                .expect("documents")
                .insert(did.to_string(), document);
        }

        fn fetch_count(&self) -> usize {
            self.fetches.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl DidDocumentSource for ScriptedDocuments {
        async fn fetch(&self, did: &str) -> Result<String, IdentityResolutionError> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            self.documents
                .lock()
                .expect("documents")
                .get(did)
                .cloned()
                .unwrap_or(Err(IdentityResolutionError::NotFound))
        }
    }

    fn resolver_over(documents: &Arc<ScriptedDocuments>) -> HttpIdentityKeyResolver {
        HttpIdentityKeyResolver::with_document_source(documents.clone())
    }

    // In-process test: one resolver, one document, both keys, both orders.
    #[tokio::test]
    async fn the_signing_lookup_and_the_kem_lookup_each_get_their_own_key_in_either_order() {
        let documents = ScriptedDocuments::new();
        for did in [AUTHOR_DID, OTHER_AUTHOR_DID] {
            documents.publish(
                did,
                Ok(document_with(did, &signing_multibase(), &kem_multibase())),
            );
        }
        let resolver = resolver_over(&documents);

        let signing_first = resolver
            .resolve_atproto_key(AUTHOR_DID, false)
            .await
            .expect("signing key");
        let kem_after = resolver.author_kem_key(AUTHOR_DID).await.expect("kem key");
        let kem_first = resolver
            .author_kem_key(OTHER_AUTHOR_DID)
            .await
            .expect("kem key");
        let signing_after = resolver
            .resolve_atproto_key(OTHER_AUTHOR_DID, false)
            .await
            .expect("signing key");

        assert_eq!(signing_first, did_key_text(&signing_multibase()));
        assert_eq!(signing_after, did_key_text(&signing_multibase()));
        assert_eq!(kem_after.did_key(), did_key_text(&kem_multibase()));
        assert_eq!(kem_first.did_key(), did_key_text(&kem_multibase()));
        assert_ne!(signing_first, kem_after.did_key());
    }

    // In-process test: the cached operation answers from cache, the refreshed one never does.
    #[tokio::test]
    async fn after_the_document_rotates_the_cached_lookup_is_old_and_the_refreshed_one_is_new() {
        let documents = ScriptedDocuments::new();
        documents.publish(
            AUTHOR_DID,
            Ok(document_with(
                AUTHOR_DID,
                &signing_multibase(),
                &kem_multibase(),
            )),
        );
        let resolver = resolver_over(&documents);
        let first = resolver.author_kem_key(AUTHOR_DID).await.expect("first");
        assert_eq!(documents.fetch_count(), 1);

        documents.publish(
            AUTHOR_DID,
            Ok(document_with(
                AUTHOR_DID,
                &kem_multibase(),
                &signing_multibase(),
            )),
        );
        let cached = resolver.author_kem_key(AUTHOR_DID).await.expect("cached");
        assert_eq!(cached, first);
        assert_eq!(documents.fetch_count(), 1);

        let refreshed = resolver
            .refreshed_author_kem_key(AUTHOR_DID)
            .await
            .expect("refreshed");
        assert_eq!(refreshed.did_key(), did_key_text(&signing_multibase()));
        assert_ne!(refreshed, first);
        assert_eq!(documents.fetch_count(), 2);

        let after = resolver.author_kem_key(AUTHOR_DID).await.expect("after");
        assert_eq!(after, refreshed);
        assert_eq!(documents.fetch_count(), 2);
    }

    #[tokio::test]
    async fn a_refresh_fetches_again_even_when_the_document_is_unchanged() {
        let documents = ScriptedDocuments::new();
        documents.publish(
            AUTHOR_DID,
            Ok(document_with(
                AUTHOR_DID,
                &signing_multibase(),
                &kem_multibase(),
            )),
        );
        let resolver = resolver_over(&documents);

        resolver.author_kem_key(AUTHOR_DID).await.expect("first");
        resolver
            .refreshed_author_kem_key(AUTHOR_DID)
            .await
            .expect("refreshed");
        resolver
            .refreshed_author_kem_key(AUTHOR_DID)
            .await
            .expect("refreshed again");

        assert_eq!(documents.fetch_count(), 3);
    }

    // In-process test: an unreachable resolver defers, every other failure fails.
    #[tokio::test]
    async fn an_unreachable_resolver_is_unavailable_and_a_bad_answer_is_invalid() {
        let documents = ScriptedDocuments::new();
        documents.publish(AUTHOR_DID, Err(IdentityResolutionError::Unavailable));
        let resolver = resolver_over(&documents);
        assert_eq!(
            resolver.author_kem_key(AUTHOR_DID).await.err(),
            Some(KemKeyLookupError::Unavailable)
        );
        assert_eq!(
            resolver.refreshed_author_kem_key(AUTHOR_DID).await.err(),
            Some(KemKeyLookupError::Unavailable)
        );

        for failure in [
            IdentityResolutionError::NotFound,
            IdentityResolutionError::InvalidDocument,
            IdentityResolutionError::DocumentTooLarge,
            IdentityResolutionError::UnsafeResolverAddress,
            IdentityResolutionError::UnsupportedDid,
        ] {
            documents.publish(AUTHOR_DID, Err(failure.clone()));
            assert_eq!(
                resolver.refreshed_author_kem_key(AUTHOR_DID).await.err(),
                Some(KemKeyLookupError::Invalid),
                "{failure:?}"
            );
        }

        documents.publish(
            AUTHOR_DID,
            Ok(json!({ "id": AUTHOR_DID, "verificationMethod": [] }).to_string()),
        );
        assert_eq!(
            resolver.refreshed_author_kem_key(AUTHOR_DID).await.err(),
            Some(KemKeyLookupError::Invalid)
        );
    }

    #[tokio::test]
    async fn a_did_key_author_has_no_kem_key_and_costs_no_fetch() {
        let documents = ScriptedDocuments::new();
        let resolver = resolver_over(&documents);
        let author = did_key_text(&kem_multibase());

        assert_eq!(
            resolver.author_kem_key(&author).await.err(),
            Some(KemKeyLookupError::Invalid)
        );
        assert_eq!(
            resolver.refreshed_author_kem_key(&author).await.err(),
            Some(KemKeyLookupError::Invalid)
        );
        assert_eq!(documents.fetch_count(), 0);
    }

    // In-process test: a string equal to the one the KEM entry used to be keyed
    // under is just an unknown DID to the signing lookup.
    #[tokio::test]
    async fn no_string_given_to_the_signing_lookup_reaches_a_kem_entry() {
        let documents = ScriptedDocuments::new();
        documents.publish(
            AUTHOR_DID,
            Ok(document_with(
                AUTHOR_DID,
                &signing_multibase(),
                &kem_multibase(),
            )),
        );
        let resolver = resolver_over(&documents);
        let kem = resolver.author_kem_key(AUTHOR_DID).await.expect("kem key");
        assert_eq!(documents.fetch_count(), 1);

        let lookalike = format!("atproto_kem key of {AUTHOR_DID}");
        let answer = resolver.resolve_atproto_key(&lookalike, false).await;

        assert_ne!(answer.as_deref(), Ok(kem.did_key().as_str()));
        assert_eq!(answer, Err(IdentityResolutionError::NotFound));
        assert_eq!(documents.fetch_count(), 2);
    }
}
