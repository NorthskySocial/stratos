//! Canonical encoding of a space record and its CID, so the record a host sent
//! as JSON can be proved to be the one its commit covers. The encoder is
//! written here and judged byte for byte against the pinned upstream
//! `@atproto/lex-json` reader and `@atproto/lex-cbor` encoder (fixture
//! `record-cid.json` and an edge table in the tests); it refuses on purpose
//! what that pair accepts and Stratos does not, and the fixture or the table
//! labels each such input. Nothing here is called by the synchronizer yet.

use std::fmt;

use base64::{
    Engine,
    alphabet::STANDARD,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use cid::Cid;
use multihash::Multihash;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

pub const MAX_RECORD_NESTING: usize = 32;
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;

// JavaScript's Number.MAX_SAFE_INTEGER: the largest magnitude the upstream
// data model holds as an integer.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
const LINK_KEY: &str = "$link";
const BYTES_KEY: &str = "$bytes";
// The upstream JSON reader refuses this key at any depth, so a record holding
// it has no upstream CID to be checked against.
const PROTO_KEY: &str = "__proto__";
const CID_TAG: u64 = 42;
const MULTIBASE_IDENTITY_PREFIX: u8 = 0x00;
const DAG_CBOR_CODEC: u64 = 0x71;
const SHA2_256_CODE: u64 = 0x12;
// Base58 decoding is quadratic, so the text of a CID is bounded before parsing,
// as the upstream parser bounds it.
const MAX_CID_TEXT_BYTES: usize = 128;

const MAJOR_UNSIGNED: u8 = 0;
const MAJOR_NEGATIVE: u8 = 1;
const MAJOR_BYTES: u8 = 2;
const MAJOR_TEXT: u8 = 3;
const MAJOR_ARRAY: u8 = 4;
const MAJOR_MAP: u8 = 5;
const MAJOR_TAG: u8 = 6;
const SIMPLE_FALSE: u8 = 0xf4;
const SIMPLE_TRUE: u8 = 0xf5;
const SIMPLE_NULL: u8 = 0xf6;

// Standard alphabet; bits after the last whole byte must be zero so that one
// byte string has one text. Padding is absent or exact: upstream reads short
// padding as bytes on some runtimes and as a plain map on others, so such a
// text names no one record.
const UNPADDED_BYTES_DECODER: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::RequireNone),
);
const PADDED_BYTES_DECODER: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordRefusal {
    NumberNotAnInteger,
    IntegerOutOfRange,
    InvalidLink,
    InvalidBytes,
    ProtoKey,
    TooDeep,
    TooLarge,
}

impl fmt::Display for RecordRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NumberNotAnInteger => "a number is written with a fraction or an exponent",
            Self::IntegerOutOfRange => "an integer is outside the safe integer range",
            Self::InvalidLink => "a $link is not the canonical text of a CID",
            Self::InvalidBytes => "a $bytes is not standard base64",
            Self::ProtoKey => "a map has the key __proto__",
            Self::TooDeep => "the record is nested too deeply",
            Self::TooLarge => "the encoded record is too large",
        })
    }
}

impl std::error::Error for RecordRefusal {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CidTextRefusal {
    NotACid,
    NotCanonical,
    NamesAnotherCid,
}

impl fmt::Display for CidTextRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NotACid => "the text is not a CID",
            Self::NotCanonical => "the text is not the canonical text of its CID",
            Self::NamesAnotherCid => "the text names another CID",
        })
    }
}

impl std::error::Error for CidTextRefusal {}

/// The canonical DAG-CBOR bytes of a record read from JSON, or the reason
/// Stratos will not encode it.
pub fn encode_record(record: &Value) -> Result<Vec<u8>, RecordRefusal> {
    let mut encoded = Vec::new();
    encode_value(record, 0, &mut encoded)?;
    Ok(encoded)
}

/// The CID of encoded record bytes: version 1, DAG-CBOR, SHA-256.
pub fn record_cid(encoded: &[u8]) -> Cid {
    let digest = Sha256::digest(encoded);
    let multihash = Multihash::<64>::wrap(SHA2_256_CODE, &digest)
        .expect("a 32 byte digest fits a 64 byte multihash");
    Cid::new_v1(DAG_CBOR_CODEC, multihash)
}

/// Whether `text` is the canonical text of exactly the CID `expected`.
pub fn check_cid_text(text: &str, expected: &Cid) -> Result<(), CidTextRefusal> {
    let parsed = parse_cid(text).ok_or(CidTextRefusal::NotACid)?;
    if parsed.to_string() != text {
        return Err(CidTextRefusal::NotCanonical);
    }
    if &parsed != expected {
        return Err(CidTextRefusal::NamesAnotherCid);
    }
    Ok(())
}

fn parse_cid(text: &str) -> Option<Cid> {
    if text.len() > MAX_CID_TEXT_BYTES {
        return None;
    }
    Cid::try_from(text).ok()
}

fn encode_value(value: &Value, depth: usize, out: &mut Vec<u8>) -> Result<(), RecordRefusal> {
    match value {
        Value::Null => out.push(SIMPLE_NULL),
        Value::Bool(true) => out.push(SIMPLE_TRUE),
        Value::Bool(false) => out.push(SIMPLE_FALSE),
        Value::Number(number) => encode_integer(number, out)?,
        Value::String(text) => write_head_and_payload(MAJOR_TEXT, text.as_bytes(), out),
        Value::Array(items) => {
            let inside = enter_container(depth)?;
            write_head(MAJOR_ARRAY, items.len() as u64, out);
            for item in items {
                encode_value(item, inside, out)?;
                check_size(out)?;
            }
        }
        Value::Object(map) => encode_map(map, depth, out)?,
    }
    check_size(out)
}

fn encode_map(
    map: &Map<String, Value>,
    depth: usize,
    out: &mut Vec<u8>,
) -> Result<(), RecordRefusal> {
    if let Some(link_text) = only_member(map, LINK_KEY) {
        return encode_link(link_text, out);
    }
    if let Some(bytes_text) = only_member(map, BYTES_KEY) {
        return encode_byte_string(bytes_text, out);
    }
    let inside = enter_container(depth)?;
    let mut members: Vec<(&String, &Value)> = map.iter().collect();
    members.sort_by(|(left, _), (right, _)| {
        left.len()
            .cmp(&right.len())
            .then_with(|| left.as_bytes().cmp(right.as_bytes()))
    });
    write_head(MAJOR_MAP, members.len() as u64, out);
    for (key, member) in members {
        if key == PROTO_KEY {
            return Err(RecordRefusal::ProtoKey);
        }
        write_head_and_payload(MAJOR_TEXT, key.as_bytes(), out);
        encode_value(member, inside, out)?;
        check_size(out)?;
    }
    Ok(())
}

// A map whose only member is `key` with a text value; any other shape is an
// ordinary map.
fn only_member<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    if map.len() != 1 {
        return None;
    }
    map.get(key).and_then(Value::as_str)
}

fn encode_link(text: &str, out: &mut Vec<u8>) -> Result<(), RecordRefusal> {
    let link = parse_cid(text)
        .filter(|parsed| parsed.to_string() == text)
        .ok_or(RecordRefusal::InvalidLink)?;
    let mut payload = vec![MULTIBASE_IDENTITY_PREFIX];
    payload.extend_from_slice(&link.to_bytes());
    write_head(MAJOR_TAG, CID_TAG, out);
    write_head_and_payload(MAJOR_BYTES, &payload, out);
    Ok(())
}

fn encode_byte_string(text: &str, out: &mut Vec<u8>) -> Result<(), RecordRefusal> {
    let decoder = if text.ends_with('=') {
        &PADDED_BYTES_DECODER
    } else {
        &UNPADDED_BYTES_DECODER
    };
    let bytes = decoder
        .decode(text)
        .map_err(|_| RecordRefusal::InvalidBytes)?;
    write_head_and_payload(MAJOR_BYTES, &bytes, out);
    Ok(())
}

fn encode_integer(number: &Number, out: &mut Vec<u8>) -> Result<(), RecordRefusal> {
    let integer = if let Some(unsigned) = number.as_u64() {
        i64::try_from(unsigned).map_err(|_| RecordRefusal::IntegerOutOfRange)?
    } else if let Some(signed) = number.as_i64() {
        signed
    } else {
        return Err(RecordRefusal::NumberNotAnInteger);
    };
    if integer.unsigned_abs() > MAX_SAFE_INTEGER.unsigned_abs() {
        return Err(RecordRefusal::IntegerOutOfRange);
    }
    if integer >= 0 {
        write_head(MAJOR_UNSIGNED, integer.unsigned_abs(), out);
    } else {
        write_head(MAJOR_NEGATIVE, integer.unsigned_abs() - 1, out);
    }
    Ok(())
}

fn enter_container(depth: usize) -> Result<usize, RecordRefusal> {
    if depth >= MAX_RECORD_NESTING {
        return Err(RecordRefusal::TooDeep);
    }
    Ok(depth + 1)
}

fn check_size(out: &[u8]) -> Result<(), RecordRefusal> {
    if out.len() > MAX_RECORD_BYTES {
        return Err(RecordRefusal::TooLarge);
    }
    Ok(())
}

fn write_head_and_payload(major: u8, payload: &[u8], out: &mut Vec<u8>) {
    write_head(major, payload.len() as u64, out);
    out.extend_from_slice(payload);
}

// The shortest head for an argument, as the canonical form requires.
fn write_head(major: u8, argument: u64, out: &mut Vec<u8>) {
    let major_bits = major << 5;
    if argument < 24 {
        out.push(major_bits | argument as u8);
    } else if let Ok(one) = u8::try_from(argument) {
        out.extend_from_slice(&[major_bits | 24, one]);
    } else if let Ok(two) = u16::try_from(argument) {
        out.push(major_bits | 25);
        out.extend_from_slice(&two.to_be_bytes());
    } else if let Ok(four) = u32::try_from(argument) {
        out.push(major_bits | 26);
        out.extend_from_slice(&four.to_be_bytes());
    } else {
        out.push(major_bits | 27);
        out.extend_from_slice(&argument.to_be_bytes());
    }
}

/// Records and values Stratos computed for fixed inputs. The upstream package
/// is run over the same inputs by the fixture generator; a fixture test then
/// requires its answers to equal these constants.
#[cfg(test)]
pub(crate) mod cross_check_inputs {
    pub(crate) const POST_JSON: &str =
        r#"{"$type":"zone.stratos.feed.post","text":"Whatever happens, happens"}"#;
    pub(crate) const FOLLOW_JSON: &str = r#"{"$type":"app.bsky.graph.follow","subject":"did:plc:spikespiegel","createdAt":"2026-09-22T00:00:00.000Z"}"#;
    pub(crate) const LINKED_JSON: &str = r#"{"$type":"zone.stratos.feed.post","text":"Ein","embed":{"image":{"$type":"blob","ref":{"$link":"bafkreicmhqydaeykjinrosvewdw2dkzg6gwayo4i3d5tbyav4mls6nlica"},"mimeType":"image/png","size":3},"thumb":{"$bytes":"AQID"}}}"#;
    pub(crate) const POST_CID: &str = "bafyreicy76sh4fkqtlr7dmtiakbzpfqhvcsx36lf26eifaplxgl5abq2fq";
    pub(crate) const FOLLOW_CID: &str =
        "bafyreigoyb4wgujzkp5jj6l4fiduaefr5hkjfcjwc7tgwbrrfkol4ur22m";
    pub(crate) const LINKED_CID: &str =
        "bafyreiamr44qnmy5gt77wtssi7svuhexyfxffcqhn2mgzrfdqb7fi4lrgi";
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORD_CID: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/record-cid.json");

    enum Oracle {
        Accepted { bytes_hex: String, cid: String },
        Refused,
    }

    fn fixture() -> Value {
        serde_json::from_str(RECORD_CID).expect("fixture is json")
    }

    fn oracle_outcome(text: &str) -> Oracle {
        match text.strip_prefix("accepted ") {
            Some(rest) => {
                let (bytes_hex, cid) = rest.split_once(' ').expect("bytes and cid");
                Oracle::Accepted {
                    bytes_hex: bytes_hex.to_owned(),
                    cid: cid.to_owned(),
                }
            }
            None => {
                assert!(text.starts_with("refused: "), "{text}");
                Oracle::Refused
            }
        }
    }

    fn hex_of(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    // Stratos reads the text a host sent; a text serde_json will not read is a
    // refusal too.
    fn encode_text(text: &str) -> Result<Vec<u8>, String> {
        let record: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
        encode_record(&record).map_err(|refusal| refusal.to_string())
    }

    fn rows(section: &str) -> Vec<Value> {
        fixture()[section].as_array().expect("rows").clone()
    }

    fn assert_equals_oracle(name: &str, text: &str, oracle: &Oracle) {
        match (oracle, encode_text(text)) {
            (Oracle::Accepted { bytes_hex, cid }, Ok(bytes)) => {
                assert_eq!(&hex_of(&bytes), bytes_hex, "{name}: bytes");
                assert_eq!(&record_cid(&bytes).to_string(), cid, "{name}: cid");
            }
            (Oracle::Accepted { .. }, Err(reason)) => {
                panic!("{name}: the oracle accepts it, Stratos refused: {reason}")
            }
            (Oracle::Refused, Ok(_)) => panic!("{name}: the oracle refuses it, Stratos accepted"),
            (Oracle::Refused, Err(_)) => {}
        }
    }

    // Oracle vectors.

    #[test]
    fn every_record_gives_the_oracle_bytes_and_cid() {
        let records = rows("records");
        assert!(records.len() >= 14);
        for row in &records {
            let name = row["name"].as_str().expect("name");
            let oracle = oracle_outcome(row["oracle"].as_str().expect("oracle"));
            assert!(matches!(oracle, Oracle::Accepted { .. }), "{name}");
            assert_equals_oracle(name, row["json"].as_str().expect("json"), &oracle);
        }
    }

    #[test]
    fn every_edge_input_gets_the_oracle_verdict_and_bytes() {
        let edge = rows("edge");
        assert!(edge.len() >= 14);
        for row in &edge {
            let name = row["name"].as_str().expect("name");
            let oracle = oracle_outcome(row["oracle"].as_str().expect("oracle"));
            assert_equals_oracle(name, row["json"].as_str().expect("json"), &oracle);
        }
    }

    #[test]
    fn every_stricter_input_is_refused_although_the_oracle_accepts_it() {
        let stricter = rows("stricter");
        assert!(stricter.len() >= 11);
        for row in &stricter {
            let name = row["name"].as_str().expect("name");
            assert!(matches!(
                oracle_outcome(row["oracle"].as_str().expect("oracle")),
                Oracle::Accepted { .. }
            ));
            assert_eq!(row["expectedStratos"], "refused", "{name}");
            assert!(
                encode_text(row["json"].as_str().expect("json")).is_err(),
                "{name}: Stratos accepted it"
            );
        }
    }

    #[test]
    fn a_received_cid_string_must_be_canonical_text_naming_the_record_cid() {
        let fixture = fixture();
        let canonical = fixture["cidStrings"][0]["text"].as_str().expect("text");
        let expected = Cid::try_from(canonical).expect("canonical cid");
        for row in fixture["cidStrings"].as_array().expect("rows") {
            let name = row["name"].as_str().expect("name");
            let text = row["text"].as_str().expect("text");
            let outcome = check_cid_text(text, &expected);
            if text == canonical {
                assert_eq!(outcome, Ok(()), "{name}");
            } else {
                assert!(outcome.is_err(), "{name}");
            }
        }
    }

    #[test]
    fn a_canonical_cid_string_of_another_cid_is_refused_as_naming_another() {
        let fixture = fixture();
        let expected = Cid::try_from(fixture["cidStrings"][0]["text"].as_str().expect("text"))
            .expect("canonical cid");
        let other = record_cid(b"Ed");
        assert_eq!(
            check_cid_text(&other.to_string(), &expected),
            Err(CidTextRefusal::NamesAnotherCid)
        );
        assert_eq!(
            check_cid_text(
                fixture["cidStrings"][1]["text"].as_str().expect("text"),
                &expected
            ),
            Err(CidTextRefusal::NotCanonical)
        );
        assert_eq!(
            check_cid_text("bafyreih2", &expected),
            Err(CidTextRefusal::NotACid)
        );
    }

    // Cross-check: the CID is the CID of the bytes, whatever made them.

    #[test]
    fn a_record_cid_is_version_one_dag_cbor_sha_256_of_the_bytes() {
        use sha2::{Digest, Sha256};
        let bytes = encode_text(r#"{"text":"Bark"}"#).expect("encodes");
        let cid = record_cid(&bytes);
        assert_eq!(cid.version(), cid::Version::V1);
        assert_eq!(cid.codec(), 0x71);
        assert_eq!(cid.hash().code(), 0x12);
        assert_eq!(cid.hash().digest(), &Sha256::digest(&bytes)[..]);
    }

    #[test]
    fn the_encoding_does_not_depend_on_the_order_of_keys_in_the_text() {
        let mut generator = Lcg(0x5eed_0043);
        for row in rows("records") {
            let record: Value =
                serde_json::from_str(row["json"].as_str().expect("json")).expect("json");
            let expected = encode_record(&record).expect("encodes");
            for _ in 0..8 {
                let shuffled = shuffled_text(&record, &mut generator);
                assert_eq!(
                    encode_text(&shuffled).expect("encodes"),
                    expected,
                    "{}: {shuffled}",
                    row["name"]
                );
            }
        }
    }

    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from((self.0 >> 33) % bound as u64).expect("fits")
        }
    }

    fn shuffled_text(value: &Value, generator: &mut Lcg) -> String {
        match value {
            Value::Object(map) => {
                let mut entries: Vec<_> = map.iter().collect();
                for at in (1..entries.len()).rev() {
                    entries.swap(at, generator.below(at + 1));
                }
                let members: Vec<String> = entries
                    .into_iter()
                    .map(|(key, member)| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).expect("key"),
                            shuffled_text(member, generator)
                        )
                    })
                    .collect();
                format!("{{{}}}", members.join(","))
            }
            Value::Array(items) => {
                let members: Vec<String> = items
                    .iter()
                    .map(|item| shuffled_text(item, generator))
                    .collect();
                format!("[{}]", members.join(","))
            }
            scalar => scalar.to_string(),
        }
    }

    // Limits, built here because the oracle has none.

    fn nested_arrays(containers_inside_the_map: usize) -> Value {
        let mut value = Value::Array(Vec::new());
        for _ in 1..containers_inside_the_map {
            value = Value::Array(vec![value]);
        }
        serde_json::json!({ "a": value })
    }

    #[test]
    fn nesting_of_thirty_two_containers_is_accepted_and_thirty_three_refused() {
        assert!(encode_record(&nested_arrays(MAX_RECORD_NESTING - 1)).is_ok());
        assert_eq!(
            encode_record(&nested_arrays(MAX_RECORD_NESTING)),
            Err(RecordRefusal::TooDeep)
        );
    }

    fn record_with_text_filling(total: usize) -> Value {
        // A map head, the one-byte key and a five-byte text head come first.
        let overhead = 1 + 2 + 5;
        serde_json::json!({ "s": "a".repeat(total - overhead) })
    }

    #[test]
    fn a_record_of_exactly_one_mebibyte_is_accepted_and_one_byte_more_refused() {
        let at_limit = encode_record(&record_with_text_filling(MAX_RECORD_BYTES)).expect("fits");
        assert_eq!(at_limit.len(), MAX_RECORD_BYTES);
        assert_eq!(
            encode_record(&record_with_text_filling(MAX_RECORD_BYTES + 1)),
            Err(RecordRefusal::TooLarge)
        );
    }

    #[test]
    fn each_refusal_names_what_was_refused() {
        let cases = [
            (r#"{"a":1.5}"#, RecordRefusal::NumberNotAnInteger),
            (r#"{"a":1.0}"#, RecordRefusal::NumberNotAnInteger),
            (r#"{"a":1e2}"#, RecordRefusal::NumberNotAnInteger),
            (
                r#"{"a":9007199254740992}"#,
                RecordRefusal::IntegerOutOfRange,
            ),
            (
                r#"{"a":-9007199254740992}"#,
                RecordRefusal::IntegerOutOfRange,
            ),
            (
                r#"{"a":18446744073709551615}"#,
                RecordRefusal::IntegerOutOfRange,
            ),
            (r#"{"$link":"not a cid"}"#, RecordRefusal::InvalidLink),
            (r#"{"$bytes":"!"}"#, RecordRefusal::InvalidBytes),
        ];
        for (text, refusal) in cases {
            let record: Value = serde_json::from_str(text).expect("json");
            assert_eq!(encode_record(&record), Err(refusal), "{text}");
        }
    }

    #[test]
    fn the_safe_integer_range_is_accepted_at_both_ends() {
        for (text, expected) in [
            (r#"{"a":9007199254740991}"#, "a161611b001fffffffffffff"),
            (r#"{"a":-9007199254740991}"#, "a161613b001ffffffffffffe"),
        ] {
            assert_eq!(hex_of(&encode_text(text).expect("encodes")), expected);
        }
    }

    // Oracle edge table: map keys and $link digests record-cid.json does not
    // cover. The oracle column is the pinned `@atproto/lex-json` reader (strict
    // false) and the `@atproto/space` serializeRecord the fixture's record family
    // uses, run on each json; `refused` is the error the oracle threw. With
    // strict true the oracle gives the same verdicts, except that it also
    // refuses the two links whose text is over 128 characters. `stratos` is the
    // refusal expected here, `None` meaning the oracle's bytes and CID.

    const SHA2_512_LINK: &str = "bafyrgqc3wqwziyct2yclud4vfzyd4vamosvv4n4sz5wwhmoz2tlazdyjp3a5ep2funhko7srcywsl5bpplgp2yug4nmk4txxi4xgvxfgnvhue";
    const IDENTITY_64_LINK: &str = "bafyqaqaaaebagbafaydqqcikbmga2dqpcaireeyuculbogazdinryhi6d4qccirdeqssmjzifevcwlbnfyxtamjsgm2dknrxha4tuoz4hu7d6";
    const IDENTITY_65_LINK: &str = "bafyqaqiaaebagbafaydqqcikbmga2dqpcaireeyuculbogazdinryhi6d4qccirdeqssmjzifevcwlbnfyxtamjsgm2dknrxha4tuoz4hu7d6qa";
    const IDENTITY_70_LINK: &str = "bafyqarqaaebagbafaydqqcikbmga2dqpcaireeyuculbogazdinryhi6d4qccirdeqssmjzifevcwlbnfyxtamjsgm2dknrxha4tuoz4hu7d6qcbijbuiri";
    const IDENTITY_76_LINK: &str = "bafyqataaaebagbafaydqqcikbmga2dqpcaireeyuculbogazdinryhi6d4qccirdeqssmjzifevcwlbnfyxtamjsgm2dknrxha4tuoz4hu7d6qcbijbuirkgi5eesssl";
    const IDENTITY_77_LINK: &str = "bafyqatiaaebagbafaydqqcikbmga2dqpcaireeyuculbogazdinryhi6d4qccirdeqssmjzifevcwlbnfyxtamjsgm2dknrxha4tuoz4hu7d6qcbijbuirkgi5eesssljq";
    const PROTO_REFUSED: &str = "refused: TypeError: Invalid key: __proto__";
    const DIGEST_OVER_64_BYTES: &str = "the CID type holds a digest of at most 64 bytes, and no record CID or blob reference a PDS writes has a longer one: both are SHA-256";
    const LINK_TEXT_OVER_128: &str = "the text is over the 128 characters both parsers allow a CID; the oracle then reads a plain map holding a $link text";

    struct EdgeRow {
        name: &'static str,
        json: String,
        oracle: &'static str,
        stratos: Option<RecordRefusal>,
        stricter_because: Option<&'static str>,
    }

    fn equal(name: &'static str, json: &str, oracle: &'static str) -> EdgeRow {
        EdgeRow {
            name,
            json: json.to_owned(),
            oracle,
            stratos: None,
            stricter_because: None,
        }
    }

    fn proto_refused(name: &'static str, json: &str) -> EdgeRow {
        EdgeRow {
            stratos: Some(RecordRefusal::ProtoKey),
            ..equal(name, json, PROTO_REFUSED)
        }
    }

    fn link_in_a_map(link: &str) -> String {
        format!(r#"{{"a":{{"$link":"{link}"}}}}"#)
    }

    fn stricter_link(
        name: &'static str,
        link: &str,
        oracle: &'static str,
        because: &'static str,
    ) -> EdgeRow {
        EdgeRow {
            stratos: Some(RecordRefusal::InvalidLink),
            stricter_because: Some(because),
            ..equal(name, &link_in_a_map(link), oracle)
        }
    }

    fn key_and_link_rows() -> Vec<EdgeRow> {
        vec![
            proto_refused("__proto__ at top level", r#"{"__proto__":1}"#),
            proto_refused("__proto__ in a nested map", r#"{"a":{"__proto__":1}}"#),
            proto_refused(
                "__proto__ in an array element",
                r#"{"a":[{"__proto__":1}]}"#,
            ),
            proto_refused(
                "__proto__ beside $link",
                r#"{"$link":"bafyreihypg3uvx3sc754r22emkw6ujpiqjozie6puum4ie4egt2jqxz6wa","__proto__":1}"#,
            ),
            proto_refused(
                "__proto__ beside $bytes",
                r#"{"$bytes":"AQID","__proto__":1}"#,
            ),
            proto_refused("__proto__ holding a map", r#"{"__proto__":{"a":1}}"#),
            proto_refused(
                "__proto__ beside $type",
                r#"{"$type":"zone.stratos.feed.post","__proto__":"x"}"#,
            ),
            proto_refused("__proto__ written with an escape", r#"{"__proto__":1}"#),
            equal(
                "__PROTO__ in uppercase",
                r#"{"__PROTO__":1}"#,
                "accepted a1695f5f50524f544f5f5f01 bafyreihtdfu4foc5m5xvrg2awep7klfcrvmigunfzhej5dseospuaeazvq",
            ),
            equal(
                "proto without underscores",
                r#"{"proto":1}"#,
                "accepted a16570726f746f01 bafyreigx3j63yu4gigcudpyihygsgpu2ujdyvrlicwhytz3hvkiy3lxi5u",
            ),
            equal(
                "constructor at top level",
                r#"{"constructor":1}"#,
                "accepted a16b636f6e7374727563746f7201 bafyreidzs23prirtkcwtl4t53thphkjcfvwpvvwhd2zkrl26wcfrnmm44u",
            ),
            equal(
                "constructor and prototype in a nested map",
                r#"{"a":{"constructor":{"prototype":1}}}"#,
                "accepted a16161a16b636f6e7374727563746f72a16970726f746f7479706501 bafyreiclsx3qamcetmexvvjmo5wxsr2756o76zzbdpqb3t52aat6sxqrom",
            ),
            equal(
                "prototype at top level",
                r#"{"prototype":1}"#,
                "accepted a16970726f746f7479706501 bafyreidp5dvclnzlmvfz745m2ndvahowhf2qkzfgzxmw6z5aqcrspyd5s4",
            ),
            equal(
                "the empty key",
                r#"{"":1}"#,
                "accepted a16001 bafyreicpenwudzeykexckbwbtymbw7276kmxqnhs4f36iko3nml2lyi5ne",
            ),
            equal(
                "the empty key in a nested map",
                r#"{"a":{"":1}}"#,
                "accepted a16161a16001 bafyreibvqxkrud365gj32ppn2p2rwa63k7pa3i54sfzpnlg635qno3dyj4",
            ),
            equal(
                "toString",
                r#"{"toString":1}"#,
                "accepted a168746f537472696e6701 bafyreicolcwd37uckrbkxz7zxel5p2kpr7aaz2233iohxwebskfl53pz4y",
            ),
            equal(
                "hasOwnProperty",
                r#"{"hasOwnProperty":1}"#,
                "accepted a16e6861734f776e50726f706572747901 bafyreifiihoup5dqayn6bcj7tl3vt4hodltw5jnqd3n7vwp5jy74zbhxne",
            ),
            equal(
                "a $link with a sha2-512 digest of 64 bytes",
                &link_in_a_map(SHA2_512_LINK),
                "accepted a16161d82a584500017113405bb42d946053d604ba0f952e703e540c74ab5e3792cf6d63b1d9d4d60c8f097ec1d23f45a34ea77e51162d25f42f7accfd6286e358ae4ef7472e6adca66d4f42 bafyreigel5ugvgfo7hyxyjabgionfhisrnmkbapmfsbfm7sokqgcoe7a6a",
            ),
            equal(
                "a $link with an identity digest of 64 bytes",
                &link_in_a_map(IDENTITY_64_LINK),
                "accepted a16161d82a58450001710040000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f bafyreidieqsj2an4s6whnn4iuvzvzbuo62a2tq3b4sljd3e4wxbaraxwzu",
            ),
            stricter_link(
                "a $link with an identity digest of 65 bytes",
                IDENTITY_65_LINK,
                "accepted a16161d82a58460001710041000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40 bafyreid3y7obxds3wudbqt5ziqt6jognw7yiub5lbiv5mofloacd3pbhvu",
                DIGEST_OVER_64_BYTES,
            ),
            stricter_link(
                "a $link with an identity digest of 70 bytes",
                IDENTITY_70_LINK,
                "accepted a16161d82a584b0001710046000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445 bafyreialxh5doqzc6pbwb6pmbq73lk5p435dzoogfvxbitwbj3yedqxmwm",
                DIGEST_OVER_64_BYTES,
            ),
            stricter_link(
                "a $link with an identity digest of 76 bytes",
                IDENTITY_76_LINK,
                "accepted a16161a165246c696e6b78816261667971617461616165626167626166617964717163696b626d676132647170636169726565797563756c626f67617a64696e72796869366434716363697264657173736d6a7a6966657663776c626e66797874616d6a73676d32646b6e727868613474756f7a346875376436716362696a627569726b67693565657373736c bafyreich37avrhxlubtpprvj2xpm4mzcmereyi2d4uesfekc5dwde4tjhq",
                LINK_TEXT_OVER_128,
            ),
            stricter_link(
                "a $link with an identity digest of 77 bytes",
                IDENTITY_77_LINK,
                "accepted a16161a165246c696e6b78836261667971617469616165626167626166617964717163696b626d676132647170636169726565797563756c626f67617a64696e72796869366434716363697264657173736d6a7a6966657663776c626e66797874616d6a73676d32646b6e727868613474756f7a346875376436716362696a627569726b67693565657373736c6a71 bafyreid3idptsdetepsy3kggaxbgotvebzxfqt7zunf67e4va7zls622du",
                LINK_TEXT_OVER_128,
            ),
        ]
    }

    // A labelled refusal is either equal (the oracle refuses too) or stricter
    // (the oracle accepts and the row says why); anything else is a
    // disagreement.
    fn disagreement(row: &EdgeRow) -> Option<String> {
        let record: Value = serde_json::from_str(&row.json).expect("json");
        let outcome = encode_record(&record);
        let oracle = oracle_outcome(row.oracle);
        let oracle_accepts = matches!(oracle, Oracle::Accepted { .. });
        if row.stratos.is_some() && oracle_accepts != row.stricter_because.is_some() {
            return Some(format!("{}: the label does not fit the oracle", row.name));
        }
        match (row.stratos, oracle, outcome) {
            (Some(refusal), _, Err(actual)) if actual == refusal => None,
            (None, Oracle::Accepted { bytes_hex, cid }, Ok(bytes))
                if hex_of(&bytes) == bytes_hex && record_cid(&bytes).to_string() == cid =>
            {
                None
            }
            (expected, _, outcome) => Some(format!(
                "{}: expected {expected:?} (oracle {}), Stratos gave {:?}",
                row.name,
                row.oracle,
                outcome.map(|bytes| hex_of(&bytes))
            )),
        }
    }

    #[test]
    fn every_key_and_link_edge_input_gets_the_oracle_verdict_or_its_labelled_refusal() {
        let disagreements: Vec<String> = key_and_link_rows()
            .iter()
            .filter_map(disagreement)
            .collect();
        assert_eq!(disagreements, Vec::<String>::new());
    }

    // Oracle edge table: $bytes padding, each text in a map, a nested map and
    // an array. The oracle column is the same reader and serializeRecord run on
    // Node 24, which has no Uint8Array.fromBase64, so lex-data decodes with
    // Node's Buffer. On a runtime with Uint8Array.fromBase64 every verdict is
    // the same except for the short padding, which there stays a plain map
    // (`{"x":{"$bytes":"AQ="}}` gives a16178a1662462797465736341513d). An
    // accepted oracle whose bytes hold the key $bytes is that plain map.

    const PADDING_SHORT: &str = "the padding is present but short; whether upstream reads bytes or a plain map depends on the runtime: a runtime without Uint8Array.fromBase64, such as the Node the oracle ran on, decodes the bytes, and a runtime with it keeps the map; a PDS writes canonical base64, so such a text has no one upstream record";
    const PADDING_WRONG: &str = "the padding is present but wrong; upstream keeps a plain map holding the text on every runtime, and Stratos refuses a $bytes that is neither unpadded nor correctly padded instead of encoding it as a map";

    fn stricter_bytes(
        name: &'static str,
        json: &str,
        oracle: &'static str,
        because: &'static str,
    ) -> EdgeRow {
        EdgeRow {
            stratos: Some(RecordRefusal::InvalidBytes),
            stricter_because: Some(because),
            ..equal(name, json, oracle)
        }
    }

    fn bytes_padding_rows() -> Vec<EdgeRow> {
        vec![
            stricter_bytes(
                "$bytes AQ= in a map",
                r#"{"x":{"$bytes":"AQ="}}"#,
                "accepted a161784101 bafyreiasfua7p4g6yxuwaveo7bi3gyfoqhxgy74y6ofefvvxix6xcucv3i",
                PADDING_SHORT,
            ),
            stricter_bytes(
                "$bytes AQ= in a nested map",
                r#"{"x":{"y":{"$bytes":"AQ="}}}"#,
                "accepted a16178a161794101 bafyreidybuozngcjoywexm7s2lg5ctnxa7yd7rmxit45c5pbvmyhsp3cvi",
                PADDING_SHORT,
            ),
            stricter_bytes(
                "$bytes AQ= in an array",
                r#"{"x":[{"$bytes":"AQ="}]}"#,
                "accepted a16178814101 bafyreicug4jxtwxqjhihmfdr2kkeqqhcpmtxgp726t2umn5jgjhtol6nje",
                PADDING_SHORT,
            ),
            equal(
                "$bytes AQ in a map",
                r#"{"x":{"$bytes":"AQ"}}"#,
                "accepted a161784101 bafyreiasfua7p4g6yxuwaveo7bi3gyfoqhxgy74y6ofefvvxix6xcucv3i",
            ),
            equal(
                "$bytes AQ in a nested map",
                r#"{"x":{"y":{"$bytes":"AQ"}}}"#,
                "accepted a16178a161794101 bafyreidybuozngcjoywexm7s2lg5ctnxa7yd7rmxit45c5pbvmyhsp3cvi",
            ),
            equal(
                "$bytes AQ in an array",
                r#"{"x":[{"$bytes":"AQ"}]}"#,
                "accepted a16178814101 bafyreicug4jxtwxqjhihmfdr2kkeqqhcpmtxgp726t2umn5jgjhtol6nje",
            ),
            equal(
                "$bytes AQ== in a map",
                r#"{"x":{"$bytes":"AQ=="}}"#,
                "accepted a161784101 bafyreiasfua7p4g6yxuwaveo7bi3gyfoqhxgy74y6ofefvvxix6xcucv3i",
            ),
            equal(
                "$bytes AQ== in a nested map",
                r#"{"x":{"y":{"$bytes":"AQ=="}}}"#,
                "accepted a16178a161794101 bafyreidybuozngcjoywexm7s2lg5ctnxa7yd7rmxit45c5pbvmyhsp3cvi",
            ),
            equal(
                "$bytes AQ== in an array",
                r#"{"x":[{"$bytes":"AQ=="}]}"#,
                "accepted a16178814101 bafyreicug4jxtwxqjhihmfdr2kkeqqhcpmtxgp726t2umn5jgjhtol6nje",
            ),
            equal(
                "$bytes AQI in a map",
                r#"{"x":{"$bytes":"AQI"}}"#,
                "accepted a16178420102 bafyreiaueki7kpmqkybkz6zb4fgwjoonzv7vja7cn3nzmr7zomsomh5q3i",
            ),
            equal(
                "$bytes AQI in a nested map",
                r#"{"x":{"y":{"$bytes":"AQI"}}}"#,
                "accepted a16178a16179420102 bafyreia2lemfbco6xxiiewvpeq4kdnbilhi4l2piphrrn4udiclitpyplq",
            ),
            equal(
                "$bytes AQI in an array",
                r#"{"x":[{"$bytes":"AQI"}]}"#,
                "accepted a1617881420102 bafyreigiig6e524ftaryjenlx57dvaulxjf44pyykbchc6creegaioo52y",
            ),
            equal(
                "$bytes AQI= in a map",
                r#"{"x":{"$bytes":"AQI="}}"#,
                "accepted a16178420102 bafyreiaueki7kpmqkybkz6zb4fgwjoonzv7vja7cn3nzmr7zomsomh5q3i",
            ),
            equal(
                "$bytes AQI= in a nested map",
                r#"{"x":{"y":{"$bytes":"AQI="}}}"#,
                "accepted a16178a16179420102 bafyreia2lemfbco6xxiiewvpeq4kdnbilhi4l2piphrrn4udiclitpyplq",
            ),
            equal(
                "$bytes AQI= in an array",
                r#"{"x":[{"$bytes":"AQI="}]}"#,
                "accepted a1617881420102 bafyreigiig6e524ftaryjenlx57dvaulxjf44pyykbchc6creegaioo52y",
            ),
            stricter_bytes(
                "$bytes AQI== in a map",
                r#"{"x":{"$bytes":"AQI=="}}"#,
                "accepted a16178a166246279746573654151493d3d bafyreigjgqjkclh2sqpqni4q6itqsxunohlqqmrlpxfxg5pics7hhvx3nm",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQI== in a nested map",
                r#"{"x":{"y":{"$bytes":"AQI=="}}}"#,
                "accepted a16178a16179a166246279746573654151493d3d bafyreif3wszovrm6ajpx7qhvmj33k4o7yumlmrc66csaph4le4gekti72e",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQI== in an array",
                r#"{"x":[{"$bytes":"AQI=="}]}"#,
                "accepted a1617881a166246279746573654151493d3d bafyreibozstuw6l47tnt2diseuy6revtmh4imiknxganr5rfv7reztzxjq",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQ=== in a map",
                r#"{"x":{"$bytes":"AQ==="}}"#,
                "accepted a16178a1662462797465736541513d3d3d bafyreiem3vsrcuxhm7pc53etvme4kl7pumpcc5dkfznrxa24dxktvrb6bm",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQ=== in a nested map",
                r#"{"x":{"y":{"$bytes":"AQ==="}}}"#,
                "accepted a16178a16179a1662462797465736541513d3d3d bafyreid4zodekfzbmhy4g2uixkk2v2m5w6fm6jxt4p2ydqziqhklvsfdb4",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQ=== in an array",
                r#"{"x":[{"$bytes":"AQ==="}]}"#,
                "accepted a1617881a1662462797465736541513d3d3d bafyreifw7zlvo3lccpsbu7n5rolsgy7pjjyebiyp2l64lx567t4o6s5xla",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes = in a map",
                r#"{"x":{"$bytes":"="}}"#,
                "accepted a16178a166246279746573613d bafyreie2suwginzpgwxvqsl5uiiqvs4j62ohkzt2uyfugja3klg63kgpvm",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes = in a nested map",
                r#"{"x":{"y":{"$bytes":"="}}}"#,
                "accepted a16178a16179a166246279746573613d bafyreihx2olswsbsekm7756t5f2ufymmyhefyxvngn4j64djphqri3l24u",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes = in an array",
                r#"{"x":[{"$bytes":"="}]}"#,
                "accepted a1617881a166246279746573613d bafyreicnyz5lchh3xaqlkapxqw6tq62jcbui36dujh6id5pc45t7dij57y",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes == in a map",
                r#"{"x":{"$bytes":"=="}}"#,
                "accepted a16178a166246279746573623d3d bafyreiau2nfyexepuzkh6ycrixfttj4nbhqzkjvxg4lzutfbqyzxj46aa4",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes == in a nested map",
                r#"{"x":{"y":{"$bytes":"=="}}}"#,
                "accepted a16178a16179a166246279746573623d3d bafyreiegznuj4m4rglxpcwxgd3er37dkemxow4wxh76b7xwxo72r2mstpa",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes == in an array",
                r#"{"x":[{"$bytes":"=="}]}"#,
                "accepted a1617881a166246279746573623d3d bafyreiac7vqyl5l3hnkgv5trdplweztutcckx3hmcbzjh7d6epnk4vrwnu",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQID= in a map",
                r#"{"x":{"$bytes":"AQID="}}"#,
                "accepted a16178a16624627974657365415149443d bafyreihfmrdawxpxa4xsuauzac24nnhnpg35w7tfbz57bnlca4a6adxatq",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQID= in a nested map",
                r#"{"x":{"y":{"$bytes":"AQID="}}}"#,
                "accepted a16178a16179a16624627974657365415149443d bafyreidbxljbabo6q3dryjz76hh7xngjen2fv4vytq3gxspqwbcq7nmslq",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQID= in an array",
                r#"{"x":[{"$bytes":"AQID="}]}"#,
                "accepted a1617881a16624627974657365415149443d bafyreidk5ozqzczhrtgsa5psiqklx3ubylyhffsv7qdzrfrsmkzijxegke",
                PADDING_WRONG,
            ),
            equal(
                "$bytes AQID in a map",
                r#"{"x":{"$bytes":"AQID"}}"#,
                "accepted a1617843010203 bafyreihhjsgtmkiqlcsz4oqagqnvkhcdleeqkuzwgyoxmcttco3cwgibny",
            ),
            equal(
                "$bytes AQID in a nested map",
                r#"{"x":{"y":{"$bytes":"AQID"}}}"#,
                "accepted a16178a1617943010203 bafyreiakdjwq6blueqr2hechkocagcoj3sdkfbohp6kusiufktecrmnshm",
            ),
            equal(
                "$bytes AQID in an array",
                r#"{"x":[{"$bytes":"AQID"}]}"#,
                "accepted a161788143010203 bafyreibjgfhdk3mo2m3s2p6u54dgbv6re5z6tpbnqkk4zslhtnexismjxm",
            ),
            stricter_bytes(
                "$bytes AQ=A in a map",
                r#"{"x":{"$bytes":"AQ=A"}}"#,
                "accepted a16178a1662462797465736441513d41 bafyreieyrg2f47t3qj2v73emhfo6iocuw3ti5nbwu4xphxm35tsm7mmb5m",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQ=A in a nested map",
                r#"{"x":{"y":{"$bytes":"AQ=A"}}}"#,
                "accepted a16178a16179a1662462797465736441513d41 bafyreiayhvvj6aeehe6tiu74mw53lewylfis5rqkmnazcyow5nyuayvh5a",
                PADDING_WRONG,
            ),
            stricter_bytes(
                "$bytes AQ=A in an array",
                r#"{"x":[{"$bytes":"AQ=A"}]}"#,
                "accepted a1617881a1662462797465736441513d41 bafyreifn2aquiujkpmu6ddbsqup2etosaa77k6v46vqycae5x24fptat6q",
                PADDING_WRONG,
            ),
            equal(
                "$bytes empty in a map",
                r#"{"x":{"$bytes":""}}"#,
                "accepted a1617840 bafyreid7mca4eo4rlybzskekofgd3msvlwtvvif2ljkdo2wrbo5f3bgvoi",
            ),
            equal(
                "$bytes empty in a nested map",
                r#"{"x":{"y":{"$bytes":""}}}"#,
                "accepted a16178a1617940 bafyreiarsradmgzoo4qzrloko66no2og6dlcshohiimudlmetqq5kraszy",
            ),
            equal(
                "$bytes empty in an array",
                r#"{"x":[{"$bytes":""}]}"#,
                "accepted a161788140 bafyreiags75loey4hynlehun3fwhdyfocp6dbvly44kz2cetdzqqbqvf34",
            ),
        ]
    }

    #[test]
    fn every_bytes_padding_edge_input_gets_the_oracle_verdict_or_its_labelled_refusal() {
        let rows = bytes_padding_rows();
        assert_eq!(rows.len(), 39);
        let disagreements: Vec<String> = rows.iter().filter_map(disagreement).collect();
        assert_eq!(disagreements, Vec::<String>::new());
    }

    // Cross-check: the CIDs Stratos computes for three fixed records, one with
    // a link and bytes; the upstream package computes the same in the fixture.

    #[test]
    fn the_cids_of_three_fixed_records_are_the_pinned_constants() {
        use super::cross_check_inputs::*;
        for (json, pinned) in [
            (POST_JSON, POST_CID),
            (FOLLOW_JSON, FOLLOW_CID),
            (LINKED_JSON, LINKED_CID),
        ] {
            let bytes = encode_text(json).expect("encodes");
            assert_eq!(record_cid(&bytes).to_string(), pinned, "{json}");
        }
    }
}
