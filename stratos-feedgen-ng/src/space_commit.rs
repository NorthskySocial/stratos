use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use k256::ecdsa::signature::Verifier;
use serde_json::Value;
use sha2::Sha256;

const COMMIT_VERSION: u64 = 1;
const DOMAIN_PREFIX: &[u8] = b"atproto-space-v1";
const P256_MULTICODEC: u64 = 0x1200;
const SECP256K1_MULTICODEC: u64 = 0xe7;

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommitKeyResolutionError {
    pub transient: bool,
}

#[async_trait]
pub trait CommitKeyResolver: Send + Sync {
    async fn resolve_atproto_key(
        &self,
        did: &str,
        force_refresh: bool,
    ) -> Result<String, CommitKeyResolutionError>;
}

pub struct SpaceCommitVerifier {
    resolver: Box<dyn CommitKeyResolver>,
}

impl SpaceCommitVerifier {
    pub fn new(resolver: Box<dyn CommitKeyResolver>) -> Self {
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
        if verifies_signature(&key, &context, &commit.signature) {
            return CommitVerification::Verified;
        }
        let key = match self.resolve(author_did, true).await {
            KeyResolution::Key(key) => key,
            KeyResolution::Deferred => return CommitVerification::DeferredKeyResolution,
            KeyResolution::Invalid => {
                return CommitVerification::Rejected(CommitVerificationFailure::KeyUnresolvable);
            }
        };
        if verifies_signature(&key, &context, &commit.signature) {
            CommitVerification::Verified
        } else {
            CommitVerification::Rejected(CommitVerificationFailure::SignatureInvalid)
        }
    }

    async fn resolve(&self, did: &str, force_refresh: bool) -> KeyResolution {
        let resolved = self.resolver.resolve_atproto_key(did, force_refresh).await;
        match resolved {
            Ok(key) => VerificationKey::parse(&key)
                .map(KeyResolution::Key)
                .unwrap_or(KeyResolution::Invalid),
            Err(error) if error.transient => KeyResolution::Deferred,
            Err(_) => KeyResolution::Invalid,
        }
    }
}

enum KeyResolution {
    Key(VerificationKey),
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

enum VerificationKey {
    P256(p256::ecdsa::VerifyingKey),
    Secp256k1(k256::ecdsa::VerifyingKey),
}

impl VerificationKey {
    fn parse(value: &str) -> Option<Self> {
        let encoded = value.strip_prefix("did:key:z")?;
        let bytes = bs58::decode(encoded).into_vec().ok()?;
        let (codec, key) = decode_multicodec(&bytes)?;
        match codec {
            P256_MULTICODEC => p256::ecdsa::VerifyingKey::from_sec1_bytes(key)
                .ok()
                .map(Self::P256),
            SECP256K1_MULTICODEC => k256::ecdsa::VerifyingKey::from_sec1_bytes(key)
                .ok()
                .map(Self::Secp256k1),
            _ => None,
        }
    }
}

fn verifies_signature(key: &VerificationKey, context: &[u8], signature: &[u8]) -> bool {
    match key {
        VerificationKey::P256(key) => p256::ecdsa::Signature::from_slice(signature)
            .is_ok_and(|signature| key.verify(context, &signature).is_ok()),
        VerificationKey::Secp256k1(key) => k256::ecdsa::Signature::from_slice(signature)
            .is_ok_and(|signature| key.verify(context, &signature).is_ok()),
    }
}

fn decode_multicodec(bytes: &[u8]) -> Option<(u64, &[u8])> {
    let mut value = 0_u64;
    for (index, byte) in bytes.iter().copied().enumerate() {
        let shift = index.checked_mul(7)?;
        if shift >= u64::BITS as usize {
            return None;
        }
        let payload = byte & 0x7f;
        if shift == 63 && (payload > 1 || byte & 0x80 != 0) {
            return None;
        }
        value |= u64::from(payload) << shift;
        if byte & 0x80 == 0 {
            if index > 0 && payload == 0 {
                return None;
            }
            return Some((value, &bytes[index + 1..]));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use base64::Engine;
    use hmac::Mac;
    use k256::ecdsa::{SigningKey, signature::Signer};
    use serde_json::json;

    use super::{
        COMMIT_VERSION, CommitKeyResolutionError, CommitKeyResolver, CommitVerification,
        CommitVerificationFailure, HmacSha256, SpaceCommitVerifier, commit_context,
    };

    const SPACE: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop";
    const AUTHOR: &str = "did:plc:spike";

    struct Key(String);

    #[async_trait]
    impl CommitKeyResolver for Key {
        async fn resolve_atproto_key(
            &self,
            _: &str,
            _: bool,
        ) -> Result<String, CommitKeyResolutionError> {
            Ok(self.0.clone())
        }
    }

    struct RotatingKey {
        first: String,
        refreshed: String,
    }

    struct UnavailableKey;

    #[async_trait]
    impl CommitKeyResolver for UnavailableKey {
        async fn resolve_atproto_key(
            &self,
            _: &str,
            _: bool,
        ) -> Result<String, CommitKeyResolutionError> {
            Err(CommitKeyResolutionError { transient: true })
        }
    }

    #[async_trait]
    impl CommitKeyResolver for RotatingKey {
        async fn resolve_atproto_key(
            &self,
            _: &str,
            force_refresh: bool,
        ) -> Result<String, CommitKeyResolutionError> {
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

    fn commit(key: &SigningKey) -> serde_json::Value {
        let hash = [3_u8; 32];
        let ikm = [7_u8; 32];
        let context = commit_context(SPACE, AUTHOR, "rev", &ikm).unwrap();
        let mut extract = HmacSha256::new_from_slice(&ikm).unwrap();
        extract.update(&context);
        extract.update(&[1]);
        let expand_key = extract.finalize().into_bytes();
        let mut mac = HmacSha256::new_from_slice(&expand_key).unwrap();
        mac.update(&hash);
        let signature: k256::ecdsa::Signature = key.sign(&context);
        json!({
            "ver": COMMIT_VERSION,
            "rev": "rev",
            "hash": {"$bytes": base64::engine::general_purpose::STANDARD.encode(hash)},
            "ikm": {"$bytes": base64::engine::general_purpose::STANDARD.encode(ikm)},
            "mac": {"$bytes": base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())},
            "sig": {"$bytes": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())},
        })
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
        let hash = [3_u8; 32];
        let ikm = [7_u8; 32];
        let context = commit_context(SPACE, AUTHOR, "rev", &ikm).unwrap();
        let mut extract = HmacSha256::new_from_slice(&ikm).unwrap();
        extract.update(&context);
        extract.update(&[1]);
        let expand_key = extract.finalize().into_bytes();
        let mut mac = HmacSha256::new_from_slice(&expand_key).unwrap();
        mac.update(&hash);
        let signature: p256::ecdsa::Signature = key.sign(&context);
        let commit = json!({
            "ver": COMMIT_VERSION,
            "rev": "rev",
            "hash": {"$bytes": base64::engine::general_purpose::STANDARD.encode(hash)},
            "ikm": {"$bytes": base64::engine::general_purpose::STANDARD.encode(ikm)},
            "mac": {"$bytes": base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())},
            "sig": {"$bytes": base64::engine::general_purpose::STANDARD.encode(signature.to_bytes())},
        });
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
        let verifier = SpaceCommitVerifier::new(Box::new(RotatingKey {
            first: did_key(&old),
            refreshed: did_key(&current),
        }));
        assert_eq!(
            verifier
                .verify(SPACE, AUTHOR, Some(&commit(&current)))
                .await,
            CommitVerification::Verified
        );
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
}
