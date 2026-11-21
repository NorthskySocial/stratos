//! Canonical encoding of a space record and its CID, so the record a host sent
//! as JSON can be proved to be the one its commit covers. The encoder is
//! written here and judged byte for byte against the pinned upstream
//! `@atproto/lex-json` reader and `@atproto/lex-cbor` encoder (fixture
//! `record-cid.json` and an edge table in the tests); it refuses on purpose
//! what that pair accepts and Stratos does not, and the fixture or the table
//! labels each such input.

use std::fmt;

use base64::{
    Engine,
    alphabet::STANDARD,
    engine::{
        DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::STANDARD_NO_PAD,
    },
};
use cid::Cid;
use multihash::Multihash;
use serde_cbor::Value as CborValue;
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordDecodeRefusal {
    TooLarge,
    Malformed,
    NotAMap,
    Float,
    UnsupportedTag,
    InvalidLink,
    NonTextKey,
    IntegerOutOfRange,
    Unencodable(RecordRefusal),
    NotCanonical,
}

impl fmt::Display for RecordDecodeRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge => formatter.write_str("the record bytes are too large"),
            Self::Malformed => formatter.write_str("the record bytes are not one CBOR value"),
            Self::NotAMap => formatter.write_str("the record is not a map"),
            Self::Float => formatter.write_str("the record holds a floating point number"),
            Self::UnsupportedTag => formatter.write_str("the record holds a tag other than 42"),
            Self::InvalidLink => formatter.write_str("a tag 42 value is not a CID"),
            Self::NonTextKey => formatter.write_str("a map key is not text"),
            Self::IntegerOutOfRange => formatter.write_str("an integer does not fit 64 bits"),
            Self::Unencodable(refusal) => write!(formatter, "the JSON form is refused: {refusal}"),
            Self::NotCanonical => {
                formatter.write_str("the record is not the canonical encoding of its content")
            }
        }
    }
}

impl std::error::Error for RecordDecodeRefusal {}

/// The CID and the JSON form of a record received as DAG-CBOR bytes, in the
/// form `encode_record` reads. The CID is that of the received bytes. The
/// decoder is trusted for nothing the last step does not confirm: the JSON is
/// returned only when `encode_record` turns it back into exactly the received
/// bytes, so what the host sent, what the set hash covers and what Stratos
/// holds are one record.
pub fn decode_record(bytes: &[u8]) -> Result<(Cid, Value), RecordDecodeRefusal> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(RecordDecodeRefusal::TooLarge);
    }
    let decoded: CborValue =
        serde_cbor::from_slice(bytes).map_err(|_| RecordDecodeRefusal::Malformed)?;
    if !matches!(decoded, CborValue::Map(_)) {
        return Err(RecordDecodeRefusal::NotAMap);
    }
    let record = json_of_cbor(decoded)?;
    let canonical = encode_record(&record).map_err(RecordDecodeRefusal::Unencodable)?;
    if canonical != bytes {
        return Err(RecordDecodeRefusal::NotCanonical);
    }
    Ok((record_cid(bytes), record))
}

fn json_of_cbor(value: CborValue) -> Result<Value, RecordDecodeRefusal> {
    Ok(match value {
        CborValue::Null => Value::Null,
        CborValue::Bool(flag) => Value::Bool(flag),
        CborValue::Integer(integer) => Value::Number(Number::from(
            i64::try_from(integer).map_err(|_| RecordDecodeRefusal::IntegerOutOfRange)?,
        )),
        CborValue::Float(_) => return Err(RecordDecodeRefusal::Float),
        CborValue::Text(text) => Value::String(text),
        CborValue::Bytes(bytes) => {
            let mut wrapper = Map::new();
            wrapper.insert(
                BYTES_KEY.to_owned(),
                Value::String(STANDARD_NO_PAD.encode(bytes)),
            );
            Value::Object(wrapper)
        }
        CborValue::Array(items) => Value::Array(
            items
                .into_iter()
                .map(json_of_cbor)
                .collect::<Result<_, _>>()?,
        ),
        CborValue::Map(entries) => {
            let mut members = Map::new();
            for (key, member) in entries {
                let CborValue::Text(name) = key else {
                    return Err(RecordDecodeRefusal::NonTextKey);
                };
                members.insert(name, json_of_cbor(member)?);
            }
            Value::Object(members)
        }
        CborValue::Tag(CID_TAG, inner) => link_of_cbor(*inner)?,
        CborValue::Tag(_, _) => return Err(RecordDecodeRefusal::UnsupportedTag),
        _ => return Err(RecordDecodeRefusal::Malformed),
    })
}

fn link_of_cbor(inner: CborValue) -> Result<Value, RecordDecodeRefusal> {
    let CborValue::Bytes(payload) = inner else {
        return Err(RecordDecodeRefusal::InvalidLink);
    };
    let Some((&MULTIBASE_IDENTITY_PREFIX, cid_bytes)) = payload.split_first() else {
        return Err(RecordDecodeRefusal::InvalidLink);
    };
    let link = Cid::try_from(cid_bytes).map_err(|_| RecordDecodeRefusal::InvalidLink)?;
    let mut wrapper = Map::new();
    wrapper.insert(LINK_KEY.to_owned(), Value::String(link.to_string()));
    Ok(Value::Object(wrapper))
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

    // Decoding: the bytes of an archive record back to the JSON a host sends.

    fn bytes_of_hex(text: &str) -> Vec<u8> {
        assert_eq!(text.len() % 2, 0, "{text}");
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
            .collect()
    }

    #[test]
    fn every_record_vector_decodes_to_the_oracle_json_and_cid() {
        let records = rows("records");
        assert!(records.len() >= 14);
        for row in &records {
            let name = row["name"].as_str().expect("name");
            let Oracle::Accepted { bytes_hex, cid } =
                oracle_outcome(row["oracle"].as_str().expect("oracle"))
            else {
                panic!("{name}: the vector is an accepted record");
            };
            let expected: Value =
                serde_json::from_str(row["json"].as_str().expect("json")).expect("json");
            let (decoded_cid, decoded) = decode_record(&bytes_of_hex(&bytes_hex))
                .unwrap_or_else(|refusal| panic!("{name}: refused: {refusal}"));
            assert_eq!(decoded, expected, "{name}: value");
            assert_eq!(decoded_cid.to_string(), cid, "{name}: cid");
        }
    }

    // Decoding edge table. The oracle column is the pinned `@atproto/lex-cbor`
    // decoder (strict, no indefinite items, duplicate keys refused) that the
    // upstream archive reader runs on each record, followed by its
    // `@atproto/lex-data` CID of the received bytes; `accepted` gives its JSON
    // (`@atproto/lex-json`) and CID, `refused` its message. Node 24.22.0; the
    // decoder reads no base64 and uses no runtime facility that differs between
    // runtimes. `stratos` is the refusal expected here, `None` meaning the
    // oracle's JSON and CID. An input the oracle accepts and Stratos refuses
    // carries its reason; one the oracle refuses must be refused here too.

    struct DecodeRow {
        name: &'static str,
        hex: &'static str,
        oracle: &'static str,
        stratos: Option<RecordDecodeRefusal>,
        stricter_because: Option<&'static str>,
    }

    const DECODE_ROWS: &[DecodeRow] = &[
        DecodeRow {
            name: "float64 1.5 in a map",
            hex: "a16161fb3ff8000000000000",
            oracle: "accepted {\"a\":1.5} bafyreic6v65kiate4qj6lsdjvf2qjul5frowyn4kgtjp7fpbm7jjfz4mfm",
            stratos: Some(RecordDecodeRefusal::Float),
            stricter_because: Some(
                "Stratos refuses floating point numbers; the record encoder has no float, so no record Stratos holds contains one.",
            ),
        },
        DecodeRow {
            name: "float16 1.0 in a map",
            hex: "a16161f93c00",
            oracle: "accepted {\"a\":1} bafyreiem7o7s4vxfuq5iuupcqt53zvftoud6cpm6f54lgyswaaohktrukq",
            stratos: Some(RecordDecodeRefusal::Float),
            stricter_because: Some(
                "Stratos refuses floating point numbers; the record encoder has no float, so no record Stratos holds contains one.",
            ),
        },
        DecodeRow {
            name: "float32 1.5 in a map",
            hex: "a16161fa3fc00000",
            oracle: "accepted {\"a\":1.5} bafyreigkqqgoo5rf62nahwenqjulof2wk4h42g77voruwvunm6emwj3jye",
            stratos: Some(RecordDecodeRefusal::Float),
            stricter_because: Some(
                "Stratos refuses floating point numbers; the record encoder has no float, so no record Stratos holds contains one.",
            ),
        },
        DecodeRow {
            name: "float64 NaN",
            hex: "a16161fb7ff8000000000000",
            oracle: "refused: CBOR decode error: NaN values are not supported",
            stratos: Some(RecordDecodeRefusal::Float),
            stricter_because: None,
        },
        DecodeRow {
            name: "float64 infinity",
            hex: "a16161fb7ff0000000000000",
            oracle: "refused: CBOR decode error: Infinity values are not supported",
            stratos: Some(RecordDecodeRefusal::Float),
            stricter_because: None,
        },
        DecodeRow {
            name: "float64 of an integral value, 3.0",
            hex: "a16161fb4008000000000000",
            oracle: "accepted {\"a\":3} bafyreiaqyuval3helnqdxwcyxiuqsmfvqryrkylpqovtmjt4f4772uctdm",
            stratos: Some(RecordDecodeRefusal::Float),
            stricter_because: Some(
                "Stratos refuses floating point numbers; the record encoder has no float, so no record Stratos holds contains one.",
            ),
        },
        DecodeRow {
            name: "indefinite-length map",
            hex: "bf616101ff",
            oracle: "refused: CBOR decode error: indefinite length items not allowed",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "indefinite-length array value",
            hex: "a161619f01ff",
            oracle: "refused: CBOR decode error: indefinite length items not allowed",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "indefinite-length text value",
            hex: "a161617f6178ff",
            oracle: "refused: CBOR decode error: indefinite length bytes/strings are not supported",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "indefinite-length byte string value",
            hex: "a161615f4101ff",
            oracle: "refused: CBOR decode error: indefinite length bytes/strings are not supported",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "keys out of order, same length (b then a)",
            hex: "a2616201616102",
            oracle: "accepted {\"b\":1,\"a\":2} bafyreibwqtyzplcfcsvwtqi3tb3b6lemdpv3k2hys62l5nlc45h2n6qxe4",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: Some(
                "The upstream decoder does not check key order and hashes the received bytes, so it accepts a record whose keys are not in canonical order; Stratos holds only records whose canonical encoding is the received bytes.",
            ),
        },
        DecodeRow {
            name: "keys out of order, length first (aa then b)",
            hex: "a262616101616202",
            oracle: "accepted {\"aa\":1,\"b\":2} bafyreihm64me2e2bhk3rxpryi3hcgjjfwnihvntdqokp3vqhj5p2snlqyy",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: Some(
                "The upstream decoder does not check key order and hashes the received bytes, so it accepts a record whose keys are not in canonical order; Stratos holds only records whose canonical encoding is the received bytes.",
            ),
        },
        DecodeRow {
            name: "canonical order (a then b)",
            hex: "a2616101616202",
            oracle: "accepted {\"a\":1,\"b\":2} bafyreifa2oxz5bxfkf7xfg5nazl6frxtw7idrgmjjsgwwm3vsb2mre5v4m",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "duplicate key",
            hex: "a2616101616102",
            oracle: "refused: CBOR decode error: found repeat map key \"a\"",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "duplicate key, same value",
            hex: "a2616101616101",
            oracle: "refused: CBOR decode error: found repeat map key \"a\"",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "integer 1 as one extra byte",
            hex: "a161611801",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "integer 1 as two extra bytes",
            hex: "a16161190001",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "integer 255 in the shortest form",
            hex: "a1616118ff",
            oracle: "accepted {\"a\":255} bafyreiev6nwpttnwg2ztyxd5qdypo7eenry2wp45x7uav2vwj3q7rnfmze",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "integer 24 as two extra bytes",
            hex: "a16161190018",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "negative integer -1 as one extra byte",
            hex: "a161613800",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "text length in a longer form",
            hex: "a16161780178",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "key length in a longer form",
            hex: "a178016101",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "map head in a longer form",
            hex: "b801616101",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "array head in a longer form",
            hex: "a16161980101",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "integer 2^53 - 1",
            hex: "a161611b001fffffffffffff",
            oracle: "accepted {\"a\":9007199254740991} bafyreiemyxo6bul5nma7ry5q567sqwucqzluyfid44ftq26riqfr22wj64",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "integer 2^53",
            hex: "a161611b0020000000000000",
            oracle: "accepted (a BigInt, not JSON) bafyreihzuvx7wmexu2frdnehbtvri6txwviwnxifrrvy2jt2z3a7grsx4e",
            stratos: Some(RecordDecodeRefusal::Unencodable(
                RecordRefusal::IntegerOutOfRange,
            )),
            stricter_because: Some(
                "Stratos refuses integers outside the safe integer range (the encoder rule); the upstream decoder reads them as BigInt.",
            ),
        },
        DecodeRow {
            name: "integer -2^53",
            hex: "a161613b001fffffffffffff",
            oracle: "accepted (a BigInt, not JSON) bafyreiaorcmjpdstfzllnfj3ymwszymf6fddnxmy6ixsn7hp4yhcriqyt4",
            stratos: Some(RecordDecodeRefusal::Unencodable(
                RecordRefusal::IntegerOutOfRange,
            )),
            stricter_because: Some(
                "Stratos refuses integers outside the safe integer range (the encoder rule); the upstream decoder reads them as BigInt.",
            ),
        },
        DecodeRow {
            name: "integer 2^64 - 1",
            hex: "a161611bffffffffffffffff",
            oracle: "accepted (a BigInt, not JSON) bafyreifghzrzpu3uhgw7ra62tnusl6gtlavvvbfupfva7kgvgpmygnneam",
            stratos: Some(RecordDecodeRefusal::IntegerOutOfRange),
            stricter_because: Some(
                "Stratos refuses integers that do not fit 64 bits signed; the upstream decoder reads them as BigInt.",
            ),
        },
        DecodeRow {
            name: "integer -2^64",
            hex: "a161613bffffffffffffffff",
            oracle: "accepted (a BigInt, not JSON) bafyreiaajwt6mbssjlwpjeblzhwkefey3ji2ii4zs2nrw3bt37zsoqquxy",
            stratos: Some(RecordDecodeRefusal::IntegerOutOfRange),
            stricter_because: Some(
                "Stratos refuses integers that do not fit 64 bits signed; the upstream decoder reads them as BigInt.",
            ),
        },
        DecodeRow {
            name: "tag 42 over a canonical cid",
            hex: "a16161d82a58250001711220abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafyreiflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvm\"}} bafyreideiboj3c6rvdvthpy3u37naslxro7lyfxcouh5datn3dsdydfytm",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over bytes without the leading zero",
            hex: "a16161d82a582401711220abababababababababababababababababababababababababababababababab",
            oracle: "refused: Invalid CID for CBOR tag 42; expected leading 0x00",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over bytes with a leading 01",
            hex: "a16161d82a58250101711220abababababababababababababababababababababababababababababababab",
            oracle: "refused: Invalid CID for CBOR tag 42; expected leading 0x00",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over an empty byte string",
            hex: "a16161d82a40",
            oracle: "refused: Invalid CID for CBOR tag 42; expected leading 0x00",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over only the zero byte",
            hex: "a16161d82a4100",
            oracle: "refused: RangeError: Could not decode varint",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a text string",
            hex: "a16161d82a6178",
            oracle: "refused: Invalid CID for CBOR tag 42; expected leading 0x00",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a truncated cid",
            hex: "a16161d82a58050001711220",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid with trailing bytes",
            hex: "a16161d82a58260001711220abababababababababababababababababababababababababababababababab00",
            oracle: "refused: Incorrect length",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a version 0 cid",
            hex: "a16161d82a5823001220abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"QmZtnFaddFtzGNT8BxdHVbQrhSFdq1pWxud5z4fA4kxfDt\"}} bafyreidtlg6jvfgr45rblon7zt6amq2xkal73acomey7xt47cd2skz425m",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid whose version is a two byte varint",
            hex: "a16161d82a5826008100711220abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafyreiflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvm\"}} bafyreibcutogcqgcgcsi7cckjisb24t7g3ltsqrtgkdbyhkdizxzdk7qlq",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: Some(
                "Stratos refuses a CID written with a non-minimal varint (the cid crate); the upstream decoder keeps the bytes as received.",
            ),
        },
        DecodeRow {
            name: "tag 42 over a cid whose multihash length is a two byte varint",
            hex: "a16161d82a582600017112a000abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafyrfiaavov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvovq\"}} bafyreib3w25ejemuulflfabg7rjyayoyhupnqalxqmxirc5gnrzknpyala",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: Some(
                "Stratos refuses a CID written with a non-minimal varint (the cid crate); the upstream decoder keeps the bytes as received.",
            ),
        },
        DecodeRow {
            name: "tag 42 over a cid with a digest of 33 bytes",
            hex: "a16161d82a58260001711221ababababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafyreinlvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvovq\"}} bafyreidlj2vijwhwoq7dkpnemxvfzvl6xkvzgv6vkbmfqgz6lm3nloppim",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a raw-codec cid",
            hex: "a16161d82a58250001551220abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafkreiflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvm\"}} bafyreihhci4a5frek33saxtfqri7cvkzky4eo7pbbmg3cgbxwlhlgwj4py",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a sha-512 cid",
            hex: "a16161d82a58450001711340abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafyrgqflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2w\"}} bafyreibxtbvlic4m2qamvgh3xhcf6hpzb4vhzdzd2xw3c2ukyqmhj72qn4",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 written with a one byte head the long way",
            hex: "a16161d9002a58250001711220abababababababababababababababababababababababababababababababab",
            oracle: "refused: CBOR decode error: integer encoded in more bytes than necessary (strict decode)",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 as a map key",
            hex: "a1d82a58250001711220abababababababababababababababababababababababababababababababab01",
            oracle: "refused: CBOR decode error: non-string keys not supported (got object)",
            stratos: Some(RecordDecodeRefusal::NonTextKey),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 as the whole record",
            hex: "d82a58250001711220abababababababababababababababababababababababababababababababab",
            oracle: "refused: not a plain object",
            stratos: Some(RecordDecodeRefusal::NotAMap),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 0 over a text",
            hex: "a16161c074323032362d31312d32315430303a30303a30305a",
            oracle: "refused: CBOR decode error: tag not supported (0)",
            stratos: Some(RecordDecodeRefusal::UnsupportedTag),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 1 over an integer",
            hex: "a16161c101",
            oracle: "refused: CBOR decode error: tag not supported (1)",
            stratos: Some(RecordDecodeRefusal::UnsupportedTag),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 2 over a byte string",
            hex: "a16161c24101",
            oracle: "refused: CBOR decode error: tag not supported (2)",
            stratos: Some(RecordDecodeRefusal::UnsupportedTag),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 24 over a byte string",
            hex: "a16161d8184101",
            oracle: "refused: CBOR decode error: tag not supported (24)",
            stratos: Some(RecordDecodeRefusal::UnsupportedTag),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 55799 self-describe over a map",
            hex: "d9d9f7a0",
            oracle: "refused: CBOR decode error: tag not supported (55799)",
            stratos: Some(RecordDecodeRefusal::NotAMap),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 nested in an array",
            hex: "a1616181d82a58250001711220abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":[{\"$link\":\"bafyreiflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvm\"}]} bafyreidtjf46wmcvlad346xb7czxh2dfk34vbh556h77lnfietdkn2bkx4",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 43 over bytes",
            hex: "a16161d82b4101",
            oracle: "refused: CBOR decode error: tag not supported (43)",
            stratos: Some(RecordDecodeRefusal::UnsupportedTag),
            stricter_because: None,
        },
        DecodeRow {
            name: "a byte string key",
            hex: "a1416101",
            oracle: "refused: CBOR decode error: non-string keys not supported (got object)",
            stratos: Some(RecordDecodeRefusal::NonTextKey),
            stricter_because: None,
        },
        DecodeRow {
            name: "an integer key",
            hex: "a10101",
            oracle: "refused: CBOR decode error: non-string keys not supported (got number)",
            stratos: Some(RecordDecodeRefusal::NonTextKey),
            stricter_because: None,
        },
        DecodeRow {
            name: "a negative integer key",
            hex: "a12001",
            oracle: "refused: CBOR decode error: non-string keys not supported (got number)",
            stratos: Some(RecordDecodeRefusal::NonTextKey),
            stricter_because: None,
        },
        DecodeRow {
            name: "a null key",
            hex: "a1f601",
            oracle: "refused: CBOR decode error: non-string keys not supported (got object)",
            stratos: Some(RecordDecodeRefusal::NonTextKey),
            stricter_because: None,
        },
        DecodeRow {
            name: "an array key",
            hex: "a18001",
            oracle: "refused: CBOR decode error: non-string keys not supported (got object)",
            stratos: Some(RecordDecodeRefusal::NonTextKey),
            stricter_because: None,
        },
        DecodeRow {
            name: "a map key",
            hex: "a1a001",
            oracle: "refused: CBOR decode error: non-string keys not supported (got object)",
            stratos: Some(RecordDecodeRefusal::NonTextKey),
            stricter_because: None,
        },
        DecodeRow {
            name: "the empty text key",
            hex: "a16001",
            oracle: "accepted {\"\":1} bafyreicpenwudzeykexckbwbtymbw7276kmxqnhs4f36iko3nml2lyi5ne",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "key __proto__",
            hex: "a1695f5f70726f746f5f5f01",
            oracle: "accepted {} bafyreibbmhratf7zb4hokfirm7ihhfumau2xcxqlysz6z3rgjxnaszufxq",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::ProtoKey)),
            stricter_because: Some(
                "The upstream decoder drops a __proto__ key from the value while its CID still covers it; Stratos refuses the key as the encoder does.",
            ),
        },
        DecodeRow {
            name: "key __proto__ nested",
            hex: "a16161a1695f5f70726f746f5f5f01",
            oracle: "accepted {\"a\":{}} bafyreiar3npnwehcybclehatc4vptcjrvgnuay7xcuzb5zbpqhr5e4nf5a",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::ProtoKey)),
            stricter_because: Some(
                "The upstream decoder drops a __proto__ key from the value while its CID still covers it; Stratos refuses the key as the encoder does.",
            ),
        },
        DecodeRow {
            name: "key __proto__ beside the other keys, in order",
            hex: "a2616101695f5f70726f746f5f5f02",
            oracle: "accepted {\"a\":1} bafyreid5yvxkt2ayxlnlsrtjyatyfbk7x7hzkti36fam7gcm3nqhzblczi",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::ProtoKey)),
            stricter_because: Some(
                "The upstream decoder drops a __proto__ key from the value while its CID still covers it; Stratos refuses the key as the encoder does.",
            ),
        },
        DecodeRow {
            name: "key constructor",
            hex: "a16b636f6e7374727563746f7201",
            oracle: "accepted {\"constructor\":1} bafyreidzs23prirtkcwtl4t53thphkjcfvwpvvwhd2zkrl26wcfrnmm44u",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "a map of one $link text key",
            hex: "a165246c696e6b6178",
            oracle: "accepted {\"$link\":\"x\"} bafyreidogezktpqpaobhd3moki3ed5rwiivcpeh2sk74rzozy3dagknq2q",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::InvalidLink)),
            stricter_because: Some(
                "The JSON form cannot tell a map of one $link or $bytes text member from a link or a byte string, so Stratos refuses it; the upstream decoder reads a plain map.",
            ),
        },
        DecodeRow {
            name: "a map of $bytes text member",
            hex: "a1662462797465736178",
            oracle: "accepted {\"$bytes\":\"x\"} bafyreiex3r6gvumivm4vb5dg3xincz3jr3xsd273x7cje4o3mmamgg4abi",
            stratos: Some(RecordDecodeRefusal::Unencodable(
                RecordRefusal::InvalidBytes,
            )),
            stricter_because: Some(
                "The JSON form cannot tell a map of one $link or $bytes text member from a link or a byte string, so Stratos refuses it; the upstream decoder reads a plain map.",
            ),
        },
        DecodeRow {
            name: "simple value undefined",
            hex: "a16161f7",
            oracle: "accepted {\"a\":null} bafyreihrrgdnvxrl7bgul7pd3tgrlvg2adfslrjwwfdywsmplfoiq5cf4q",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: Some(
                "The upstream decoder reads undefined as null; the canonical null is a different byte, so the byte comparison refuses it.",
            ),
        },
        DecodeRow {
            name: "simple value 16",
            hex: "a16161f0",
            oracle: "refused: CBOR decode error: simple values are not supported",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "simple value 255 (two bytes)",
            hex: "a16161f8ff",
            oracle: "refused: CBOR decode error: simple values are not supported",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a break byte as a value",
            hex: "a16161ff",
            oracle: "refused: CBOR decode error: indefinite length items not allowed",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "text that is not utf-8",
            hex: "a1616161ff",
            oracle: "accepted {\"a\":\"�\"} bafyreiakt5ao5tj54yetdclk3ycioins5micxx2gvo4tyuog3ex44xqavy",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: Some(
                "The upstream decoder replaces invalid UTF-8 with U+FFFD; Stratos refuses text that is not UTF-8.",
            ),
        },
        DecodeRow {
            name: "text with an overlong utf-8 sequence",
            hex: "a1616162c080",
            oracle: "accepted {\"a\":\"��\"} bafyreigxnguf7mnetblnxobxnirz4ahlyghxwle46wao3gre634zzhpz5q",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: Some(
                "The upstream decoder replaces invalid UTF-8 with U+FFFD; Stratos refuses text that is not UTF-8.",
            ),
        },
        DecodeRow {
            name: "a lone surrogate encoded as utf-8",
            hex: "a1616163eda080",
            oracle: "accepted {\"a\":\"���\"} bafyreibselo5mdrdycf2l3qfar7eux2c2bvossttdi5stbgxnddjsoxr2a",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: Some(
                "The upstream decoder replaces invalid UTF-8 with U+FFFD; Stratos refuses text that is not UTF-8.",
            ),
        },
        DecodeRow {
            name: "a byte string value",
            hex: "a1616143010203",
            oracle: "accepted {\"a\":{\"$bytes\":\"AQID\"}} bafyreiecdlroy3cd4fjrnm4iiykbkccdz4exrwuzi5hmcayogdoyugktvu",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "an empty byte string value",
            hex: "a1616140",
            oracle: "accepted {\"a\":{\"$bytes\":\"\"}} bafyreift6b7yk7nekqxmw4c2ttplw2dzkvb4mpeumffmzevk5l4ovu6d3m",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "an array of one of each kind",
            hex: "a1616187012061784101f5f4f6",
            oracle: "accepted {\"a\":[1,-1,\"x\",{\"$bytes\":\"AQ\"},true,false,null]} bafyreidsxr3qzidflerjfnj3ymkirllbnlgjtmc6eh3lna2ykymcqzzykm",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "an empty input",
            hex: "",
            oracle: "refused: CBOR decode error: did not find any content to decode",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "an empty map",
            hex: "a0",
            oracle: "accepted {} bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "a top level array",
            hex: "80",
            oracle: "refused: not a plain object",
            stratos: Some(RecordDecodeRefusal::NotAMap),
            stricter_because: None,
        },
        DecodeRow {
            name: "a top level integer",
            hex: "01",
            oracle: "refused: not a plain object",
            stratos: Some(RecordDecodeRefusal::NotAMap),
            stricter_because: None,
        },
        DecodeRow {
            name: "a top level text",
            hex: "6178",
            oracle: "refused: not a plain object",
            stratos: Some(RecordDecodeRefusal::NotAMap),
            stricter_because: None,
        },
        DecodeRow {
            name: "a top level byte string",
            hex: "4101",
            oracle: "refused: not a plain object",
            stratos: Some(RecordDecodeRefusal::NotAMap),
            stricter_because: None,
        },
        DecodeRow {
            name: "a top level null",
            hex: "f6",
            oracle: "refused: not a plain object",
            stratos: Some(RecordDecodeRefusal::NotAMap),
            stricter_because: None,
        },
        DecodeRow {
            name: "trailing byte after the map",
            hex: "a000",
            oracle: "refused: CBOR decode error: too many terminals, data makes no sense",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "trailing complete value after the map",
            hex: "a0a0",
            oracle: "refused: CBOR decode error: too many terminals, data makes no sense",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "trailing garbage byte ff after the map",
            hex: "a0ff",
            oracle: "refused: CBOR decode error: too many terminals, data makes no sense",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "truncated in the map head",
            hex: "b900",
            oracle: "refused: CBOR decode error: not enough data for type",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a map of one pair with no key",
            hex: "a1",
            oracle: "refused: CBOR decode error: found map but not enough entries (got 0 [no key], expected 1)",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a map of one pair with no value",
            hex: "a16161",
            oracle: "refused: CBOR decode error: found map but not enough entries (got 0 [no value], expected 1)",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a key cut inside its bytes",
            hex: "a16261",
            oracle: "refused: CBOR decode error: not enough data for type",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a value cut inside its bytes",
            hex: "a161616278",
            oracle: "refused: CBOR decode error: not enough data for type",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a head cut inside its argument",
            hex: "a161611900",
            oracle: "refused: CBOR decode error: not enough data for type",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a map declaring two pairs and giving one",
            hex: "a2616101",
            oracle: "refused: CBOR decode error: found map but not enough entries (got 1 [no key], expected 2)",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a text declaring 2^32 - 1 bytes and giving none",
            hex: "a161617affffffff",
            oracle: "refused: CBOR decode error: not enough data for type",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a byte string declaring 2^64 - 1 bytes and giving none",
            hex: "a161615bffffffffffffffff",
            oracle: "refused: CBOR decode error: 64-bit integer bytes lengths not supported",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "an array declaring 2^32 - 1 items and giving none",
            hex: "a161619affffffff",
            oracle: "refused: CBOR decode error: found array but not enough entries (got 0, expected 4294967295)",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a map declaring 2^32 - 1 pairs and giving none",
            hex: "a16161baffffffff",
            oracle: "refused: CBOR decode error: found map but not enough entries (got 0 [no key], expected 4294967295)",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a reserved additional information 28",
            hex: "a161611c",
            oracle: "refused: CBOR decode error: encountered invalid minor (28) for major 0",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a reserved additional information 30",
            hex: "a161611e",
            oracle: "refused: CBOR decode error: encountered invalid minor (30) for major 0",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "nesting 32 containers deep (a map holding 31 arrays)",
            hex: "a1616181818181818181818181818181818181818181818181818181818181818180",
            oracle: "accepted {\"a\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]} bafyreig6f7egtggh5va5i4z7j4fjqaivb4vo6sxzh4ajz2qbnms2ar3dx4",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "nesting 33 containers deep (a map holding 32 arrays)",
            hex: "a161618181818181818181818181818181818181818181818181818181818181818180",
            oracle: "accepted {\"a\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]} bafyreif7qgpokie5dujmd4wz2glzmiaugu4xoplswxjzmhvc4hqonrk2my",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::TooDeep)),
            stricter_because: Some(
                "Stratos refuses nesting deeper than 32 containers; the upstream decoder has no limit.",
            ),
        },
        DecodeRow {
            name: "nesting 64 containers deep (a map holding 63 arrays)",
            hex: "a16161818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818180",
            oracle: "accepted {\"a\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]} bafyreia3gb7yvuk2fss3lhgsbx2ovcicud56hxsx65zjizh4hfzqkzeaa4",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::TooDeep)),
            stricter_because: Some(
                "Stratos refuses nesting deeper than 32 containers; the upstream decoder has no limit.",
            ),
        },
        DecodeRow {
            name: "nesting 127 containers deep (a map holding 126 arrays)",
            hex: "a16161818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818180",
            oracle: "accepted {\"a\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]} bafyreie2l2z2fe33gultsjy54en2mlp6qvivq2dahcf7xnnjf65s5hjxuu",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::TooDeep)),
            stricter_because: Some(
                "Stratos refuses nesting deeper than 32 containers; the upstream decoder has no limit.",
            ),
        },
        DecodeRow {
            name: "nesting 128 containers deep (a map holding 127 arrays)",
            hex: "a1616181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818180",
            oracle: "accepted {\"a\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]} bafyreiacxlcr6m23icbz7tiuf6bedub3imh5pdskr77x3y6iizs7r7rqpe",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: Some(
                "Stratos refuses nesting deeper than 32 containers, and the CBOR reader stops at 128; the upstream decoder has no limit.",
            ),
        },
        DecodeRow {
            name: "nesting 129 containers deep (a map holding 128 arrays)",
            hex: "a161618181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818180",
            oracle: "accepted {\"a\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]} bafyreia2an4bty3tqgibz6aebdpoak3jqmzveyx5c6shnxh2zao6dfuoxi",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: Some(
                "Stratos refuses nesting deeper than 32 containers, and the CBOR reader stops at 128; the upstream decoder has no limit.",
            ),
        },
        DecodeRow {
            name: "nesting 200 containers deep (a map holding 199 arrays)",
            hex: "a1616181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818181818180",
            oracle: "accepted {\"a\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]} bafyreibito7fgx7stknfuvmrwkvhswnuwkpbt4xrzprnrxu7g3hcpjguaq",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: Some(
                "Stratos refuses nesting deeper than 32 containers, and the CBOR reader stops at 128; the upstream decoder has no limit.",
            ),
        },
        DecodeRow {
            name: "tag 42 over a cid with an identity multihash",
            hex: "a16161d82a490001710004deadbeef",
            oracle: "accepted {\"a\":{\"$link\":\"bafyqabg6vw7o6\"}} bafyreifemhouuedbg4iqgdcfnbw5df3xkus5p76kadz6kfrdd24fbaiv2e",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid with the sha-256 code and a 2 byte digest",
            hex: "a16161d82a470001711202abcd",
            oracle: "accepted {\"a\":{\"$link\":\"bafyreavlzu\"}} bafyreihzr2d2lk7tmwdjlxlsrt2fwfobmdrpckgkjeum67qtyrfuvjrsje",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid with an unknown hash code",
            hex: "a16161d82a4a000171800104deadbeef",
            oracle: "accepted {\"a\":{\"$link\":\"bafyyaaie32w353y\"}} bafyreibhkknxcemwj56qtkywevgbkprohuemg56ezwnfsuq54krbrtla4i",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid with a digest of 64 bytes",
            hex: "a16161d82a58450001711240abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafyreqflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2w\"}} bafyreiaxreuaawgmxp2pawv3r3kyv47kjbfdxkl6cfkwv5u33dp4mhbq3e",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid with a digest of 65 bytes",
            hex: "a16161d82a58460001711241ababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafyreqnlvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xky\"}} bafyreig2cbzqdpkjwo4dv3rmpnv52ao2ppglv2o2xmzjvluoaxt4gim2ry",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: Some(
                "The CID type holds a digest of at most 64 bytes, and no record CID or blob reference a PDS writes has a longer one; the upstream decoder keeps any length.",
            ),
        },
        DecodeRow {
            name: "tag 42 over a cid of version 2",
            hex: "a16161d82a58250002711220abababababababababababababababababababababababababababababababab",
            oracle: "refused: RangeError: Invalid CID version 2",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid of version 0 with a 33 byte digest",
            hex: "a16161d82a5824001221ababababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"2ow2EKpEWbUKhqcQKqqTJiemproyZyfMSXqU634PkpuWsYug\"}} bafyreicomdwa7noeimki565bm5bfz7futvk67qvvixoo3uc33wpm5pnqd4",
            stratos: Some(RecordDecodeRefusal::InvalidLink),
            stricter_because: Some(
                "CID version 0 is a SHA-256 digest of 32 bytes; Stratos refuses the 33 byte form the upstream decoder keeps.",
            ),
        },
        DecodeRow {
            name: "tag 42 over a cid with a dag-pb codec",
            hex: "a16161d82a58250001701220abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bafybeiflvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvm\"}} bafyreif5kkxqye637ik2fyk5ixsrkwbytj577z7gtbwgxo4mggzui3vqui",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "tag 42 over a cid with a codec in a two byte varint",
            hex: "a16161d82a5826000181711220abababababababababababababababababababababababababababababababab",
            oracle: "accepted {\"a\":{\"$link\":\"bagaxceravov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvovq\"}} bafyreig4p5dp77lzu6ntv5jtb6s2vhrviwv6foubhu5wsfe6gtxksylwvm",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "simple value false written as f8 14",
            hex: "a16161f814",
            oracle: "refused: CBOR decode error: simple values are not supported",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "simple value null written as f8 16",
            hex: "a16161f816",
            oracle: "refused: CBOR decode error: simple values are not supported",
            stratos: Some(RecordDecodeRefusal::Malformed),
            stricter_because: None,
        },
        DecodeRow {
            name: "a plain map of one $link text that is a canonical cid",
            hex: "a16161a165246c696e6b783b626166797265696879706733757678337363373534723232656d6b7736756a7069716a6f7a6965367075756d34696534656774326a71787a367761",
            oracle: "accepted {\"a\":{\"$link\":\"bafyreihypg3uvx3sc754r22emkw6ujpiqjozie6puum4ie4egt2jqxz6wa\"}} bafyreicoeykx3hnic4vnlbhrpdgmtqeyrr52nviekbyoo7qyq72hkoum64",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: Some(
                "The JSON form cannot tell a map of one $link or $bytes text member from a link or a byte string, so Stratos refuses it; the upstream decoder reads a plain map.",
            ),
        },
        DecodeRow {
            name: "a plain map of one $link text that is not a cid",
            hex: "a16161a165246c696e6b6178",
            oracle: "accepted {\"a\":{\"$link\":\"x\"}} bafyreiclyohcrtvttuy5hcgvxil62z3idl6bkhag2cjwkpzrz22bnzy3ce",
            stratos: Some(RecordDecodeRefusal::Unencodable(RecordRefusal::InvalidLink)),
            stricter_because: Some(
                "The JSON form cannot tell a map of one $link or $bytes text member from a link or a byte string, so Stratos refuses it; the upstream decoder reads a plain map.",
            ),
        },
        DecodeRow {
            name: "a plain map of one $bytes text",
            hex: "a16161a1662462797465736441514944",
            oracle: "accepted {\"a\":{\"$bytes\":\"AQID\"}} bafyreig26xm4i7rel7n257ea2rae3nfhn7t25wij4iw3gi7ec6ft76wk3u",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: Some(
                "The JSON form cannot tell a map of one $link or $bytes text member from a link or a byte string, so Stratos refuses it; the upstream decoder reads a plain map.",
            ),
        },
        DecodeRow {
            name: "a plain map of $link holding a number",
            hex: "a16161a165246c696e6b05",
            oracle: "accepted {\"a\":{\"$link\":5}} bafyreib7zxjefatj4dctmkfxlvqfuyon35jsycfarql64obw4z7g465jpm",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "a plain map of $link holding a map",
            hex: "a16161a165246c696e6ba1616201",
            oracle: "accepted {\"a\":{\"$link\":{\"b\":1}}} bafyreicvjijv4xal4h46tz5e36wayysqa52bijljx3wvxk4l6o5cbc2wva",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "a plain map of $link and another member",
            hex: "a16161a261790165246c696e6b6178",
            oracle: "accepted {\"a\":{\"y\":1,\"$link\":\"x\"}} bafyreifr67xozpdze7flikje4zjd4acjhl5rn6f2zxpqevouwm5niu652i",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "a plain map of $bytes and another member",
            hex: "a16161a2617901662462797465736441514944",
            oracle: "accepted {\"a\":{\"y\":1,\"$bytes\":\"AQID\"}} bafyreic3vc5xurbxcrbhyyo4ionp6fobg6suc4qcwvgr46mztafwqyoiq4",
            stratos: None,
            stricter_because: None,
        },
        DecodeRow {
            name: "a top level plain map of one $link text",
            hex: "a165246c696e6b783b626166797265696879706733757678337363373534723232656d6b7736756a7069716a6f7a6965367075756d34696534656774326a71787a367761",
            oracle: "accepted {\"$link\":\"bafyreihypg3uvx3sc754r22emkw6ujpiqjozie6puum4ie4egt2jqxz6wa\"} bafyreiaj5vv4a3be6me7plq6c52fnsxbhj5spzoinzfsdlc3bbdwjgictu",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: Some(
                "The JSON form cannot tell a map of one $link or $bytes text member from a link or a byte string, so Stratos refuses it; the upstream decoder reads a plain map.",
            ),
        },
        DecodeRow {
            name: "a top level plain map of one $bytes text",
            hex: "a1662462797465736441514944",
            oracle: "accepted {\"$bytes\":\"AQID\"} bafyreictje6qj7ugremlfla4ndrvscc6wh3ifp23wuuritioqkmbpscp7m",
            stratos: Some(RecordDecodeRefusal::NotCanonical),
            stricter_because: Some(
                "The JSON form cannot tell a map of one $link or $bytes text member from a link or a byte string, so Stratos refuses it; the upstream decoder reads a plain map.",
            ),
        },
    ];

    fn oracle_accepts(row: &DecodeRow) -> Option<(&'static str, &'static str)> {
        let rest = row.oracle.strip_prefix("accepted ")?;
        let (json, cid) = rest.rsplit_once(' ').expect("json and cid");
        Some((json, cid))
    }

    // The row's disagreement with its recorded expectation, if any.
    fn decode_disagreement(row: &DecodeRow) -> Option<String> {
        let outcome = decode_record(&bytes_of_hex(row.hex));
        if outcome.as_ref().err().copied() != row.stratos {
            return Some(format!("{}: got {outcome:?}", row.name));
        }
        match (oracle_accepts(row), &outcome) {
            (Some((json, cid)), Ok((decoded_cid, decoded))) => {
                let oracle_value: Value = serde_json::from_str(json)
                    .unwrap_or_else(|_| panic!("{}: oracle json {json}", row.name));
                if decoded_cid.to_string() != cid {
                    Some(format!("{}: cid {decoded_cid}", row.name))
                } else if decoded != &oracle_value {
                    Some(format!("{}: value {decoded}", row.name))
                } else if row.stricter_because.is_some() {
                    Some(format!("{}: labelled stricter but accepted", row.name))
                } else {
                    None
                }
            }
            (Some(_), Err(_)) => row
                .stricter_because
                .is_none_or(str::is_empty)
                .then(|| format!("{}: stricter without a reason", row.name)),
            (None, Ok(_)) => Some(format!(
                "{}: the oracle refuses it, Stratos accepted",
                row.name
            )),
            (None, Err(_)) => row
                .stricter_because
                .is_some()
                .then(|| format!("{}: labelled stricter but the oracle refuses", row.name)),
        }
    }

    #[test]
    fn every_decode_edge_input_gets_the_oracle_verdict_or_its_labelled_refusal() {
        assert!(DECODE_ROWS.len() >= 120);
        let mut names = std::collections::BTreeSet::new();
        for row in DECODE_ROWS {
            assert!(names.insert(row.name), "{}: named twice", row.name);
        }
        let disagreements: Vec<String> =
            DECODE_ROWS.iter().filter_map(decode_disagreement).collect();
        assert_eq!(disagreements, Vec::<String>::new());
    }

    #[test]
    fn a_decode_row_the_oracle_accepts_as_bigint_has_no_json_to_compare() {
        let bigint_rows: Vec<&str> = DECODE_ROWS
            .iter()
            .filter(|row| row.oracle.contains("(a BigInt"))
            .map(|row| row.name)
            .collect();
        assert_eq!(
            bigint_rows,
            [
                "integer 2^53",
                "integer -2^53",
                "integer 2^64 - 1",
                "integer -2^64"
            ]
        );
        for row in DECODE_ROWS
            .iter()
            .filter(|row| bigint_rows.contains(&row.name))
        {
            assert!(
                decode_record(&bytes_of_hex(row.hex)).is_err(),
                "{}",
                row.name
            );
        }
    }

    // Every proper prefix of each vector record, and each of the 256 bytes
    // appended to it, was run through the oracle: none was accepted (14 records,
    // 0 of 1 089 prefixes, 0 of 3 584 appended).

    #[test]
    fn no_prefix_of_a_record_and_no_record_with_a_byte_appended_decodes() {
        let mut prefixes = 0;
        let mut appended = 0;
        for row in rows("records") {
            let Oracle::Accepted { bytes_hex, .. } =
                oracle_outcome(row["oracle"].as_str().expect("oracle"))
            else {
                panic!("a vector record is accepted");
            };
            let bytes = bytes_of_hex(&bytes_hex);
            for end in 0..bytes.len() {
                prefixes += 1;
                assert!(
                    decode_record(&bytes[..end]).is_err(),
                    "{}: prefix {end}",
                    row["name"]
                );
            }
            for extra in 0..=u8::MAX {
                appended += 1;
                let mut longer = bytes.clone();
                longer.push(extra);
                assert!(
                    decode_record(&longer).is_err(),
                    "{}: byte {extra}",
                    row["name"]
                );
            }
        }
        assert_eq!((prefixes, appended), (1089, 3584));
    }

    // The oracle's CID of the bytes its own encoder writes for each shape at
    // every length where the head of CBOR changes size (23 and 24, 255 and 256,
    // 65 535 and 65 536) and at 0 and 1. A text has n bytes, a byte string n
    // bytes of 0x61, an array n zeros, a map n members named k00000 and up.

    const BOUNDARY_CIDS: &[(&str, usize, &str)] = &[
        (
            "text",
            0,
            "bafyreiccddvifu7msegt35iqfbdkugtfk6rswloo6xmsyinknia43ajsry",
        ),
        (
            "bytes",
            0,
            "bafyreifh3zz54azi5ab66xr2lneccgs23ocacug2x4fmlpcbqamvqa5hba",
        ),
        (
            "array",
            0,
            "bafyreicxch36nnljjpnf2uxvnvgslrtlvyonnt2a2ivgbjzqpby7fgu3yi",
        ),
        (
            "map",
            0,
            "bafyreighzouz6e3be62myggjblhjjg2fvj6bi4kyr3466arloayrutq3zy",
        ),
        (
            "text",
            1,
            "bafyreigj7i6pss2yn74fr4vmlld7yeagyqvspbvd3th47v3ivkap2epgju",
        ),
        (
            "bytes",
            1,
            "bafyreiatxevgymi5dwhdrflre2gtwvsfiuebca2m524bw5pyjgojfgyj7e",
        ),
        (
            "array",
            1,
            "bafyreieyat4i4lq2eln4lmsllvoi5re7fwmyqcszdoik75kzn4h3fogmhu",
        ),
        (
            "map",
            1,
            "bafyreiagqdia6s2qmuvh6ltx5w3ff6dtiq2gofm5lfeldnqexepofmsfdu",
        ),
        (
            "text",
            23,
            "bafyreig6lvorboyy7zmm7usnkaszsd27wgc7zriytile4frmreidjmuuly",
        ),
        (
            "bytes",
            23,
            "bafyreifuiz4vy62arci5auipqsjzcswgw4mvvrwp5h673ptf4spmkdfnhy",
        ),
        (
            "array",
            23,
            "bafyreicysavd7z6wrt6bussjzjh6z3y4aiclxqusfzoucxvgoihsfgj5oy",
        ),
        (
            "map",
            23,
            "bafyreifha2atd5d4ldrrl6ilchoiuvao4mwuyqm5ueozckx5mo25wpn2ny",
        ),
        (
            "text",
            24,
            "bafyreihw7d5sus7gdn3pfbyd5olvk66iubiieersyqztp3ac572bqrs7vm",
        ),
        (
            "bytes",
            24,
            "bafyreiceeatd3bjktas3w552otrzgmgluqcsgfcubyglr2q3dadbvipmve",
        ),
        (
            "array",
            24,
            "bafyreib4cnexxtickyuzo2rfq7vqnv2hnp6m2wwxl7gknon5tevgjf3y5u",
        ),
        (
            "map",
            24,
            "bafyreibls3nylrcqxnyq6bzh4hi37mzoajnwu2skdi3ocekckktgrh62hu",
        ),
        (
            "text",
            255,
            "bafyreifukuamlhtarntyflacg7ktrbh2ilc6ifghoqtuns6jsqymnvupju",
        ),
        (
            "bytes",
            255,
            "bafyreihn5d2fizfp3zyolujx6zhag26t5xazi64kgbnlwrkvkmxo2igioi",
        ),
        (
            "array",
            255,
            "bafyreifm3rak2xyrfvnkik4jotm4seucjfxzc3xoe7klgbu7h6wttxq6ru",
        ),
        (
            "map",
            255,
            "bafyreibt2bghjled7g3shbn2b3cplsyjjgqmhvgyntehim7ettbb335mci",
        ),
        (
            "text",
            256,
            "bafyreibzdosp4yqzq7dpzqufdto6eh6btgk3ezsdbtdbesqqqx2g5dneie",
        ),
        (
            "bytes",
            256,
            "bafyreicxhf45je6j4fjv2scwco3gxyqgpizkibm5odtnyoosv2tpzkrhc4",
        ),
        (
            "array",
            256,
            "bafyreigh2py6ygaj6utoqftu4ysd57rskrxgq6sjkm7hwupabstawm2x4a",
        ),
        (
            "map",
            256,
            "bafyreigi5urcngokmti4vqv2kcdidfpcxa22oekntp5n2cnrtlfipomfnq",
        ),
        (
            "text",
            65535,
            "bafyreia6rtj6svee7floypell2fodzqyacwid6ofgs2p543dqqteujyugy",
        ),
        (
            "bytes",
            65535,
            "bafyreihe6s6wbnnaxxg6avpcuum3jj27hsnd2hs4z7v5nlnj3e52oupspa",
        ),
        (
            "array",
            65535,
            "bafyreic56sbgb7bmlj7h2o2iarrkdkwqeugivsvmianpaybbzu5kvhwl4i",
        ),
        (
            "map",
            65535,
            "bafyreicp77d75emzcouae67c4irls6s3wrgo3oqho2mgofkluwzwsq2teu",
        ),
        (
            "text",
            65536,
            "bafyreicom3fq6cjal37mshn64bjzubrilb6indprjostxspox3y6jhzrze",
        ),
        (
            "bytes",
            65536,
            "bafyreifnimzpaiy5k7vrkrzos6uluozwradjiyrvaf26wwib65oapanycy",
        ),
        (
            "array",
            65536,
            "bafyreiey7kmxp6pw6ubla5fc4r2vfvgpjgceunuhisbssylfykns6nekgq",
        ),
        (
            "map",
            65536,
            "bafyreibcwvdgsffck25a2j26z6jr5ah4pzht5umon5bqrow57u5rx5q4yy",
        ),
    ];

    fn boundary_record(shape: &str, length: usize) -> Value {
        match shape {
            "text" => serde_json::json!({ "s": "a".repeat(length) }),
            "bytes" => serde_json::json!({
                "b": { "$bytes": STANDARD_NO_PAD.encode(vec![0x61u8; length]) }
            }),
            "array" => serde_json::json!({ "l": vec![0; length] }),
            "map" => {
                let members: Map<String, Value> = (0..length)
                    .map(|at| (format!("k{at:05}"), Value::from(0)))
                    .collect();
                serde_json::json!({ "m": members })
            }
            other => panic!("no shape {other}"),
        }
    }

    #[test]
    fn records_at_every_head_size_boundary_decode_to_the_oracle_cid() {
        assert_eq!(BOUNDARY_CIDS.len(), 32);
        for (shape, length, cid) in BOUNDARY_CIDS {
            let record = boundary_record(shape, *length);
            let bytes = encode_record(&record).expect("encodes");
            let (decoded_cid, decoded) = decode_record(&bytes)
                .unwrap_or_else(|refusal| panic!("{shape} {length}: {refusal}"));
            assert_eq!(decoded, record, "{shape} {length}");
            assert_eq!(decoded_cid.to_string(), *cid, "{shape} {length}: cid");
        }
    }

    // Size: the oracle's decoder has no limit; the archive reader refuses a
    // value over 1 MiB before the decoder sees it. The CIDs are the oracle's
    // for a map of one text member filling that many bytes.

    #[test]
    fn a_record_of_exactly_one_mebibyte_decodes_and_one_byte_more_is_refused_before_decoding() {
        let at_limit = encode_record(&record_with_text_filling(MAX_RECORD_BYTES)).expect("fits");
        let (cid, _) = decode_record(&at_limit).expect("decodes");
        assert_eq!(
            cid.to_string(),
            "bafyreiasatg6xhcbromqn3perhjt6knwxkxfgooryj4vdswvfhocmyvuia"
        );
        // The oracle decoder accepts these bytes too, with the CID
        // bafyreiab5d3x2muoosp7t4wdbv6qf6vkdsomlmqrgtrz2kbqlr53aqkuey; upstream
        // refuses them in the archive reader's value limit instead.
        let mut over = at_limit;
        over.push(0);
        assert_eq!(decode_record(&over), Err(RecordDecodeRefusal::TooLarge));
        let mut oversized_garbage = vec![0xffu8; MAX_RECORD_BYTES + 1];
        oversized_garbage[0] = 0xa1;
        assert_eq!(
            decode_record(&oversized_garbage),
            Err(RecordDecodeRefusal::TooLarge)
        );
    }

    // Seeded loop: records built from the JSON side, as a host's records are.

    fn random_text(generator: &mut Lcg, longest: usize) -> String {
        const PIECES: [&str; 8] = ["a", "Z", "7", " ", "é", "日", "🛸", "-"];
        let length = generator.below(longest + 1);
        (0..length)
            .map(|_| PIECES[generator.below(PIECES.len())])
            .collect()
    }

    fn random_key(generator: &mut Lcg) -> String {
        let key = random_text(generator, 40);
        match key.as_str() {
            "__proto__" | "$link" | "$bytes" => format!("{key}x"),
            _ => key,
        }
    }

    fn random_link(generator: &mut Lcg) -> Value {
        let seed: Vec<u8> = (0..8).map(|_| generator.below(256) as u8).collect();
        let cid = record_cid(&seed);
        serde_json::json!({ "$link": cid.to_string() })
    }

    fn random_bytes(generator: &mut Lcg) -> Value {
        let length = generator.below(300);
        let bytes: Vec<u8> = (0..length).map(|_| generator.below(256) as u8).collect();
        serde_json::json!({ "$bytes": STANDARD_NO_PAD.encode(bytes) })
    }

    fn random_integer(generator: &mut Lcg) -> Value {
        const EDGES: [i64; 14] = [
            0,
            -1,
            23,
            24,
            255,
            256,
            65_535,
            65_536,
            4_294_967_295,
            4_294_967_296,
            -24,
            -25,
            MAX_SAFE_INTEGER,
            -MAX_SAFE_INTEGER,
        ];
        if generator.below(2) == 0 {
            Value::from(EDGES[generator.below(EDGES.len())])
        } else {
            Value::from(generator.below(1 << 20) as i64 - (1 << 19))
        }
    }

    fn random_value(generator: &mut Lcg, depth: usize) -> Value {
        let kinds = if depth >= 4 { 6 } else { 8 };
        match generator.below(kinds) {
            0 => Value::Null,
            1 => Value::Bool(generator.below(2) == 0),
            2 => random_integer(generator),
            3 => Value::String(random_text(generator, 300)),
            4 => random_link(generator),
            5 => random_bytes(generator),
            6 => Value::Array(
                (0..generator.below(8))
                    .map(|_| random_value(generator, depth + 1))
                    .collect(),
            ),
            _ => random_map(generator, depth + 1),
        }
    }

    fn random_map(generator: &mut Lcg, depth: usize) -> Value {
        let mut members = Map::new();
        for _ in 0..generator.below(8) {
            let key = random_key(generator);
            let member = random_value(generator, depth);
            members.insert(key, member);
        }
        Value::Object(members)
    }

    #[test]
    fn two_hundred_seeded_records_encode_and_decode_to_the_same_json_and_cid() {
        let mut generator = Lcg(0x5eed_0044);
        let mut longest = 0;
        let (mut links, mut byte_strings) = (0, 0);
        for round in 0..200 {
            let record = random_map(&mut generator, 0);
            let bytes = encode_record(&record).expect("a generated record encodes");
            let (cid, decoded) = decode_record(&bytes)
                .unwrap_or_else(|refusal| panic!("round {round}: refused: {refusal}"));
            assert_eq!(decoded, record, "round {round}");
            assert_eq!(cid, record_cid(&bytes), "round {round}");
            let text = record.to_string();
            longest = longest.max(bytes.len());
            links += usize::from(text.contains("\"$link\""));
            byte_strings += usize::from(text.contains("\"$bytes\""));
        }
        assert!(longest > 2_000, "the loop never built a large record");
        assert!(links > 20 && byte_strings > 20, "{links} {byte_strings}");
    }

    #[test]
    fn a_decoded_record_encodes_to_the_bytes_it_came_from() {
        for row in rows("records") {
            let Oracle::Accepted { bytes_hex, .. } =
                oracle_outcome(row["oracle"].as_str().expect("oracle"))
            else {
                panic!("a vector record is accepted");
            };
            let bytes = bytes_of_hex(&bytes_hex);
            let (_, decoded) = decode_record(&bytes).expect("decodes");
            assert_eq!(encode_record(&decoded).expect("encodes"), bytes);
        }
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
