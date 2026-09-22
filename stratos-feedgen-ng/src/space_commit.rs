use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

use crate::{
    auth::{IdentityKeyResolver, IdentityResolutionError},
    identity_key::DidVerificationKey,
};

const COMMIT_VERSION: u64 = 1;
const DOMAIN_PREFIX: &[u8] = b"atproto-space-v1";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitVerificationFailure {
    MissingCommit,
    MalformedCommit,
    UnsupportedVersion,
    KeyUnresolvable,
    MacMismatch,
    SignatureInvalid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommitVerification {
    Verified,
    Rejected(CommitVerificationFailure),
    DeferredKeyResolution,
}

pub struct SpaceCommitVerifier {
    resolver: Box<dyn IdentityKeyResolver>,
}

impl SpaceCommitVerifier {
    pub fn new(resolver: Box<dyn IdentityKeyResolver>) -> Self {
        Self { resolver }
    }

    pub async fn verify(
        &self,
        space_uri: &str,
        author_did: &str,
        commit: Option<&Value>,
    ) -> CommitVerification {
        let Some(commit) = commit else {
            return CommitVerification::Rejected(CommitVerificationFailure::MissingCommit);
        };
        let Some(commit) = SignedSpaceCommit::decode(commit) else {
            return CommitVerification::Rejected(CommitVerificationFailure::MalformedCommit);
        };
        if commit.version != COMMIT_VERSION {
            return CommitVerification::Rejected(CommitVerificationFailure::UnsupportedVersion);
        }
        let key = match self.resolve(author_did, false).await {
            KeyResolution::Key(key) => key,
            KeyResolution::Deferred => return CommitVerification::DeferredKeyResolution,
            KeyResolution::Invalid => {
                return CommitVerification::Rejected(CommitVerificationFailure::KeyUnresolvable);
            }
        };
        let Ok(context) = commit_context(space_uri, author_did, &commit.revision, &commit.ikm)
        else {
            return CommitVerification::Rejected(CommitVerificationFailure::MalformedCommit);
        };
        if !has_valid_mac(&commit, &context) {
            return CommitVerification::Rejected(CommitVerificationFailure::MacMismatch);
        }
        match key.verifies_any(&context, &commit.signature) {
            None => {
                return CommitVerification::Rejected(CommitVerificationFailure::SignatureInvalid);
            }
            Some(true) => return CommitVerification::Verified,
            Some(false) => {}
        }
        let key = match self.resolve(author_did, true).await {
            KeyResolution::Key(key) => key,
            KeyResolution::Deferred => return CommitVerification::DeferredKeyResolution,
            KeyResolution::Invalid => {
                return CommitVerification::Rejected(CommitVerificationFailure::KeyUnresolvable);
            }
        };
        matches!(key.verifies_any(&context, &commit.signature), Some(true))
            .then_some(CommitVerification::Verified)
            .unwrap_or(CommitVerification::Rejected(
                CommitVerificationFailure::SignatureInvalid,
            ))
    }

    async fn resolve(&self, did: &str, force_refresh: bool) -> KeyResolution {
        let resolved = self.resolver.resolve_atproto_key(did, force_refresh).await;
        match resolved {
            Ok(key) => DidVerificationKey::parse(&key)
                .map(KeyResolution::Key)
                .unwrap_or(KeyResolution::Invalid),
            Err(IdentityResolutionError::Unavailable) => KeyResolution::Deferred,
            Err(_) => KeyResolution::Invalid,
        }
    }
}

enum KeyResolution {
    Key(DidVerificationKey),
    Deferred,
    Invalid,
}

struct SignedSpaceCommit {
    version: u64,
    revision: String,
    hash: Vec<u8>,
    ikm: Vec<u8>,
    mac: Vec<u8>,
    signature: Vec<u8>,
}

impl SignedSpaceCommit {
    fn decode(value: &Value) -> Option<Self> {
        let record = value.as_object()?;
        Some(Self {
            version: record.get("ver")?.as_u64()?,
            revision: record.get("rev")?.as_str()?.to_owned(),
            hash: decode_lex_bytes(record.get("hash")?)?,
            ikm: decode_lex_bytes(record.get("ikm")?)?,
            mac: decode_lex_bytes(record.get("mac")?)?,
            signature: decode_lex_bytes(record.get("sig")?)?,
        })
    }
}

fn decode_lex_bytes(value: &Value) -> Option<Vec<u8>> {
    let encoded = value.as_object()?.get("$bytes")?.as_str()?;
    STANDARD.decode(encoded).ok()
}

fn commit_context(
    space_uri: &str,
    author_did: &str,
    revision: &str,
    ikm: &[u8],
) -> Result<Vec<u8>, ()> {
    let fields = [
        space_uri.as_bytes(),
        author_did.as_bytes(),
        revision.as_bytes(),
        ikm,
    ];
    let mut output = Vec::with_capacity(
        DOMAIN_PREFIX.len() + fields.iter().map(|field| field.len() + 2).sum::<usize>(),
    );
    output.extend_from_slice(DOMAIN_PREFIX);
    for field in fields {
        let length = u16::try_from(field.len()).map_err(|_| ())?;
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(field);
    }
    Ok(output)
}

fn has_valid_mac(commit: &SignedSpaceCommit, context: &[u8]) -> bool {
    let Ok(mut extract) = HmacSha256::new_from_slice(&commit.ikm) else {
        return false;
    };
    extract.update(context);
    extract.update(&[1]);
    let expand_key = extract.finalize().into_bytes();
    let Ok(mut mac) = HmacSha256::new_from_slice(&expand_key) else {
        return false;
    };
    mac.update(&commit.hash);
    mac.verify_slice(&commit.mac).is_ok()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use base64::Engine;
    use hmac::Mac;
    use k256::ecdsa::{SigningKey, signature::Signer};
    use serde_json::json;

    use super::{
        COMMIT_VERSION, CommitVerification, CommitVerificationFailure, HmacSha256,
        SpaceCommitVerifier, commit_context,
    };
    use crate::auth::{IdentityKeyResolver, IdentityResolutionError};

    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const AUTHOR: &str = "did:plc:spike";

    struct Key(String);

    #[async_trait]
    impl IdentityKeyResolver for Key {
        async fn resolve_atproto_key(
            &self,
            _: &str,
            _: bool,
        ) -> Result<String, IdentityResolutionError> {
            Ok(self.0.clone())
        }
    }

    struct RotatingKey {
        first: String,
        refreshed: String,
        calls: Arc<Mutex<Vec<bool>>>,
    }

    struct UnavailableKey;

    #[async_trait]
    impl IdentityKeyResolver for UnavailableKey {
        async fn resolve_atproto_key(
            &self,
            _: &str,
            _: bool,
        ) -> Result<String, IdentityResolutionError> {
            Err(IdentityResolutionError::Unavailable)
        }
    }

    #[async_trait]
    impl IdentityKeyResolver for RotatingKey {
        async fn resolve_atproto_key(
            &self,
            _: &str,
            force_refresh: bool,
        ) -> Result<String, IdentityResolutionError> {
            self.calls.lock().unwrap().push(force_refresh);
            Ok(if force_refresh {
                self.refreshed.clone()
            } else {
                self.first.clone()
            })
        }
    }

    fn verifier(key: String) -> SpaceCommitVerifier {
        SpaceCommitVerifier::new(Box::new(Key(key)))
    }

    fn did_key(key: &SigningKey) -> String {
        let mut bytes = vec![0xe7, 0x01];
        bytes.extend_from_slice(key.verifying_key().to_encoded_point(true).as_bytes());
        format!("did:key:z{}", bs58::encode(bytes).into_string())
    }

    fn p256_did_key(key: &p256::ecdsa::SigningKey) -> String {
        let mut bytes = vec![0x80, 0x24];
        bytes.extend_from_slice(key.verifying_key().to_encoded_point(true).as_bytes());
        format!("did:key:z{}", bs58::encode(bytes).into_string())
    }

    fn commit_with_signature(signature: Vec<u8>) -> serde_json::Value {
        let hash = [3_u8; 32];
        let ikm = [7_u8; 32];
        let context = commit_context(SPACE, AUTHOR, "rev", &ikm).unwrap();
        let mut extract = HmacSha256::new_from_slice(&ikm).unwrap();
        extract.update(&context);
        extract.update(&[1]);
        let expand_key = extract.finalize().into_bytes();
        let mut mac = HmacSha256::new_from_slice(&expand_key).unwrap();
        mac.update(&hash);
        json!({
            "ver": COMMIT_VERSION,
            "rev": "rev",
            "hash": {"$bytes": base64::engine::general_purpose::STANDARD.encode(hash)},
            "ikm": {"$bytes": base64::engine::general_purpose::STANDARD.encode(ikm)},
            "mac": {"$bytes": base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())},
            "sig": {"$bytes": base64::engine::general_purpose::STANDARD.encode(signature)},
        })
    }

    fn commit(key: &SigningKey) -> serde_json::Value {
        let context = commit_context(SPACE, AUTHOR, "rev", &[7_u8; 32]).unwrap();
        let signature: k256::ecdsa::Signature = key.sign(&context);
        commit_with_signature(signature.to_bytes().to_vec())
    }

    #[tokio::test]
    async fn accepts_a_valid_secp256k1_space_commit() {
        let key = SigningKey::from_slice(&[9; 32]).unwrap();
        assert_eq!(
            verifier(did_key(&key))
                .verify(SPACE, AUTHOR, Some(&commit(&key)))
                .await,
            CommitVerification::Verified
        );
    }

    #[tokio::test]
    async fn accepts_a_valid_p256_space_commit() {
        let key = p256::ecdsa::SigningKey::from_slice(&[8; 32]).unwrap();
        let context = commit_context(SPACE, AUTHOR, "rev", &[7_u8; 32]).unwrap();
        let signature: p256::ecdsa::Signature = key.sign(&context);
        let commit = commit_with_signature(signature.to_bytes().to_vec());
        assert_eq!(
            verifier(p256_did_key(&key))
                .verify(SPACE, AUTHOR, Some(&commit))
                .await,
            CommitVerification::Verified
        );
    }

    #[tokio::test]
    async fn refreshes_the_signing_key_once_after_a_signature_mismatch() {
        let old = SigningKey::from_slice(&[9; 32]).unwrap();
        let current = SigningKey::from_slice(&[10; 32]).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let verifier = SpaceCommitVerifier::new(Box::new(RotatingKey {
            first: did_key(&old),
            refreshed: did_key(&current),
            calls: Arc::clone(&calls),
        }));
        assert_eq!(
            verifier
                .verify(SPACE, AUTHOR, Some(&commit(&current)))
                .await,
            CommitVerification::Verified
        );
        assert_eq!(calls.lock().unwrap().as_slice(), [false, true]);
    }

    #[tokio::test]
    async fn rejects_tampering_before_releasing_staged_data() {
        let key = SigningKey::from_slice(&[9; 32]).unwrap();
        let mut invalid = commit(&key);
        invalid["mac"]["$bytes"] =
            json!(base64::engine::general_purpose::STANDARD.encode([0_u8; 32]));
        assert_eq!(
            verifier(did_key(&key))
                .verify(SPACE, AUTHOR, Some(&invalid))
                .await,
            CommitVerification::Rejected(CommitVerificationFailure::MacMismatch)
        );
    }

    #[tokio::test]
    async fn defers_a_bad_commit_when_the_signing_key_is_temporarily_unavailable() {
        let key = SigningKey::from_slice(&[9; 32]).unwrap();
        let mut invalid = commit(&key);
        invalid["mac"]["$bytes"] =
            json!(base64::engine::general_purpose::STANDARD.encode([0_u8; 32]));
        let verifier = SpaceCommitVerifier::new(Box::new(UnavailableKey));
        assert_eq!(
            verifier.verify(SPACE, AUTHOR, Some(&invalid)).await,
            CommitVerification::DeferredKeyResolution
        );
    }

    #[tokio::test]
    async fn rejects_missing_malformed_and_unsupported_commits() {
        let key = SigningKey::from_slice(&[9; 32]).unwrap();
        let verifier = verifier(did_key(&key));
        assert_eq!(
            verifier.verify(SPACE, AUTHOR, None).await,
            CommitVerification::Rejected(CommitVerificationFailure::MissingCommit)
        );
        assert_eq!(
            verifier.verify(SPACE, AUTHOR, Some(&json!({}))).await,
            CommitVerification::Rejected(CommitVerificationFailure::MalformedCommit)
        );
        let mut invalid = commit(&key);
        invalid["ver"] = json!(2);
        assert_eq!(
            verifier.verify(SPACE, AUTHOR, Some(&invalid)).await,
            CommitVerification::Rejected(CommitVerificationFailure::UnsupportedVersion)
        );
    }

    #[tokio::test]
    async fn rejects_malformed_signatures_without_refreshing_the_key() {
        let key = SigningKey::from_slice(&[9; 32]).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let rotating = RotatingKey {
            first: did_key(&key),
            refreshed: did_key(&key),
            calls: Arc::clone(&calls),
        };
        let mut invalid = commit(&key);
        invalid["sig"]["$bytes"] =
            json!(base64::engine::general_purpose::STANDARD.encode([0_u8; 63]));
        let verifier = SpaceCommitVerifier::new(Box::new(rotating));

        assert_eq!(
            verifier.verify(SPACE, AUTHOR, Some(&invalid)).await,
            CommitVerification::Rejected(CommitVerificationFailure::SignatureInvalid)
        );
        assert_eq!(calls.lock().unwrap().as_slice(), [false]);
    }
}
