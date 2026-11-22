//! Key agreement for response authentication: HPKE (RFC 9180) in base mode with
//! DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and the export-only AEAD, used only to
//! export one secret per request. The steps follow the pinned upstream
//! `packages/space/src/kem.ts`; no HPKE crate is used because nothing but the
//! export is needed.

use std::fmt;

use hkdf::Hkdf;
use p256::elliptic_curve::{Generate, sec1::ToSec1Point};
use p256::{PublicKey, SecretKey, ecdh::diffie_hellman};
use sha2::Sha256;
use zeroize::Zeroizing;

const HPKE_VERSION: &[u8] = b"HPKE-v1";
const KEM_ID_P256_HKDF_SHA256: [u8; 2] = 0x0010_u16.to_be_bytes();
const KDF_ID_HKDF_SHA256: [u8; 2] = 0x0001_u16.to_be_bytes();
const AEAD_ID_EXPORT_ONLY: [u8; 2] = 0xffff_u16.to_be_bytes();
const MODE_BASE: u8 = 0x00;
const MAC_EXPORT_INFO: &[u8] = b"atproto-mac";
const SECRET_LENGTH: usize = 32;

const P256_MULTICODEC_PREFIX: [u8; 2] = [0x80, 0x24];
const DID_KEY_PREFIX: &str = "did:key:";
const MULTIBASE_BASE58_PREFIX: char = 'z';
// A P-256 multikey is about 92 base58 characters at most; base58 decoding is
// quadratic and the text comes from a DID document.
const MAX_MULTIKEY_TEXT_LENGTH: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpaceKemError {
    InvalidKey,
    Derivation,
}

impl fmt::Display for SpaceKemError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidKey => "key is not a P-256 public key",
            Self::Derivation => "shared secret derivation failed",
        })
    }
}

impl std::error::Error for SpaceKemError {}

/// An author's `#atproto_kem` key: a valid P-256 point, never the identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorKemKey {
    public_key: PublicKey,
}

impl AuthorKemKey {
    /// Accepts a compressed or an uncompressed SEC1 point.
    pub fn from_sec1_bytes(bytes: &[u8]) -> Result<Self, SpaceKemError> {
        PublicKey::from_sec1_bytes(bytes)
            .map(|public_key| Self { public_key })
            .map_err(|_| SpaceKemError::InvalidKey)
    }

    /// Reads the multibase text of a `Multikey`: `z`, then base58btc of the
    /// P-256 multicodec prefix and the key.
    pub fn from_multikey(multikey: &str) -> Result<Self, SpaceKemError> {
        if multikey.len() > MAX_MULTIKEY_TEXT_LENGTH {
            return Err(SpaceKemError::InvalidKey);
        }
        let encoded = multikey
            .strip_prefix(MULTIBASE_BASE58_PREFIX)
            .ok_or(SpaceKemError::InvalidKey)?;
        let bytes = bs58::decode(encoded)
            .into_vec()
            .map_err(|_| SpaceKemError::InvalidKey)?;
        let key = bytes
            .strip_prefix(&P256_MULTICODEC_PREFIX)
            .ok_or(SpaceKemError::InvalidKey)?;
        Self::from_sec1_bytes(key)
    }

    pub fn from_did_key(did_key: &str) -> Result<Self, SpaceKemError> {
        let multikey = did_key
            .strip_prefix(DID_KEY_PREFIX)
            .ok_or(SpaceKemError::InvalidKey)?;
        Self::from_multikey(multikey)
    }

    /// The compressed `did:key` form, which is also the key share on the wire.
    pub fn did_key(&self) -> String {
        let mut multikey = P256_MULTICODEC_PREFIX.to_vec();
        multikey.extend_from_slice(self.public_key.to_sec1_point(true).as_bytes());
        format!(
            "{DID_KEY_PREFIX}{MULTIBASE_BASE58_PREFIX}{}",
            bs58::encode(multikey).into_string()
        )
    }
}

/// The key share to send with one request and the secret that answers it. A
/// new one is made for every request; the secret is zeroed when this drops.
/// Code outside this crate cannot read the secret:
///
/// ```compile_fail
/// fn leak(request: &stratos_feedgen_ng::space_kem::RequestSecret) -> &[u8; 32] {
///     request.secret()
/// }
/// ```
pub struct RequestSecret {
    key_share: String,
    secret: Zeroizing<[u8; SECRET_LENGTH]>,
}

impl RequestSecret {
    pub fn key_share(&self) -> &str {
        &self.key_share
    }

    pub(crate) fn secret(&self) -> &[u8; SECRET_LENGTH] {
        &self.secret
    }
}

impl fmt::Debug for RequestSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RequestSecret")
            .field("key_share", &self.key_share)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// Makes a fresh ephemeral key and derives the secret shared with the author.
pub fn encapsulate(author: &AuthorKemKey) -> Result<RequestSecret, SpaceKemError> {
    encapsulate_with(author, &SecretKey::generate())
}

#[cfg(test)]
pub(crate) fn encapsulate_with_ephemeral_key(
    author: &AuthorKemKey,
    ephemeral_private_key: &[u8],
) -> Result<RequestSecret, SpaceKemError> {
    let ephemeral =
        SecretKey::from_slice(ephemeral_private_key).map_err(|_| SpaceKemError::InvalidKey)?;
    encapsulate_with(author, &ephemeral)
}

/// The author's side: the same secret from the author's private key and the
/// key share a requester sent.
#[cfg(test)]
pub(crate) fn decapsulate(
    author_private_key: &SecretKey,
    key_share: &str,
) -> Result<RequestSecret, SpaceKemError> {
    let sender = AuthorKemKey::from_did_key(key_share)?;
    let dh = diffie_hellman(
        author_private_key.to_nonzero_scalar(),
        sender.public_key.as_affine(),
    );
    let secret = derive_export(
        dh.raw_secret_bytes(),
        &uncompressed(&sender.public_key),
        &uncompressed(&author_private_key.public_key()),
        MAC_EXPORT_INFO,
        &[],
        SECRET_LENGTH,
    )?;
    Ok(request_secret(key_share.to_string(), &secret))
}

fn encapsulate_with(
    author: &AuthorKemKey,
    ephemeral: &SecretKey,
) -> Result<RequestSecret, SpaceKemError> {
    let enc = ephemeral.public_key();
    let dh = diffie_hellman(ephemeral.to_nonzero_scalar(), author.public_key.as_affine());
    let secret = derive_export(
        dh.raw_secret_bytes(),
        &uncompressed(&enc),
        &uncompressed(&author.public_key),
        MAC_EXPORT_INFO,
        &[],
        SECRET_LENGTH,
    )?;
    let key_share = AuthorKemKey { public_key: enc }.did_key();
    Ok(request_secret(key_share, &secret))
}

fn request_secret(key_share: String, exported: &[u8]) -> RequestSecret {
    let mut secret = Zeroizing::new([0_u8; SECRET_LENGTH]);
    secret.copy_from_slice(exported);
    RequestSecret { key_share, secret }
}

fn uncompressed(key: &PublicKey) -> Vec<u8> {
    key.to_sec1_point(false).as_bytes().to_vec()
}

fn kem_suite_id() -> Vec<u8> {
    [b"KEM".as_slice(), &KEM_ID_P256_HKDF_SHA256].concat()
}

fn hpke_suite_id() -> Vec<u8> {
    [
        b"HPKE".as_slice(),
        &KEM_ID_P256_HKDF_SHA256,
        &KDF_ID_HKDF_SHA256,
        &AEAD_ID_EXPORT_ONLY,
    ]
    .concat()
}

fn labeled_extract(suite_id: &[u8], salt: &[u8], label: &str, input: &[u8]) -> Zeroizing<Vec<u8>> {
    let labeled_input = Zeroizing::new([HPKE_VERSION, suite_id, label.as_bytes(), input].concat());
    let (pseudorandom_key, _) = Hkdf::<Sha256>::extract(Some(salt), &labeled_input);
    Zeroizing::new(pseudorandom_key.to_vec())
}

fn labeled_expand(
    suite_id: &[u8],
    pseudorandom_key: &[u8],
    label: &str,
    info: &[u8],
    length: usize,
) -> Result<Zeroizing<Vec<u8>>, SpaceKemError> {
    let encoded_length = u16::try_from(length).map_err(|_| SpaceKemError::Derivation)?;
    let labeled_info = [
        encoded_length.to_be_bytes().as_slice(),
        HPKE_VERSION,
        suite_id,
        label.as_bytes(),
        info,
    ]
    .concat();
    let expander =
        Hkdf::<Sha256>::from_prk(pseudorandom_key).map_err(|_| SpaceKemError::Derivation)?;
    let mut output = Zeroizing::new(vec![0_u8; length]);
    expander
        .expand(&labeled_info, &mut output)
        .map_err(|_| SpaceKemError::Derivation)?;
    Ok(output)
}

/// DHKEM's shared secret from the ECDH value and both uncompressed points.
fn kem_shared_secret(
    dh: &[u8],
    enc: &[u8],
    recipient: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SpaceKemError> {
    let suite_id = kem_suite_id();
    let eae_prk = labeled_extract(&suite_id, &[], "eae_prk", dh);
    let kem_context = [enc, recipient].concat();
    labeled_expand(
        &suite_id,
        &eae_prk,
        "shared_secret",
        &kem_context,
        SECRET_LENGTH,
    )
}

/// The base-mode key schedule context, with an empty pre-shared key.
fn key_schedule_context(info: &[u8]) -> Vec<u8> {
    let suite_id = hpke_suite_id();
    let psk_id_hash = labeled_extract(&suite_id, &[], "psk_id_hash", &[]);
    let info_hash = labeled_extract(&suite_id, &[], "info_hash", info);
    [&[MODE_BASE][..], &psk_id_hash, &info_hash].concat()
}

fn derive_exporter_secret(
    kem_secret: &[u8],
    context: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SpaceKemError> {
    let suite_id = hpke_suite_id();
    let secret = labeled_extract(&suite_id, kem_secret, "secret", &[]);
    labeled_expand(&suite_id, &secret, "exp", context, SECRET_LENGTH)
}

fn export(
    exporter_secret: &[u8],
    exporter_context: &[u8],
    length: usize,
) -> Result<Zeroizing<Vec<u8>>, SpaceKemError> {
    labeled_expand(
        &hpke_suite_id(),
        exporter_secret,
        "sec",
        exporter_context,
        length,
    )
}

fn derive_export(
    dh: &[u8],
    enc: &[u8],
    recipient: &[u8],
    info: &[u8],
    exporter_context: &[u8],
    length: usize,
) -> Result<Zeroizing<Vec<u8>>, SpaceKemError> {
    let kem_secret = kem_shared_secret(dh, enc, recipient)?;
    let exporter = derive_exporter_secret(&kem_secret, &key_schedule_context(info))?;
    export(&exporter, exporter_context, length)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    };
    use hmac::{Hmac, KeyInit, Mac};
    use serde_json::Value;
    use sha2::Sha256;

    const RFC_EXPORT: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/hpke-export-rfc.json");
    const ORACLE_EXPORT: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/hpke-export-oracle.json");
    const COMMIT_MAC: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/commit-mac.json");
    const KEM_KEYS: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/kem-keys.json");

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("fixture is json")
    }

    fn hex_bytes(text: &str) -> Vec<u8> {
        assert_eq!(text.len() % 2, 0);
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex digit"))
            .collect()
    }

    fn hex_of(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn text<'a>(value: &'a Value, field: &str) -> &'a str {
        value[field].as_str().expect("string field")
    }

    fn rfc_entry() -> Value {
        parse(RFC_EXPORT)["rfcEntry"].clone()
    }

    fn oracle_export() -> Value {
        parse(ORACLE_EXPORT)["oracleExport"].clone()
    }

    fn secret_key(hex: &str) -> SecretKey {
        SecretKey::from_slice(&hex_bytes(hex)).expect("valid P-256 scalar")
    }

    // Oracle vector: RFC 9180 export-only entry for DHKEM(P-256), HKDF-SHA256.
    #[test]
    fn the_rfc_export_only_entry_is_reproduced_step_by_step() {
        let entry = rfc_entry();
        let sender = secret_key(text(&entry, "skEm"));
        let recipient =
            PublicKey::from_sec1_bytes(&hex_bytes(text(&entry, "pkRm"))).expect("recipient point");
        let enc = uncompressed(&sender.public_key());
        assert_eq!(hex_of(&enc), text(&entry, "enc"));

        let dh = diffie_hellman(sender.to_nonzero_scalar(), recipient.as_affine());
        let kem_secret = kem_shared_secret(dh.raw_secret_bytes(), &enc, &uncompressed(&recipient))
            .expect("kem secret");
        assert_eq!(hex_of(&kem_secret), text(&entry, "shared_secret"));

        let info = hex_bytes(text(&entry, "info"));
        let context = key_schedule_context(&info);
        assert_eq!(hex_of(&context), text(&entry, "key_schedule_context"));
        let exporter = derive_exporter_secret(&kem_secret, &context).expect("exporter secret");
        assert_eq!(hex_of(&exporter), text(&entry, "exporter_secret"));

        let exports = entry["exports"].as_array().expect("exports");
        assert_eq!(exports.len(), 3);
        for export_case in exports {
            let context = hex_bytes(text(export_case, "exporter_context"));
            let length = export_case["L"].as_u64().expect("length") as usize;
            let exported = export(&exporter, &context, length).expect("export");
            assert_eq!(hex_of(&exported), text(export_case, "exported_value"));
        }
    }

    // Oracle vector: the same entry from the recipient's side.
    #[test]
    fn the_rfc_entry_derives_the_same_exports_from_the_recipient_side() {
        let entry = rfc_entry();
        let recipient = secret_key(text(&entry, "skRm"));
        let enc = hex_bytes(text(&entry, "enc"));
        let sender_public = PublicKey::from_sec1_bytes(&enc).expect("enc point");

        let dh = diffie_hellman(recipient.to_nonzero_scalar(), sender_public.as_affine());
        let info = hex_bytes(text(&entry, "info"));
        for export_case in entry["exports"].as_array().expect("exports") {
            let context = hex_bytes(text(export_case, "exporter_context"));
            let length = export_case["L"].as_u64().expect("length") as usize;
            let exported = derive_export(
                dh.raw_secret_bytes(),
                &enc,
                &uncompressed(&recipient.public_key()),
                &info,
                &context,
                length,
            )
            .expect("derivation");
            assert_eq!(hex_of(&exported), text(export_case, "exported_value"));
        }
    }

    #[test]
    fn an_export_longer_than_hkdf_allows_is_an_error() {
        let exporter_secret = [7_u8; 32];
        assert_eq!(
            export(&exporter_secret, &[], 255 * 32 + 1).err(),
            Some(SpaceKemError::Derivation)
        );
    }

    // Oracle vector: values made by the pinned package's decapsulate.
    #[test]
    fn the_oracle_key_share_and_secret_are_reproduced() {
        let export = oracle_export();
        let author = AuthorKemKey::from_did_key(text(&export, "authorKemDid")).expect("author key");
        let ephemeral = hex_bytes(text(&export["ephemeralPrivateKey"], "value"));

        let request = encapsulate_with_ephemeral_key(&author, &ephemeral).expect("encapsulation");

        assert_eq!(request.key_share(), text(&export, "keyShareDid"));
        assert_eq!(
            STANDARD.encode(request.secret()),
            text(&export["sharedSecret"], "value")
        );
    }

    // Oracle vector: the oracle's decapsulate side, from the author's private key.
    #[test]
    fn decapsulating_the_oracle_key_share_gives_the_oracle_secret() {
        let export = oracle_export();
        let author = secret_key(text(&export["authorKemPrivateKey"], "value"));

        let request = decapsulate(&author, text(&export, "keyShareDid")).expect("decapsulation");

        assert_eq!(request.key_share(), text(&export, "keyShareDid"));
        assert_eq!(
            STANDARD.encode(request.secret()),
            text(&export["sharedSecret"], "value")
        );
    }

    // Cross-check: the oracle's MAC verifies under the secret this code derives.
    #[test]
    fn the_secret_derived_here_reproduces_the_oracle_commit_mac() {
        let export = oracle_export();
        let author = AuthorKemKey::from_did_key(text(&export, "authorKemDid")).expect("author key");
        let ephemeral = hex_bytes(text(&export["ephemeralPrivateKey"], "value"));
        let request = encapsulate_with_ephemeral_key(&author, &ephemeral).expect("encapsulation");

        let headers = &parse(COMMIT_MAC)["headers"];
        let params = text(headers, "signature-input")
            .strip_prefix("mac=")
            .expect("label");
        let base = format!(
            "\"atproto-space-commit\";sf: {}\n\"@signature-params\": {params}",
            text(headers, "atproto-space-commit")
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(request.secret()).expect("hmac key");
        mac.update(base.as_bytes());

        let expected = text(headers, "signature")
            .strip_prefix("mac=:")
            .and_then(|rest| rest.strip_suffix(':'))
            .expect("signature field");
        assert_eq!(STANDARD.encode(mac.finalize().into_bytes()), expected);
    }

    #[test]
    fn two_encapsulations_give_different_key_shares_and_secrets() {
        let author =
            AuthorKemKey::from_did_key(text(&oracle_export(), "authorKemDid")).expect("author key");

        let first = encapsulate(&author).expect("first");
        let second = encapsulate(&author).expect("second");

        assert_ne!(first.key_share(), second.key_share());
        assert_ne!(first.secret(), second.secret());
        assert!(first.key_share().starts_with("did:key:zDn"));
    }

    #[test]
    fn a_fresh_key_share_lets_the_author_derive_the_same_secret() {
        let export = oracle_export();
        let author_private = secret_key(text(&export["authorKemPrivateKey"], "value"));
        let author = AuthorKemKey::from_did_key(text(&export, "authorKemDid")).expect("author key");

        let request = encapsulate(&author).expect("encapsulation");
        let author_side = decapsulate(&author_private, request.key_share()).expect("decapsulation");

        assert_eq!(request.secret(), author_side.secret());
    }

    #[test]
    fn debug_output_shows_neither_the_secret_nor_any_private_key() {
        let export = oracle_export();
        let author = AuthorKemKey::from_did_key(text(&export, "authorKemDid")).expect("author key");
        let ephemeral = hex_bytes(text(&export["ephemeralPrivateKey"], "value"));
        let request = encapsulate_with_ephemeral_key(&author, &ephemeral).expect("encapsulation");
        let secret = *request.secret();

        let shown = [format!("{request:?}"), format!("{request:#?}")];

        let decimal_list = secret
            .iter()
            .map(|byte| byte.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let leaks = [
            hex_of(&secret),
            hex_of(&secret).to_uppercase(),
            STANDARD.encode(secret),
            STANDARD_NO_PAD.encode(secret),
            URL_SAFE.encode(secret),
            URL_SAFE_NO_PAD.encode(secret),
            decimal_list,
            hex_of(&ephemeral),
        ];
        for output in &shown {
            for leak in &leaks {
                assert!(!output.contains(leak.as_str()), "{output} shows {leak}");
            }
            assert!(output.contains(request.key_share()));
        }
    }

    #[test]
    fn an_author_key_is_the_same_in_compressed_and_uncompressed_form() {
        let export = oracle_export();
        let private = secret_key(text(&export["authorKemPrivateKey"], "value"));
        let point = private.public_key();

        let compressed = AuthorKemKey::from_sec1_bytes(point.to_sec1_point(true).as_bytes())
            .expect("compressed");
        let full = AuthorKemKey::from_sec1_bytes(&uncompressed(&point)).expect("uncompressed");

        assert_eq!(compressed, full);
        assert_eq!(compressed.did_key(), text(&export, "authorKemDid"));
    }

    #[test]
    fn an_author_key_that_is_not_a_p256_point_is_refused() {
        let mut off_curve = uncompressed(&secret_key(&"22".repeat(32)).public_key());
        off_curve[64] ^= 1;
        let truncated = &off_curve[..40];

        for bytes in [&off_curve[..], truncated, &[0_u8][..], &[][..]] {
            assert_eq!(
                AuthorKemKey::from_sec1_bytes(bytes).err(),
                Some(SpaceKemError::InvalidKey)
            );
        }
    }

    // Oracle vector: key encodings made by the oracle's crypto package.
    #[test]
    fn multikeys_from_the_kem_key_fixture_are_read_or_refused_as_the_oracle_does() {
        let fixture = parse(KEM_KEYS);
        let case = |name: &str| -> Value {
            fixture["cases"]
                .as_array()
                .expect("cases")
                .iter()
                .find(|candidate| candidate["name"] == name)
                .expect("named case")
                .clone()
        };
        let multibase = |case: &Value| -> String {
            case["document"]["verificationMethod"][0]["publicKeyMultibase"]
                .as_str()
                .expect("multibase")
                .to_string()
        };

        let relative = case("a Multikey method with a relative id");
        let key = AuthorKemKey::from_multikey(&multibase(&relative)).expect("multikey");
        assert_eq!(key.did_key(), text(&relative["expected"], "kemKey"));

        for name in [
            "a KEM method holding a secp256k1 key",
            "a Multikey with a malformed multibase string",
        ] {
            assert_eq!(
                AuthorKemKey::from_multikey(&multibase(&case(name))).err(),
                Some(SpaceKemError::InvalidKey),
                "{name}"
            );
        }
        assert_eq!(
            AuthorKemKey::from_did_key("did:web:bebop.example").err(),
            Some(SpaceKemError::InvalidKey)
        );
    }
}
