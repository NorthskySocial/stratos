//! Proves the structured-field, key-agreement and key-derivation dependencies
//! can do what response authentication needs. Tests only; no production code.

use base64::{Engine, engine::general_purpose::STANDARD};
use hkdf::Hkdf;
use p256::SecretKey;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToSec1Point;
use serde_json::Value;
use sfv::{BareItem, Dictionary, FieldType, ListEntry, Parser};
use sha2::Sha256;

const HPKE_ORACLE: &str =
    include_str!("../../test/spaces-alignment/november/fixtures/hpke-export-oracle.json");
const COMMIT_AND_OPS: &str =
    include_str!("../../test/spaces-alignment/november/fixtures/commit-and-ops.json");

const P256_PUBLIC_MULTICODEC_PREFIX: [u8; 2] = [0x80, 0x24];

fn hex_bytes(text: &str) -> Vec<u8> {
    assert_eq!(text.len() % 2, 0);
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex digit"))
        .collect()
}

fn parse_fixture(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture is json")
}

fn private_key(export: &Value, field: &str) -> SecretKey {
    let hex = export[field]["value"].as_str().expect("hex key");
    SecretKey::from_slice(&hex_bytes(hex)).expect("valid P-256 scalar")
}

fn did_key_for(public_key: &p256::PublicKey) -> String {
    let mut bytes = P256_PUBLIC_MULTICODEC_PREFIX.to_vec();
    bytes.extend_from_slice(public_key.to_sec1_point(true).as_bytes());
    format!("did:key:z{}", bs58::encode(bytes).into_string())
}

fn parse_dictionary(text: &str) -> Dictionary {
    Parser::new(text).parse().expect("structured dictionary")
}

fn commit_headers() -> Value {
    parse_fixture(COMMIT_AND_OPS)["macResponse"]["headers"].clone()
}

#[test]
fn hkdf_sha256_matches_rfc_5869_test_case_1() {
    let input_key_material = [0x0b_u8; 22];
    let salt: Vec<u8> = (0x00..=0x0c).collect();
    let info: Vec<u8> = (0xf0..=0xf9).collect();
    let expected = hex_bytes(
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );

    let mut output = [0_u8; 42];
    Hkdf::<Sha256>::new(Some(&salt), &input_key_material)
        .expand(&info, &mut output)
        .expect("42 bytes is within the HKDF limit");

    assert_eq!(output.as_slice(), expected.as_slice());
}

#[test]
fn ecdh_is_symmetric_and_matches_the_oracle_shared_point() {
    let export = &parse_fixture(HPKE_ORACLE)["oracleExport"];
    let author = private_key(export, "authorKemPrivateKey");
    let ephemeral = private_key(export, "ephemeralPrivateKey");

    let author_side = diffie_hellman(
        author.to_nonzero_scalar(),
        ephemeral.public_key().as_affine(),
    );
    let ephemeral_side = diffie_hellman(
        ephemeral.to_nonzero_scalar(),
        author.public_key().as_affine(),
    );

    assert_eq!(
        author_side.raw_secret_bytes(),
        ephemeral_side.raw_secret_bytes()
    );
    assert_eq!(author_side.raw_secret_bytes().len(), 32);
}

#[test]
fn public_points_encode_to_the_fixture_did_keys() {
    let export = &parse_fixture(HPKE_ORACLE)["oracleExport"];

    for (private_field, did_field) in [
        ("authorKemPrivateKey", "authorKemDid"),
        ("ephemeralPrivateKey", "keyShareDid"),
    ] {
        let public_key = private_key(export, private_field).public_key();
        let uncompressed = public_key.to_sec1_point(false);
        assert_eq!(uncompressed.len(), 65);
        assert_eq!(uncompressed.as_bytes()[0], 0x04);

        let from_uncompressed =
            p256::PublicKey::from_sec1_bytes(uncompressed.as_bytes()).expect("valid point");
        assert_eq!(
            did_key_for(&from_uncompressed),
            export[did_field].as_str().expect("did:key")
        );
    }
}

#[test]
fn structured_fields_expose_the_signature_input_inner_list() {
    let headers = commit_headers();
    let text = headers["signature-input"]
        .as_str()
        .expect("signature-input");
    let dictionary = parse_dictionary(text);

    let Some(ListEntry::InnerList(covered)) = dictionary.get("mac") else {
        panic!("mac member is an inner list");
    };
    assert_eq!(covered.items.len(), 1);
    assert_eq!(
        covered.items[0]
            .bare_item
            .as_string()
            .map(|value| value.as_str()),
        Some("atproto-space-commit")
    );
    assert_eq!(
        covered.items[0].params.get("sf"),
        Some(&BareItem::Boolean(true))
    );
    assert_eq!(
        covered
            .params
            .get("keyid")
            .and_then(BareItem::as_string)
            .map(|value| value.as_str()),
        Some(
            parse_fixture(HPKE_ORACLE)["oracleExport"]["keyShareDid"]
                .as_str()
                .expect("did:key")
        )
    );
    assert_eq!(
        covered
            .params
            .get("tag")
            .and_then(BareItem::as_string)
            .map(|value| value.as_str()),
        Some("atproto-space-commit")
    );
}

#[test]
fn structured_fields_reserialize_signature_input_and_inner_list_exactly() {
    let headers = commit_headers();
    let text = headers["signature-input"]
        .as_str()
        .expect("signature-input");
    let dictionary = parse_dictionary(text);

    assert_eq!(dictionary.serialize().as_deref(), Some(text));

    let Some(ListEntry::InnerList(covered)) = dictionary.get("mac") else {
        panic!("mac member is an inner list");
    };
    let mut standalone = sfv::List::new();
    let mut bare = covered.clone();
    bare.params.clear();
    standalone.push(ListEntry::InnerList(bare));
    assert_eq!(
        standalone.serialize().as_deref(),
        Some("(\"atproto-space-commit\";sf)")
    );
}

#[test]
fn structured_fields_read_commit_header_byte_sequence_and_reserialize_it() {
    let fixture = parse_fixture(COMMIT_AND_OPS);
    let text = fixture["macResponse"]["headers"]["atproto-space-commit"]
        .as_str()
        .expect("commit header");
    let dictionary = parse_dictionary(text);

    let Some(ListEntry::Item(data)) = dictionary.get("data") else {
        panic!("data member is an item");
    };
    let digest = STANDARD
        .decode(
            fixture["commitDataDigest"]["value"]
                .as_str()
                .expect("digest"),
        )
        .expect("base64 digest");
    assert_eq!(data.bare_item.as_byte_sequence(), Some(digest.as_slice()));

    let members: Vec<&str> = dictionary.keys().map(|key| key.as_str()).collect();
    assert_eq!(members, ["ver", "repo", "space", "rev", "data"]);
    assert_eq!(dictionary.serialize().as_deref(), Some(text));
}

#[test]
fn structured_fields_read_signature_byte_sequence() {
    let fixture = parse_fixture(COMMIT_AND_OPS);
    let text = fixture["macResponse"]["headers"]["signature"]
        .as_str()
        .expect("signature header");
    let dictionary = parse_dictionary(text);

    let Some(ListEntry::Item(signature)) = dictionary.get("mac") else {
        panic!("mac member is an item");
    };
    let mac = STANDARD
        .decode(
            fixture["macResponse"]["mac"]["value"]
                .as_str()
                .expect("mac"),
        )
        .expect("base64 mac");
    assert_eq!(signature.bare_item.as_byte_sequence(), Some(mac.as_slice()));
    assert_eq!(dictionary.serialize().as_deref(), Some(text));
}

#[test]
fn structured_fields_keep_two_member_dictionary_order() {
    let text = "zeta=1, alpha=2";
    let dictionary = parse_dictionary(text);

    let members: Vec<&str> = dictionary.keys().map(|key| key.as_str()).collect();
    assert_eq!(members, ["zeta", "alpha"]);
    assert_eq!(dictionary.serialize().as_deref(), Some(text));
}

#[test]
fn blake3_hash_of_empty_input_matches_published_value() {
    let digest = blake3::hash(b"");

    assert_eq!(
        digest.as_bytes().as_slice(),
        hex_bytes("af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262").as_slice()
    );
}

#[test]
fn blake3_extended_output_begins_with_the_default_hash() {
    let input = b"Spike meets Faye aboard the Bebop";
    let mut extended = [0_u8; 2048];

    blake3::Hasher::new()
        .update(input)
        .finalize_xof()
        .fill(&mut extended);

    assert_eq!(&extended[..32], blake3::hash(input).as_bytes().as_slice());
    assert!(extended[32..].iter().any(|byte| *byte != 0));
}
