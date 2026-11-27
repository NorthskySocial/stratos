//! Structured-field helpers for the response MAC: bounded parsing, finding the
//! member tagged for a profile, and the text the MAC covers. Values are read
//! through `sfv`. The one hand-written scan reads the text received for what
//! `sfv` does not keep: the text of byte sequences, which it decodes, and the
//! values of a key that a later duplicate overwrote.

use base64::{Engine, engine::general_purpose::STANDARD};
use sfv::{Dictionary, FieldType, InnerList, KeyRef, List, ListEntry, Parser, Version};

/// A host-controlled field this large is refused before any parsing.
pub const MAX_FIELD_BYTES: usize = 4096;
pub const MAX_DICTIONARY_MEMBERS: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FieldError {
    TooLong,
    TooManyMembers,
    Malformed,
    NonCanonicalByteSequence,
    Decimal,
}

/// Parses a dictionary field the way the pinned upstream parser does (the
/// version without dates and display strings), after the size bound. The
/// member count is checked as soon as parsing returns, which is cheap because
/// the size bound has already limited the work.
///
/// Stricter than upstream: a byte sequence must be written as the padded
/// base64 of its bytes, and no decimal may appear anywhere in the field.
/// Upstream re-serializes a byte sequence as received and `1.0` as `1`; `sfv`
/// writes the padded bytes and `1.0`. Accepting either would let the two sides
/// MAC different text for the same field. Both rules read the text received,
/// because a value that a later duplicate key overwrote is gone from the
/// parsed dictionary but not from the text a host may have MACed.
pub fn parse_dictionary(text: &str) -> Result<Dictionary, FieldError> {
    if text.len() > MAX_FIELD_BYTES {
        return Err(FieldError::TooLong);
    }
    let dictionary: Dictionary = Parser::new(text)
        .with_version(Version::Rfc8941)
        .parse()
        .map_err(|_| FieldError::Malformed)?;
    if dictionary.len() > MAX_DICTIONARY_MEMBERS {
        return Err(FieldError::TooManyMembers);
    }
    let received = scan_received_text(text);
    if received.holds_decimal {
        return Err(FieldError::Decimal);
    }
    if !received.byte_sequences.into_iter().all(is_padded_base64) {
        return Err(FieldError::NonCanonicalByteSequence);
    }
    Ok(dictionary)
}

struct ReceivedText<'a> {
    /// The text between the colons of each byte sequence.
    byte_sequences: Vec<&'a str>,
    holds_decimal: bool,
}

/// Only for text `sfv` has accepted: there every string is closed and every
/// key or token is a maximal run of its characters, so outside them a colon
/// opens or closes a byte sequence and a `.` is the point of a decimal.
fn scan_received_text(field: &str) -> ReceivedText<'_> {
    let bytes = field.as_bytes();
    let mut received = ReceivedText {
        byte_sequences: Vec::new(),
        holds_decimal: false,
    };
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        at += 1;
        match bytes[start] {
            b'"' => {
                while at < bytes.len() && bytes[at] != b'"' {
                    at += if bytes[at] == b'\\' { 2 } else { 1 };
                }
                at += 1;
            }
            b':' => {
                let Some(length) = bytes[at..].iter().position(|&byte| byte == b':') else {
                    break;
                };
                received.byte_sequences.push(&field[at..at + length]);
                at += length + 1;
            }
            b'.' => received.holds_decimal = true,
            byte if byte.is_ascii_alphabetic() || byte == b'*' => {
                while at < bytes.len() && is_token_character(bytes[at]) {
                    at += 1;
                }
            }
            _ => {}
        }
    }
    received
}

// RFC 8941 `tchar`, plus the `:` and `/` a token may hold after its first
// character. Every key character is one of these too.
fn is_token_character(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~:/".contains(&byte)
}

fn is_padded_base64(text: &str) -> bool {
    STANDARD
        .decode(text)
        .is_ok_and(|bytes| STANDARD.encode(bytes) == text)
}

pub struct TaggedMember<'a> {
    pub label: &'a KeyRef,
    pub members: &'a InnerList,
}

/// The inner-list members whose `tag` parameter is the string `tag`, in the
/// order received. Labels carry no meaning; the tag identifies a signature.
pub fn members_with_tag<'a>(dictionary: &'a Dictionary, tag: &str) -> Vec<TaggedMember<'a>> {
    dictionary
        .iter()
        .filter_map(|(label, entry)| match entry {
            ListEntry::InnerList(members)
                if members
                    .params
                    .get("tag")
                    .and_then(|value| value.as_string())
                    .is_some_and(|value| value.as_str() == tag) =>
            {
                Some(TaggedMember {
                    label: label.as_ref(),
                    members,
                })
            }
            _ => None,
        })
        .collect()
}

/// The inner list with its parameters, as it appears in a signature base
/// (`("a";sf);keyid="..."`). `sfv` serializes an inner list only inside a list.
pub fn serialize_inner_list(inner_list: &InnerList) -> Option<String> {
    let wrapper: List = vec![ListEntry::InnerList(inner_list.clone())];
    wrapper.serialize()
}

/// The covered components alone, without the list's parameters.
pub fn serialize_covered_components(inner_list: &InnerList) -> Option<String> {
    let mut components = inner_list.clone();
    components.params.clear();
    serialize_inner_list(&components)
}

/// Members in the order parsed.
pub fn serialize_dictionary(dictionary: &Dictionary) -> Option<String> {
    dictionary.serialize()
}

/// One covered component: its identifier as written in the signature input
/// (`"atproto-space-commit";sf`) and the field value it stands for.
pub struct CoveredComponent<'a> {
    pub identifier: &'a str,
    pub value: &'a str,
}

/// The signature base: one line per covered component, then the signature
/// parameters, joined by newlines with no trailing newline.
pub fn signature_base(components: &[CoveredComponent<'_>], signature_params: &str) -> Vec<u8> {
    let mut lines: Vec<String> = components
        .iter()
        .map(|component| format!("{}: {}", component.identifier, component.value.trim()))
        .collect();
    lines.push(format!("\"@signature-params\": {signature_params}"));
    lines.join("\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT_MAC: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/commit-mac.json");

    fn fixture_header(name: &str) -> String {
        let fixture: serde_json::Value = serde_json::from_str(COMMIT_MAC).expect("fixture");
        fixture["headers"][name]
            .as_str()
            .expect("header")
            .to_owned()
    }

    // Cross-check: the oracle's parser (structured-headers 1.0.1, run on each
    // input when this table was written) returned this text or refused.
    const ORACLE_PARSES: &[(&str, Option<&str>)] = &[
        ("ver=1, note=@123", None),
        ("ver=1, note=%\"x\"", None),
        ("ver=1, ver=2", Some("ver=2")),
        ("a=1,b=2 ,c=3", Some("a=1, b=2, c=3")),
        ("a=1;x=1;x=2", Some("a=1;x=2")),
        ("a=(1 2);k, b=3", Some("a=(1 2);k, b=3")),
        ("a=1.5", Some("a=1.5")),
        ("a=-0", Some("a=0")),
        ("a=1,\tb=2", Some("a=1, b=2")),
        ("a=1 ,", None),
        ("a=?1;b", Some("a;b")),
        ("A=1", None),
        ("a=1\t", Some("a=1")),
        (" a=1 ", Some("a=1")),
        ("a=999999999999999", Some("a=999999999999999")),
        ("a=1234567890123456", None),
        ("a=:AQ==:", Some("a=:AQ==:")),
        ("a=:AQ:", Some("a=:AQ:")),
        ("a=:AR==:", Some("a=:AR==:")),
        ("a=:AR:", Some("a=:AR:")),
        ("a=:AQ=:", Some("a=:AQ=:")),
        ("a=:A:", Some("a=:A:")),
        ("a=:====:", Some("a=:====:")),
        ("a=::", Some("a=::")),
        ("a=:A Q:", None),
        ("a=:-_8=:", None),
        ("a=1;p=:AQ==:", Some("a=1;p=:AQ==:")),
        ("a=1;p=:AQ:", Some("a=1;p=:AQ:")),
        ("a=(:AQ==: 1)", Some("a=(:AQ==: 1)")),
        ("a=(:AQ: 1)", Some("a=(:AQ: 1)")),
        ("a=();p=:AQ:", Some("a=();p=:AQ:")),
        ("a=:AQ:, a=:AQ==:", Some("a=:AQ==:")),
        ("a=1.0", Some("a=1")),
        ("a=1.50", Some("a=1.5")),
        ("a=-0.0", Some("a=0")),
        ("a=1;p=1.0", Some("a=1;p=1")),
        ("a=();p=0.5", Some("a=();p=0.5")),
        ("a=(1.0 2)", Some("a=(1 2)")),
        ("a=\"1.0\"", Some("a=\"1.0\"")),
        ("a.b=1", Some("a.b=1")),
        ("a=\":AQ:\"", Some("a=\":AQ:\"")),
        ("a=\"x:AQ:y\", b=:AQ==:", Some("a=\"x:AQ:y\", b=:AQ==:")),
        ("a=\"a,b:AQ:\", b=:AQ==:", Some("a=\"a,b:AQ:\", b=:AQ==:")),
        (
            "a=\"q\\\":AQ:\", b=:AQ==:",
            Some("a=\"q\\\":AQ:\", b=:AQ==:"),
        ),
        ("a=\"q\\\\\", b=:AQ:", Some("a=\"q\\\\\", b=:AQ:")),
        ("a=foo:AQ:, b=:AQ==:", Some("a=foo:AQ:, b=:AQ==:")),
        ("a=*x:/y", Some("a=*x:/y")),
        ("ver=1.0, ver=1", Some("ver=1")),
        ("a=1;p=1.0;p=1", Some("a=1;p=1")),
        ("a=(1.0 2), a=1", Some("a=1")),
        ("a=(1;p=1.0;p=1)", Some("a=(1;p=1)")),
        ("a=();p=0.5;p=1", Some("a=();p=1")),
        ("a=(1 2);p=1.0;p=1", Some("a=(1 2);p=1")),
        ("a=(1;p=0.5)", Some("a=(1;p=0.5)")),
        ("a=foo.bar", Some("a=foo.bar")),
        ("a=b.c", Some("a=b.c")),
        ("a=*1.5", Some("a=*1.5")),
        ("*1.5=1", Some("*1.5=1")),
        ("a=1;p.q=2", Some("a=1;p.q=2")),
        ("a=\"q\\\"1.0\"", Some("a=\"q\\\"1.0\"")),
        ("a=:A.==:", None),
    ];

    // Inputs of the table above that the oracle accepts and Stratos refuses on
    // purpose. The oracle keeps a byte sequence's text as received and writes
    // a decimal with a zero fraction as an integer; `sfv` re-encodes the bytes
    // padded and keeps the decimal. A host and this verifier would then MAC
    // different text, so such a field is refused rather than half-agreed.
    // The `Malformed` rows are base64 that `sfv` itself refuses.
    const REFUSED_ON_PURPOSE: &[(&str, FieldError)] = &[
        ("a=:AQ:", FieldError::NonCanonicalByteSequence),
        ("a=:AR==:", FieldError::NonCanonicalByteSequence),
        ("a=:AR:", FieldError::NonCanonicalByteSequence),
        ("a=:AQ=:", FieldError::NonCanonicalByteSequence),
        ("a=:A:", FieldError::Malformed),
        ("a=:====:", FieldError::Malformed),
        ("a=1;p=:AQ:", FieldError::NonCanonicalByteSequence),
        ("a=(:AQ: 1)", FieldError::NonCanonicalByteSequence),
        ("a=();p=:AQ:", FieldError::NonCanonicalByteSequence),
        ("a=:AQ:, a=:AQ==:", FieldError::NonCanonicalByteSequence),
        ("a=\"q\\\\\", b=:AQ:", FieldError::NonCanonicalByteSequence),
        ("a=1.5", FieldError::Decimal),
        ("a=1.0", FieldError::Decimal),
        ("a=1.50", FieldError::Decimal),
        ("a=-0.0", FieldError::Decimal),
        ("a=1;p=1.0", FieldError::Decimal),
        ("a=();p=0.5", FieldError::Decimal),
        ("a=(1.0 2)", FieldError::Decimal),
        ("ver=1.0, ver=1", FieldError::Decimal),
        ("a=1;p=1.0;p=1", FieldError::Decimal),
        ("a=(1.0 2), a=1", FieldError::Decimal),
        ("a=(1;p=1.0;p=1)", FieldError::Decimal),
        ("a=();p=0.5;p=1", FieldError::Decimal),
        ("a=(1 2);p=1.0;p=1", FieldError::Decimal),
        ("a=(1;p=0.5)", FieldError::Decimal),
    ];

    fn refused_on_purpose(input: &str) -> bool {
        REFUSED_ON_PURPOSE
            .iter()
            .any(|(refused, _)| *refused == input)
    }

    #[test]
    fn parsing_and_reserializing_agree_with_the_oracle_parser() {
        for (input, oracle) in ORACLE_PARSES {
            if refused_on_purpose(input) {
                continue;
            }
            let ours = parse_dictionary(input)
                .ok()
                .and_then(|dictionary| serialize_dictionary(&dictionary));
            assert_eq!(ours.as_deref(), *oracle, "{input:?}");
        }
    }

    #[test]
    fn every_input_refused_on_purpose_is_one_the_oracle_accepts() {
        for (input, error) in REFUSED_ON_PURPOSE {
            let oracle = ORACLE_PARSES
                .iter()
                .find(|(parsed, _)| parsed == input)
                .map(|(_, oracle)| *oracle);
            assert!(matches!(oracle, Some(Some(_))), "{input:?}");
            assert_eq!(parse_dictionary(input).err(), Some(*error), "{input:?}");
        }
    }

    #[test]
    fn a_colon_inside_a_string_or_a_token_does_not_start_a_byte_sequence() {
        for text in [
            "note=\":AQ:\", data=:AQ==:",
            "note=\"x:AQ:y\", data=:AQ==:",
            "note=\"a,b:AQ:\", data=:AQ==:",
            "note=\"q\\\":AQ:\", data=:AQ==:",
            "crew=spike:AQ:, data=:AQ==:",
            "crew=*ein:/AQ:, data=:AQ==:",
        ] {
            assert!(parse_dictionary(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn a_byte_sequence_after_a_string_ending_in_an_escaped_backslash_is_checked() {
        assert_eq!(
            parse_dictionary("note=\"tokyo-3\\\\\", data=:AQ:").err(),
            Some(FieldError::NonCanonicalByteSequence)
        );
    }

    #[test]
    fn a_byte_sequence_anywhere_in_the_field_must_be_padded_base64() {
        for (unpadded, padded) in [
            ("data=:AQ:", "data=:AQ==:"),
            ("ver=1;p=:AQ:", "ver=1;p=:AQ==:"),
            ("crew=(:AQ: 1)", "crew=(:AQ==: 1)"),
            ("crew=(1;p=:AQ:)", "crew=(1;p=:AQ==:)"),
            ("crew=();p=:AQ:", "crew=();p=:AQ==:"),
            ("data=:AQ:, data=:AQ==:", "data=:AQ==:, data=:AQ==:"),
            ("data=:AR==:", "data=:AQ==:"),
            (
                "mac=:agoKI6VfAyLnrmZiOFhya093wpW3RVR69wv39HqiQw0:",
                "mac=:agoKI6VfAyLnrmZiOFhya093wpW3RVR69wv39HqiQw0=:",
            ),
        ] {
            assert_eq!(
                parse_dictionary(unpadded).err(),
                Some(FieldError::NonCanonicalByteSequence),
                "{unpadded}"
            );
            assert!(parse_dictionary(padded).is_ok(), "{padded}");
        }
    }

    #[test]
    fn a_decimal_anywhere_in_the_field_is_refused() {
        for text in [
            "ver=1.0",
            "note=1.5",
            "ver=1;p=1.0",
            "crew=(1.0 2)",
            "crew=(1;p=0.5)",
            "crew=();p=0.5",
        ] {
            assert_eq!(
                parse_dictionary(text).err(),
                Some(FieldError::Decimal),
                "{text}"
            );
        }
        for text in ["note=\"1.0\"", "a.b=1", "ver=1"] {
            assert!(parse_dictionary(text).is_ok(), "{text}");
        }
    }

    // `sfv` keeps only the last value of a repeated key, so a decimal it
    // overwrote is visible only in the text received.
    #[test]
    fn a_decimal_a_later_duplicate_key_overwrote_is_refused() {
        for text in [
            "ver=1.0, ver=1",
            "ver=1;p=1.0;p=1",
            "crew=(1.0 2), crew=1",
            "crew=(1;p=1.0;p=1)",
            "crew=();p=0.5;p=1",
            "crew=(1 2);p=1.0;p=1",
        ] {
            assert_eq!(
                parse_dictionary(text).err(),
                Some(FieldError::Decimal),
                "{text}"
            );
        }
    }

    #[test]
    fn a_dot_in_a_string_a_token_or_a_key_is_not_a_decimal() {
        for text in [
            "note=\"1.0\"",
            "note=\"q\\\"1.0\"",
            "note=\"nerv\\\\1.0\"",
            "crew=spike.spiegel",
            "ship=bebop;crew=ein.corgi",
            "crew=(faye.valentine ed)",
            "crew=*1.5",
            "a.b=1",
            "*1.5=1",
            "ver=1;p.q=2",
            "crew=(1;p.q=2)",
        ] {
            assert!(parse_dictionary(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn a_decimal_after_a_string_with_escapes_is_found() {
        for text in [
            "note=\"q\\\"\", ver=1.0",
            "note=\"nerv\\\\\", ver=1.0",
            "note=\"1\", ver=2.5",
        ] {
            assert_eq!(
                parse_dictionary(text).err(),
                Some(FieldError::Decimal),
                "{text}"
            );
        }
    }

    // Base64 has no `.`, so `sfv` refuses such a field before the decimal
    // rule could see it.
    #[test]
    fn a_dot_inside_a_byte_sequence_is_malformed_not_a_decimal() {
        assert_eq!(
            parse_dictionary("data=:A.==:").err(),
            Some(FieldError::Malformed)
        );
    }

    #[test]
    fn the_size_bound_applies_before_the_value_rules() {
        let filler = "a".repeat(MAX_FIELD_BYTES);
        for text in [
            format!("data=:AQ:, note=\"{filler}\""),
            format!("ver=1.0, note=\"{filler}\""),
        ] {
            assert_eq!(parse_dictionary(&text).err(), Some(FieldError::TooLong));
        }
    }

    #[test]
    fn the_accepted_headers_reserialize_to_the_text_received() {
        for name in ["atproto-space-commit", "signature-input", "signature"] {
            let text = fixture_header(name);
            let dictionary = parse_dictionary(&text).expect(name);
            assert_eq!(serialize_dictionary(&dictionary).as_deref(), Some(&*text));
        }
    }

    #[test]
    fn the_covered_components_serialize_without_the_list_parameters() {
        let text = fixture_header("signature-input");
        let dictionary = parse_dictionary(&text).expect("input");
        let [member] = members_with_tag(&dictionary, "atproto-space-commit")
            .try_into()
            .ok()
            .expect("one tagged member");
        assert_eq!(member.label.as_str(), "mac");
        assert_eq!(
            serialize_covered_components(member.members).as_deref(),
            Some("(\"atproto-space-commit\";sf)")
        );
        let params = serialize_inner_list(member.members).expect("params");
        assert_eq!(format!("mac={params}"), text);
    }

    #[test]
    fn only_members_with_the_exact_string_tag_are_found() {
        let dictionary = parse_dictionary(
            "a=();tag=\"x\", b=();tag=x, c=();tag=\"y\", d=1;tag=\"x\", e=();tug=\"x\", f=();tag=\"x\"",
        )
        .expect("dictionary");
        let labels: Vec<&str> = members_with_tag(&dictionary, "x")
            .iter()
            .map(|member| member.label.as_str())
            .collect();
        assert_eq!(labels, ["a", "f"]);
    }

    #[test]
    fn members_keep_the_order_received() {
        let text = "repo=\"did:plc:faye\", ver=1, rev=\"3jzfcijpj2z2d\"";
        let dictionary = parse_dictionary(text).expect("dictionary");
        assert_eq!(serialize_dictionary(&dictionary).as_deref(), Some(text));
    }

    #[test]
    fn the_signature_base_has_no_trailing_newline_and_trims_the_value() {
        let base = signature_base(
            &[CoveredComponent {
                identifier: "\"atproto-space-commit\";sf",
                value: " ver=1 ",
            }],
            "(\"atproto-space-commit\";sf);tag=\"atproto-space-commit\"",
        );
        assert_eq!(
            String::from_utf8(base).expect("utf8"),
            "\"atproto-space-commit\";sf: ver=1\n\"@signature-params\": (\"atproto-space-commit\";sf);tag=\"atproto-space-commit\""
        );
    }

    #[test]
    fn a_field_of_4097_bytes_is_refused_before_it_is_parsed() {
        let note = "a".repeat(MAX_FIELD_BYTES - "ver=1, note=\"\"".len());
        let at_limit = format!("ver=1, note=\"{note}\"");
        assert_eq!(at_limit.len(), MAX_FIELD_BYTES);
        assert!(parse_dictionary(&at_limit).is_ok());

        let over = format!("ver=1, note=\"{note}a\"");
        assert_eq!(over.len(), MAX_FIELD_BYTES + 1);
        assert_eq!(parse_dictionary(&over).err(), Some(FieldError::TooLong));

        // Over the size bound and not a dictionary at all: still the size
        // error, so the bound ran first.
        let garbage = "\u{1}".repeat(MAX_FIELD_BYTES + 1);
        assert_eq!(parse_dictionary(&garbage).err(), Some(FieldError::TooLong));
    }

    #[test]
    fn a_dictionary_of_17_members_is_refused_and_one_of_16_is_not() {
        let members = |count: usize| {
            (0..count)
                .map(|index| format!("k{index}={index}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        assert_eq!(
            parse_dictionary(&members(MAX_DICTIONARY_MEMBERS))
                .expect("sixteen")
                .len(),
            MAX_DICTIONARY_MEMBERS
        );
        assert_eq!(
            parse_dictionary(&members(MAX_DICTIONARY_MEMBERS + 1)).err(),
            Some(FieldError::TooManyMembers)
        );
    }

    #[test]
    fn text_that_is_not_a_dictionary_is_malformed() {
        for text in ["ver=", "\"unterminated", "a=1,", "=1", "a=(1"] {
            assert_eq!(
                parse_dictionary(text).err(),
                Some(FieldError::Malformed),
                "{text}"
            );
        }
    }
}
