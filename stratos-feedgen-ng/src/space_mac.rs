//! Request and response authentication for the commit profile. A host proves a
//! response with an HTTP message signature that is an HMAC keyed by the secret
//! of one request (`space_kem`). The checks follow the pinned upstream
//! `packages/space/src/{mac,http-signature}.ts`, and are stricter only where
//! noted: each header appears once and is bounded, holds no decimal and no byte
//! sequence other than padded base64, and the commit's fields are typed exactly.

use std::fmt;

use base64::{Engine, engine::general_purpose::STANDARD, engine::general_purpose::STANDARD_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sfv::{BareItem, Dictionary, ListEntry};
use sha2::Sha256;

use crate::{
    space_kem::RequestSecret,
    space_signature_fields::{
        CoveredComponent, FieldError, members_with_tag, parse_dictionary,
        serialize_covered_components, serialize_dictionary, serialize_inner_list, signature_base,
    },
};

pub const COMMIT_PROFILE: &str = "atproto-space-commit";
const COVERED_IDENTIFIER: &str = "\"atproto-space-commit\";sf";
const COVERED_COMPONENTS: &str = "(\"atproto-space-commit\";sf)";
const REQUEST_LABEL: &str = "mac";
const MAC_ALGORITHM: &str = "hmac-sha256";
const COMMIT_VERSION: i64 = 1;
const DATA_LENGTH: usize = 32;
const TID_LENGTH: usize = 13;
const TID_FIRST_CHARACTERS: &str = "234567abcdefghij";
const TID_CHARACTERS: &str = "234567abcdefghijklmnopqrstuvwxyz";

/// The secret of one request and what it asked for. It is consumed by the one
/// verification it belongs to, so a response can only be checked against its
/// own request, and the secret is zeroed when that check ends.
#[derive(Debug)]
pub struct MacRequestContext {
    secret: RequestSecret,
    repo: String,
    space: String,
}

impl MacRequestContext {
    pub fn new(secret: RequestSecret, repo: &str, space: &str) -> Self {
        Self {
            secret,
            repo: repo.to_owned(),
            space: space.to_owned(),
        }
    }

    pub fn key_share(&self) -> &str {
        self.secret.key_share()
    }

    /// The `Accept-Signature` value asking for a MAC under this key share.
    pub fn accept_signature(&self) -> String {
        format!(
            "{REQUEST_LABEL}={COVERED_COMPONENTS};keyid=\"{}\";tag=\"{COMMIT_PROFILE}\"",
            self.secret.key_share()
        )
    }
}

/// The raw values received for each response header, one entry per header line.
#[derive(Clone, Debug, Default)]
pub struct CommitResponseHeaders {
    pub commit: Vec<String>,
    pub signature_input: Vec<String>,
    pub signature: Vec<String>,
}

/// A commit whose five fields were covered by a MAC under the secret of the
/// request that asked for them, and equal the body's commit. Only this module
/// can make one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacVerifiedCommit {
    repo: String,
    space: String,
    rev: String,
    data: [u8; DATA_LENGTH],
}

impl MacVerifiedCommit {
    pub fn repo(&self) -> &str {
        &self.repo
    }

    pub fn space(&self) -> &str {
        &self.space
    }

    pub fn rev(&self) -> &str {
        &self.rev
    }

    pub fn data(&self) -> &[u8; DATA_LENGTH] {
        &self.data
    }
}

/// `MacMismatch` is the one failure a stale KEM key can cause; everything else
/// is a response that is wrong however the key was obtained. Neither carries
/// text received from the host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MacVerifyError {
    MacMismatch,
    Invalid(MacDefect),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MacDefect {
    HeaderMissing,
    HeaderRepeated,
    HeaderTooLong,
    TooManyMembers,
    MalformedField,
    NonCanonicalByteSequence,
    DecimalValue,
    NoTaggedMember,
    MoreThanOneTaggedMember,
    WrongCoveredComponents,
    WrongAlgorithm,
    KeyShareMismatch,
    MissingSignature,
    MalformedCommitHeader,
    MalformedBodyCommit,
    CommitDiffersFromSignedHeader,
    RequestMismatch,
}

impl fmt::Display for MacDefect {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HeaderMissing => "a response header is missing",
            Self::HeaderRepeated => "a response header appears more than once",
            Self::HeaderTooLong => "a response header is too long",
            Self::TooManyMembers => "a response header has too many members",
            Self::MalformedField => "a response header is not a structured dictionary",
            Self::NonCanonicalByteSequence => {
                "a response header holds a byte sequence that is not padded base64"
            }
            Self::DecimalValue => "a response header holds a decimal",
            Self::NoTaggedMember => "no signature is tagged for the commit",
            Self::MoreThanOneTaggedMember => "more than one signature is tagged for the commit",
            Self::WrongCoveredComponents => {
                "the signature does not cover exactly the commit header"
            }
            Self::WrongAlgorithm => "the signature algorithm is not hmac-sha256",
            Self::KeyShareMismatch => "the signature names another key share",
            Self::MissingSignature => "no well-formed signature under the signature's label",
            Self::MalformedCommitHeader => "the commit header does not hold the five typed fields",
            Self::MalformedBodyCommit => "the body commit does not hold the five typed fields",
            Self::CommitDiffersFromSignedHeader => "the body commit differs from the signed header",
            Self::RequestMismatch => "the commit is for another repo or space than requested",
        })
    }
}

impl fmt::Display for MacVerifyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MacMismatch => formatter.write_str("the MAC does not match"),
            Self::Invalid(defect) => defect.fmt(formatter),
        }
    }
}

impl std::error::Error for MacVerifyError {}

impl From<FieldError> for MacVerifyError {
    fn from(error: FieldError) -> Self {
        Self::Invalid(match error {
            FieldError::TooLong => MacDefect::HeaderTooLong,
            FieldError::TooManyMembers => MacDefect::TooManyMembers,
            FieldError::Malformed => MacDefect::MalformedField,
            FieldError::NonCanonicalByteSequence => MacDefect::NonCanonicalByteSequence,
            FieldError::Decimal => MacDefect::DecimalValue,
        })
    }
}

impl From<MacDefect> for MacVerifyError {
    fn from(defect: MacDefect) -> Self {
        Self::Invalid(defect)
    }
}

/// Checks the MAC of a commit response, then that the signed commit header and
/// the body's commit hold the same five values, then that the commit is for
/// the repo and space the request named.
pub fn verify_commit_response(
    context: MacRequestContext,
    headers: &CommitResponseHeaders,
    body_commit: &Value,
) -> Result<MacVerifiedCommit, MacVerifyError> {
    let inputs = parse_dictionary(exactly_one(&headers.signature_input)?)?;
    let signatures = parse_dictionary(exactly_one(&headers.signature)?)?;
    let covered = parse_dictionary(exactly_one(&headers.commit)?)?;

    let tagged = members_with_tag(&inputs, COMMIT_PROFILE);
    let member = match tagged.as_slice() {
        [] => return Err(MacDefect::NoTaggedMember.into()),
        [only] => only,
        _ => return Err(MacDefect::MoreThanOneTaggedMember.into()),
    };
    if serialize_covered_components(member.members).as_deref() != Some(COVERED_COMPONENTS) {
        return Err(MacDefect::WrongCoveredComponents.into());
    }
    if let Some(algorithm) = member.members.params.get("alg")
        && algorithm.as_string().map(|text| text.as_str()) != Some(MAC_ALGORITHM)
    {
        return Err(MacDefect::WrongAlgorithm.into());
    }
    if let Some(key_share) = member.members.params.get("keyid")
        && key_share.as_string().map(|text| text.as_str()) != Some(context.key_share())
    {
        return Err(MacDefect::KeyShareMismatch.into());
    }
    let Some(ListEntry::Item(signature)) = signatures.get(member.label.as_str()) else {
        return Err(MacDefect::MissingSignature.into());
    };
    let Some(mac) = signature
        .bare_item
        .as_byte_sequence()
        .filter(|_| signature.params.is_empty())
    else {
        return Err(MacDefect::MissingSignature.into());
    };

    let signature_params = serialize_inner_list(member.members).ok_or(MacDefect::MalformedField)?;
    let covered_text = serialize_dictionary(&covered).ok_or(MacDefect::MalformedCommitHeader)?;
    let base = signature_base(
        &[CoveredComponent {
            identifier: COVERED_IDENTIFIER,
            value: &covered_text,
        }],
        &signature_params,
    );
    let mut expected =
        Hmac::<Sha256>::new_from_slice(context.secret.secret()).expect("hmac takes any key length");
    expected.update(&base);
    expected
        .verify_slice(mac)
        .map_err(|_| MacVerifyError::MacMismatch)?;

    let signed = signed_commit(&covered).ok_or(MacDefect::MalformedCommitHeader)?;
    let body = body_commit_fields(body_commit).ok_or(MacDefect::MalformedBodyCommit)?;
    if signed != body {
        return Err(MacDefect::CommitDiffersFromSignedHeader.into());
    }
    if signed.repo != context.repo || signed.space != context.space {
        return Err(MacDefect::RequestMismatch.into());
    }
    Ok(MacVerifiedCommit {
        repo: signed.repo,
        space: signed.space,
        rev: signed.rev,
        data: signed.data,
    })
}

fn exactly_one(values: &[String]) -> Result<&str, MacVerifyError> {
    match values {
        [] => Err(MacDefect::HeaderMissing.into()),
        [only] => Ok(only),
        _ => Err(MacDefect::HeaderRepeated.into()),
    }
}

#[derive(Debug, Eq, PartialEq)]
struct CommitFields {
    repo: String,
    space: String,
    rev: String,
    data: [u8; DATA_LENGTH],
}

fn signed_commit(covered: &Dictionary) -> Option<CommitFields> {
    let bare = |name: &str| match covered.get(name)? {
        ListEntry::Item(item) => Some(&item.bare_item),
        ListEntry::InnerList(_) => None,
    };
    let text = |name: &str| {
        bare(name)?
            .as_string()
            .map(|value| value.as_str().to_owned())
    };
    let version = bare("ver")?.as_integer()?;
    if i64::from(version) != COMMIT_VERSION {
        return None;
    }
    let rev = text("rev").filter(|rev| is_tid(rev))?;
    let BareItem::ByteSequence(data) = bare("data")? else {
        return None;
    };
    Some(CommitFields {
        repo: text("repo")?,
        space: text("space")?,
        rev,
        data: data.as_slice().try_into().ok()?,
    })
}

fn body_commit_fields(body: &Value) -> Option<CommitFields> {
    let commit = body.as_object()?;
    if commit.get("ver")?.as_u64()? != COMMIT_VERSION as u64 {
        return None;
    }
    let text = |name: &str| commit.get(name)?.as_str().map(str::to_owned);
    let rev = text("rev").filter(|rev| is_tid(rev))?;
    let data = commit.get("data")?.as_object()?;
    if data.len() != 1 {
        return None;
    }
    let encoded = data.get("$bytes")?.as_str()?;
    let decoded = STANDARD_NO_PAD
        .decode(encoded)
        .or_else(|_| STANDARD.decode(encoded))
        .ok()?;
    Some(CommitFields {
        repo: text("repo")?,
        space: text("space")?,
        rev,
        data: decoded.as_slice().try_into().ok()?,
    })
}

fn is_tid(text: &str) -> bool {
    let mut characters = text.chars();
    text.len() == TID_LENGTH
        && characters
            .next()
            .is_some_and(|first| TID_FIRST_CHARACTERS.contains(first))
        && characters.all(|character| TID_CHARACTERS.contains(character))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space_kem::{AuthorKemKey, encapsulate_with_ephemeral_key};
    use crate::space_signature_fields::{MAX_DICTIONARY_MEMBERS, MAX_FIELD_BYTES};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use hmac::{Hmac, Mac};
    use serde_json::{Value, json};
    use sha2::Sha256;
    use std::collections::BTreeMap;

    const COMMIT_MAC: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/commit-mac.json");
    const ORACLE_EXPORT: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/hpke-export-oracle.json");
    const ACCEPT_SIGNATURE_FIELD: &str = "acceptSignature";
    const COVERED: &str = "atproto-space-commit";
    const OLD_MAC_HEADER: &str = "atproto-space-mac";
    const ORACLE_MAC_MISMATCH: &str = "refused: MAC does not match";

    fn hex_bytes(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex digit"))
            .collect()
    }

    fn author_key() -> AuthorKemKey {
        let export: Value = serde_json::from_str(ORACLE_EXPORT).expect("fixture");
        let did = export["oracleExport"]["authorKemDid"]
            .as_str()
            .expect("did");
        AuthorKemKey::from_did_key(did).expect("author key")
    }

    fn fixture_ephemeral_key() -> Vec<u8> {
        let export: Value = serde_json::from_str(ORACLE_EXPORT).expect("fixture");
        let hex = export["oracleExport"]["ephemeralPrivateKey"]["value"]
            .as_str()
            .expect("hex");
        hex_bytes(hex)
    }

    fn hmac_sha256(secret: &[u8], message: &[u8]) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("hmac key");
        mac.update(message);
        mac.finalize().into_bytes().to_vec()
    }

    fn signature_base_text(header: &str, params: &str) -> Vec<u8> {
        format!("\"{COVERED}\";sf: {header}\n\"@signature-params\": {params}").into_bytes()
    }

    fn lex_bytes(bytes: &[u8]) -> Value {
        json!({ "$bytes": STANDARD.encode(bytes).trim_end_matches('=') })
    }

    mod oracle_cases {
        use super::*;

        struct Case {
            name: String,
            headers: CommitResponseHeaders,
            body: Value,
            verdict: String,
        }

        fn single(map: &BTreeMap<String, String>, name: &str) -> Vec<String> {
            map.get(name).cloned().into_iter().collect()
        }

        // Materialised the way the fixture generator does: edit swaps the first
        // occurrence in an accepted header (a request edit is not a response
        // header), set overwrites, remove drops, bodyChange alters the commit.
        fn materialise(fixture: &Value, entry: &Value, verdict: &str) -> Case {
            let mut map: BTreeMap<String, String> = fixture["headers"]
                .as_object()
                .expect("headers")
                .iter()
                .map(|(name, value)| (name.clone(), value.as_str().expect("text").to_owned()))
                .collect();
            for (name, pair) in entry["edit"].as_object().into_iter().flatten() {
                if name == ACCEPT_SIGNATURE_FIELD {
                    continue;
                }
                let [from, to] = [0, 1].map(|at| pair[at].as_str().expect("text"));
                let text = map.get(name).expect("edited header exists");
                assert!(text.contains(from), "{name}");
                map.insert(name.clone(), text.replacen(from, to, 1));
            }
            for (name, value) in entry["set"].as_object().into_iter().flatten() {
                map.insert(name.clone(), value.as_str().expect("text").to_owned());
            }
            for name in entry["remove"].as_array().into_iter().flatten() {
                map.remove(name.as_str().expect("name"));
            }
            let mut body = fixture["commit"].clone();
            let data = body["data"]["value"].as_str().expect("data").to_owned();
            body["data"] = json!({ "$bytes": data.trim_end_matches('=') });
            for (name, value) in entry["bodyChange"].as_object().into_iter().flatten() {
                body[name] = if name == "data" {
                    json!({ "$bytes": value["value"].as_str().expect("data").trim_end_matches('=') })
                } else {
                    value.clone()
                };
            }
            Case {
                name: entry["name"].as_str().expect("name").to_owned(),
                headers: CommitResponseHeaders {
                    commit: single(&map, COVERED),
                    signature_input: single(&map, "signature-input"),
                    signature: single(&map, "signature"),
                },
                body,
                verdict: verdict.to_owned(),
            }
        }

        fn context_for(fixture: &Value) -> MacRequestContext {
            let secret = encapsulate_with_ephemeral_key(&author_key(), &fixture_ephemeral_key())
                .expect("secret");
            assert_eq!(
                secret.secret().as_slice(),
                STANDARD
                    .decode(fixture["sharedSecret"]["value"].as_str().expect("secret"))
                    .expect("base64")
            );
            MacRequestContext::new(
                secret,
                fixture["commit"]["repo"].as_str().expect("repo"),
                fixture["commit"]["space"].as_str().expect("space"),
            )
        }

        fn fixture() -> Value {
            serde_json::from_str(COMMIT_MAC).expect("fixture")
        }

        // Oracle vector: the request text the oracle's own formatter made.
        #[test]
        fn the_accept_signature_for_the_fixture_key_share_is_the_fixture_string() {
            let fixture = fixture();
            let context = context_for(&fixture);
            assert_eq!(
                context.accept_signature(),
                fixture["acceptSignature"].as_str().expect("text")
            );
        }

        // Oracle vector: every case the oracle's verifier judged.
        #[test]
        fn every_oracle_case_gets_the_oracle_verdict() {
            let fixture = fixture();
            let cases = fixture["cases"].as_array().expect("cases");
            assert_eq!(cases.len(), 29);
            for entry in cases {
                let verdict = entry["verdict"].as_str().expect("verdict");
                let case = materialise(&fixture, entry, verdict);
                let outcome =
                    verify_commit_response(context_for(&fixture), &case.headers, &case.body);
                if case.verdict == "accepted" {
                    let commit = outcome.unwrap_or_else(|error| panic!("{}: {error}", case.name));
                    assert_eq!(commit.repo(), fixture["commit"]["repo"].as_str().unwrap());
                    assert_eq!(commit.space(), fixture["commit"]["space"].as_str().unwrap());
                    assert_eq!(commit.rev(), fixture["commit"]["rev"].as_str().unwrap());
                    assert_eq!(
                        commit.data().as_slice(),
                        STANDARD
                            .decode(fixture["commit"]["data"]["value"].as_str().unwrap())
                            .unwrap()
                    );
                } else {
                    let error = outcome.expect_err(&case.name);
                    assert_eq!(
                        error == MacVerifyError::MacMismatch,
                        case.verdict == ORACLE_MAC_MISMATCH,
                        "{}: {error}",
                        case.name
                    );
                }
            }
        }

        // Oracle vector, hand-labelled: the oracle accepts, Stratos refuses.
        #[test]
        fn every_stricter_case_is_refused() {
            let fixture = fixture();
            let cases = fixture["stricter"].as_array().expect("stricter");
            assert_eq!(cases.len(), 4);
            for entry in cases {
                assert_eq!(entry["oracleVerdict"], "accepted");
                let case = materialise(&fixture, entry, "refused");
                let outcome =
                    verify_commit_response(context_for(&fixture), &case.headers, &case.body);
                assert!(
                    matches!(outcome, Err(MacVerifyError::Invalid(_))),
                    "{}: {outcome:?}",
                    case.name
                );
            }
        }

        // Oracle vector: the old header alone is not an answer to the new request.
        #[test]
        fn a_response_with_only_the_old_mac_header_is_refused_as_missing() {
            let fixture = fixture();
            let entry = fixture["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["set"].get(OLD_MAC_HEADER).is_some())
                .expect("old header case");
            let case = materialise(&fixture, entry, "refused");
            assert!(case.headers.commit.is_empty() && case.headers.signature.is_empty());
            assert_eq!(
                verify_commit_response(context_for(&fixture), &case.headers, &case.body).err(),
                Some(MacVerifyError::Invalid(MacDefect::HeaderMissing))
            );
        }

        // Stricter than the oracle on purpose: each edit re-serializes to the
        // text the original MAC covers, so only the decimal rule refuses it.
        #[test]
        fn a_decimal_a_later_duplicate_overwrote_is_invalid_with_the_original_mac() {
            let fixture = fixture();
            let unedited = materialise(&fixture, &json!({ "name": "unedited" }), "accepted");
            assert!(
                verify_commit_response(context_for(&fixture), &unedited.headers, &unedited.body)
                    .is_ok()
            );
            let outcomes: Vec<_> = [
                (COVERED, "ver=1,", "ver=1.0, ver=1,"),
                ("signature-input", ";keyid=", ";keyid=1.0;keyid="),
                ("signature", "mac=", "mac=1.0, mac="),
            ]
            .into_iter()
            .map(|(header, from, to)| {
                let entry = json!({ "name": header, "edit": { header: [from, to] } });
                let case = materialise(&fixture, &entry, "refused");
                let outcome =
                    verify_commit_response(context_for(&fixture), &case.headers, &case.body);
                (header, outcome.err())
            })
            .collect();
            assert_eq!(
                outcomes,
                [
                    (
                        COVERED,
                        Some(MacVerifyError::Invalid(MacDefect::DecimalValue))
                    ),
                    (
                        "signature-input",
                        Some(MacVerifyError::Invalid(MacDefect::DecimalValue))
                    ),
                    (
                        "signature",
                        Some(MacVerifyError::Invalid(MacDefect::DecimalValue))
                    ),
                ]
            );
        }
    }

    mod generated {
        use super::*;

        struct Xorshift(u64);

        impl Xorshift {
            fn next(&mut self) -> u64 {
                self.0 ^= self.0 << 13;
                self.0 ^= self.0 >> 7;
                self.0 ^= self.0 << 17;
                self.0
            }

            fn bytes<const N: usize>(&mut self) -> [u8; N] {
                let mut out = [0_u8; N];
                for chunk in out.chunks_mut(8) {
                    chunk.copy_from_slice(&self.next().to_le_bytes()[..chunk.len()]);
                }
                out
            }

            fn text(&mut self, alphabet: &str, length: usize) -> String {
                let alphabet = alphabet.as_bytes();
                (0..length)
                    .map(|_| alphabet[(self.next() % alphabet.len() as u64) as usize] as char)
                    .collect()
            }
        }

        const TID_FIRST: &str = "234567abcdefghij";
        const TID_REST: &str = "234567abcdefghijklmnopqrstuvwxyz";
        const BASE32: &str = "abcdefghijklmnopqrstuvwxyz234567";

        // A response made with the HMAC primitive directly. The secret comes
        // from a random ephemeral key and the fixed author key, so it is the
        // one the code under test derives; this proves flow, and the tests
        // above prove the derivation.
        struct Exchange {
            ephemeral: Vec<u8>,
            key_share: String,
            secret: [u8; 32],
            repo: String,
            space: String,
            rev: String,
            data: [u8; 32],
        }

        impl Exchange {
            fn new(rng: &mut Xorshift) -> Self {
                let ephemeral = rng.bytes::<32>().to_vec();
                let request = encapsulate_with_ephemeral_key(&author_key(), &ephemeral)
                    .expect("ephemeral key is a valid scalar");
                Self {
                    key_share: request.key_share().to_owned(),
                    secret: *request.secret(),
                    ephemeral,
                    repo: format!("did:plc:{}", rng.text(BASE32, 24)),
                    space: format!(
                        "at:space/did:web:{}.example/zone.stratos.space.feed/{}",
                        rng.text("abcdefgh", 8),
                        rng.text("abcdefgh", 6)
                    ),
                    rev: format!("{}{}", rng.text(TID_FIRST, 1), rng.text(TID_REST, 12)),
                    data: rng.bytes::<32>(),
                }
            }

            fn context(&self, repo: &str, space: &str) -> MacRequestContext {
                let secret =
                    encapsulate_with_ephemeral_key(&author_key(), &self.ephemeral).expect("secret");
                MacRequestContext::new(secret, repo, space)
            }

            fn members(&self) -> Vec<String> {
                vec![
                    "ver=1".to_owned(),
                    format!("repo=\"{}\"", self.repo),
                    format!("space=\"{}\"", self.space),
                    format!("rev=\"{}\"", self.rev),
                    format!("data=:{}:", STANDARD.encode(self.data)),
                ]
            }

            fn params(&self) -> String {
                format!(
                    "(\"{COVERED}\";sf);keyid=\"{}\";tag=\"{COVERED}\"",
                    self.key_share
                )
            }

            fn mac(&self, header: &str, params: &str) -> Vec<u8> {
                hmac_sha256(&self.secret, &signature_base_text(header, params))
            }

            fn response(
                &self,
                members: &[String],
                params: &str,
                label: &str,
            ) -> CommitResponseHeaders {
                let header = members.join(", ");
                CommitResponseHeaders {
                    signature: vec![format!(
                        "{label}=:{}:",
                        STANDARD.encode(self.mac(&header, params))
                    )],
                    signature_input: vec![format!("{label}={params}")],
                    commit: vec![header],
                }
            }

            fn honest(&self) -> CommitResponseHeaders {
                self.response(&self.members(), &self.params(), "mac")
            }

            fn body(&self) -> Value {
                json!({
                    "ver": 1,
                    "repo": self.repo,
                    "space": self.space,
                    "rev": self.rev,
                    "data": lex_bytes(&self.data),
                })
            }

            fn verify(
                &self,
                headers: &CommitResponseHeaders,
                body: &Value,
            ) -> Result<MacVerifiedCommit, MacVerifyError> {
                verify_commit_response(self.context(&self.repo, &self.space), headers, body)
            }
        }

        const SEEDS: u64 = 48;

        fn exchanges() -> impl Iterator<Item = Exchange> {
            (1..=SEEDS).map(|seed| {
                let mut rng = Xorshift(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
                Exchange::new(&mut rng)
            })
        }

        #[test]
        fn a_valid_response_is_accepted_and_returns_the_commit() {
            for exchange in exchanges() {
                let commit = exchange
                    .verify(&exchange.honest(), &exchange.body())
                    .expect("valid response");
                assert_eq!(commit.repo(), exchange.repo);
                assert_eq!(commit.space(), exchange.space);
                assert_eq!(commit.rev(), exchange.rev);
                assert_eq!(commit.data(), &exchange.data);
            }
        }

        // Generated cases: every one of these changes a valid response in one
        // way and must be refused.
        #[test]
        fn one_change_to_a_valid_response_is_refused() {
            for exchange in exchanges() {
                let honest = exchange.honest();
                let body = exchange.body();
                let refused = |name: &str, headers: &CommitResponseHeaders, body: &Value| {
                    let outcome = exchange.verify(headers, body);
                    assert!(outcome.is_err(), "{name}: {outcome:?}");
                };
                let input = &honest.signature_input[0];

                let mut dropped_tag = honest.clone();
                dropped_tag.signature_input = vec![input.replace(";tag=", ";tug=")];
                refused("tag dropped", &dropped_tag, &body);

                let mut two_tagged = honest.clone();
                two_tagged.signature_input = vec![format!("{input}, faye=();tag=\"{COVERED}\"")];
                refused("two tagged members", &two_tagged, &body);

                let mut header_repo = honest.clone();
                header_repo.commit =
                    vec![header_repo.commit[0].replacen(&exchange.repo, "did:plc:jetblack", 1)];
                assert_eq!(
                    exchange.verify(&header_repo, &body).err(),
                    Some(MacVerifyError::MacMismatch)
                );

                for (field, value) in [
                    ("ver", json!(2)),
                    ("repo", json!("did:plc:jetblack")),
                    (
                        "space",
                        json!("at:space/did:web:ein.example/zone.stratos.space.feed/x"),
                    ),
                    ("rev", json!("2222222222222")),
                    ("data", lex_bytes(&[7; 32])),
                ] {
                    let mut changed = body.clone();
                    changed[field] = value;
                    refused(field, &honest, &changed);
                }

                for (repo, space) in [
                    ("did:plc:jetblack", exchange.space.as_str()),
                    (
                        exchange.repo.as_str(),
                        "at:space/did:web:ein.example/zone.stratos.space.feed/x",
                    ),
                ] {
                    let outcome =
                        verify_commit_response(exchange.context(repo, space), &honest, &body);
                    assert_eq!(
                        outcome.err(),
                        Some(MacVerifyError::Invalid(MacDefect::RequestMismatch))
                    );
                }

                let mut members = exchange.members();
                members.rotate_left(1 + (exchange.data[0] as usize % 4));
                let mut reordered = honest.clone();
                reordered.commit = vec![members.join(", ")];
                assert_eq!(
                    exchange.verify(&reordered, &body).err(),
                    Some(MacVerifyError::MacMismatch)
                );

                let mac = exchange.mac(&honest.commit[0], &exchange.params());
                let mut truncated = honest.clone();
                truncated.signature =
                    vec![format!("mac=:{}:", STANDARD.encode(&mac[..mac.len() - 1]))];
                assert_eq!(
                    exchange.verify(&truncated, &body).err(),
                    Some(MacVerifyError::MacMismatch)
                );

                let second_component = format!(
                    "(\"{COVERED}\";sf \"content-type\");keyid=\"{}\";tag=\"{COVERED}\"",
                    exchange.key_share
                );
                refused(
                    "second covered component",
                    &exchange.response(&exchange.members(), &second_component, "mac"),
                    &body,
                );

                let other_key = exchange.params().replace(
                    &exchange.key_share,
                    "did:key:zDnaeWa2Nsx8xsu5Qb8K5eSBXHkBvmauc1pgwZ5mjP92wFr5J",
                );
                refused(
                    "another key share",
                    &exchange.response(&exchange.members(), &other_key, "mac"),
                    &body,
                );

                let mut signature_with_parameter = honest.clone();
                signature_with_parameter.signature = vec![format!("{};x=1", honest.signature[0])];
                refused(
                    "a parameter on the signature",
                    &signature_with_parameter,
                    &body,
                );

                let mut wrong_label = honest.clone();
                wrong_label.signature = vec![honest.signature[0].replace("mac=", "faye=")];
                refused("no signature under the label", &wrong_label, &body);
            }
        }

        #[test]
        fn changes_the_oracle_also_accepts_are_accepted() {
            for exchange in exchanges() {
                let body = exchange.body();

                let mut members = exchange.members();
                members.rotate_left(1 + (exchange.data[1] as usize % 4));
                let reordered = exchange.response(&members, &exchange.params(), "mac");
                assert!(
                    exchange.verify(&reordered, &body).is_ok(),
                    "reordered, new mac"
                );

                let without_keyid = format!("(\"{COVERED}\";sf);tag=\"{COVERED}\"");
                let response = exchange.response(&exchange.members(), &without_keyid, "mac");
                assert!(exchange.verify(&response, &body).is_ok(), "no keyid");

                let with_created = format!(
                    "(\"{COVERED}\";sf);created=893000000;keyid=\"{}\";tag=\"{COVERED}\"",
                    exchange.key_share
                );
                let response = exchange.response(&exchange.members(), &with_created, "faye");
                assert!(exchange.verify(&response, &body).is_ok(), "other parameter");

                let mut extra = exchange.members();
                extra.push("note=\"swordfish\";mood=bored".to_owned());
                let response = exchange.response(&extra, &exchange.params(), "mac");
                assert!(exchange.verify(&response, &body).is_ok(), "extra member");
            }
        }

        // Stricter than the oracle on purpose: the oracle MACs a byte sequence
        // as received and `1.0` as `1`, this verifier would MAC the padded
        // bytes and `1.0`. Such a field is refused before the MAC, so it is
        // never taken for a stale key.
        #[test]
        fn a_field_the_two_parsers_serialize_differently_is_invalid_not_a_mismatch() {
            for exchange in exchanges().take(8) {
                let body = exchange.body();
                let params = exchange.params();
                let padded = STANDARD.encode(exchange.data);
                let unpadded = padded.trim_end_matches('=');
                assert_ne!(unpadded, padded);
                let with_data = |data: &str| {
                    let mut members = exchange.members();
                    members[4] = format!("data=:{data}:");
                    members.join(", ")
                };
                let with_extra = |extra: &str| {
                    let mut members = exchange.members();
                    members.push(extra.to_owned());
                    members.join(", ")
                };
                let signed = |header: String, mac_over: &str, params: &str| CommitResponseHeaders {
                    commit: vec![header],
                    signature_input: vec![format!("mac={params}")],
                    signature: vec![format!(
                        "mac=:{}:",
                        STANDARD.encode(exchange.mac(mac_over, params))
                    )],
                };
                let created = format!(
                    "(\"{COVERED}\";sf);created=893000000.0;keyid=\"{}\";tag=\"{COVERED}\"",
                    exchange.key_share
                );
                let mut unpadded_signature = exchange.honest();
                unpadded_signature.signature = vec![format!(
                    "mac=:{}:",
                    STANDARD
                        .encode(exchange.mac(&exchange.members().join(", "), &params))
                        .trim_end_matches('=')
                )];
                let cases = [
                    (
                        "unpadded data, MAC over the text received",
                        signed(with_data(unpadded), &with_data(unpadded), &params),
                        MacDefect::NonCanonicalByteSequence,
                    ),
                    (
                        "unpadded data, MAC over the padded text",
                        signed(with_data(unpadded), &with_data(&padded), &params),
                        MacDefect::NonCanonicalByteSequence,
                    ),
                    (
                        "extra member x=1.0, MAC over the text received",
                        signed(with_extra("x=1.0"), &with_extra("x=1.0"), &params),
                        MacDefect::DecimalValue,
                    ),
                    (
                        "extra member x=1.0, MAC over x=1",
                        signed(with_extra("x=1.0"), &with_extra("x=1"), &params),
                        MacDefect::DecimalValue,
                    ),
                    (
                        "a decimal signature parameter, MAC over it",
                        signed(
                            exchange.members().join(", "),
                            &exchange.members().join(", "),
                            &created,
                        ),
                        MacDefect::DecimalValue,
                    ),
                    (
                        "an unpadded signature",
                        unpadded_signature,
                        MacDefect::NonCanonicalByteSequence,
                    ),
                ];
                for (name, headers, defect) in cases {
                    assert_eq!(
                        exchange.verify(&headers, &body).err(),
                        Some(MacVerifyError::Invalid(defect)),
                        "{name}"
                    );
                }
            }
        }

        #[test]
        fn a_header_of_4097_bytes_is_refused_for_each_of_the_three_headers() {
            let exchange = exchanges().next().unwrap();
            let body = exchange.body();
            let padded = |text: &str| {
                let filler = MAX_FIELD_BYTES + 1 - text.len() - ", note=\"\"".len();
                format!("{text}, note=\"{}\"", "a".repeat(filler))
            };
            let honest = exchange.honest();
            let mut commit = honest.clone();
            commit.commit = vec![padded(&honest.commit[0])];
            let mut input = honest.clone();
            input.signature_input = vec![padded(&honest.signature_input[0])];
            let mut signature = honest.clone();
            signature.signature = vec![padded(&honest.signature[0])];
            for (name, headers) in [
                ("commit", commit),
                ("input", input),
                ("signature", signature),
            ] {
                let field = [
                    &headers.commit,
                    &headers.signature_input,
                    &headers.signature,
                ]
                .into_iter()
                .map(|values| values[0].len())
                .max()
                .unwrap();
                assert_eq!(field, MAX_FIELD_BYTES + 1, "{name}");
                assert_eq!(
                    exchange.verify(&headers, &body).err(),
                    Some(MacVerifyError::Invalid(MacDefect::HeaderTooLong)),
                    "{name}"
                );
            }
        }

        #[test]
        fn a_dictionary_of_17_members_is_refused_for_each_of_the_three_headers() {
            let exchange = exchanges().next().unwrap();
            let body = exchange.body();
            let padded = |text: &str, members_now: usize| {
                let extra = (0..MAX_DICTIONARY_MEMBERS + 1 - members_now)
                    .map(|index| format!("k{index}=1"))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{text}, {extra}")
            };
            let honest = exchange.honest();
            let mut commit = honest.clone();
            commit.commit = vec![padded(&honest.commit[0], 5)];
            let mut input = honest.clone();
            input.signature_input = vec![padded(&honest.signature_input[0], 1)];
            let mut signature = honest.clone();
            signature.signature = vec![padded(&honest.signature[0], 1)];
            for (name, headers) in [
                ("commit", commit),
                ("input", input),
                ("signature", signature),
            ] {
                assert_eq!(
                    exchange.verify(&headers, &body).err(),
                    Some(MacVerifyError::Invalid(MacDefect::TooManyMembers)),
                    "{name}"
                );
            }
        }

        #[test]
        fn each_header_must_appear_exactly_once() {
            let exchange = exchanges().next().unwrap();
            let body = exchange.body();
            let honest = exchange.honest();
            let mut cases = Vec::new();
            for which in 0..3 {
                let mut missing = honest.clone();
                let mut repeated = honest.clone();
                for (headers, values) in [(&mut missing, 0), (&mut repeated, 2)] {
                    let slot = match which {
                        0 => &mut headers.commit,
                        1 => &mut headers.signature_input,
                        _ => &mut headers.signature,
                    };
                    let first = slot[0].clone();
                    *slot = (0..values).map(|_| first.clone()).collect();
                }
                cases.push((which, missing, MacDefect::HeaderMissing));
                cases.push((which, repeated, MacDefect::HeaderRepeated));
            }
            for (which, headers, defect) in cases {
                assert_eq!(
                    exchange.verify(&headers, &body).err(),
                    Some(MacVerifyError::Invalid(defect)),
                    "header {which}"
                );
            }
        }

        #[test]
        fn the_body_commit_must_hold_exactly_typed_fields() {
            let exchange = exchanges().next().unwrap();
            let honest = exchange.honest();
            let bodies = [
                Value::Null,
                json!([]),
                json!({}),
                json!({ "ver": 1.0, "repo": exchange.repo, "space": exchange.space, "rev": exchange.rev, "data": lex_bytes(&exchange.data) }),
                json!({ "ver": 1, "repo": exchange.repo, "space": exchange.space, "rev": exchange.rev, "data": STANDARD.encode(exchange.data) }),
                json!({ "ver": 1, "repo": exchange.repo, "space": exchange.space, "rev": exchange.rev, "data": { "$bytes": "AAAA", "extra": 1 } }),
                json!({ "ver": 1, "repo": 5, "space": exchange.space, "rev": exchange.rev, "data": lex_bytes(&exchange.data) }),
            ];
            for body in bodies {
                assert!(exchange.verify(&honest, &body).is_err(), "{body}");
            }
            let mut extra = exchange.body();
            extra["note"] = json!("ignored");
            assert!(exchange.verify(&honest, &extra).is_ok());
        }

        #[test]
        fn a_response_made_for_one_request_does_not_verify_for_another() {
            let mut rng = Xorshift(0x1234_5678_9abc_def1);
            let first = Exchange::new(&mut rng);
            let second = Exchange::new(&mut rng);
            let response = first.honest();
            let outcome = verify_commit_response(
                second.context(&first.repo, &first.space),
                &response,
                &first.body(),
            );
            assert_eq!(
                outcome.err(),
                Some(MacVerifyError::Invalid(MacDefect::KeyShareMismatch))
            );
        }

        #[test]
        fn neither_the_context_nor_an_error_shows_the_secret_or_header_text() {
            let exchange = exchanges().next().unwrap();
            let context = exchange.context(&exchange.repo, &exchange.space);
            let debug = format!("{context:?}");
            for secret_form in [
                STANDARD.encode(exchange.secret),
                exchange
                    .secret
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                format!("{:?}", exchange.secret),
            ] {
                assert!(!debug.contains(&secret_form));
            }

            let hostile = "ver=1, note=\"swordfish\nleak\"";
            let mut headers = exchange.honest();
            headers.commit = vec![hostile.to_owned()];
            let error = exchange.verify(&headers, &exchange.body()).err().unwrap();
            for text in [error.to_string(), format!("{error:?}")] {
                assert!(
                    !text.contains("swordfish") && !text.contains('\n'),
                    "{text}"
                );
            }
        }
    }

    // Cross-check: the constants below are what the Rust code makes for the
    // fixed ephemeral key; the fixture generator feeds them to the oracle, and
    // a fixture test requires that they still appear in this file.
    mod oracle_cross_check {
        use super::*;

        const STRATOS_PRODUCED: &str =
            include_str!("../../test/spaces-alignment/november/fixtures/stratos-produced.json");
        const FIXED_ACCEPT_SIGNATURE: &str = "mac=(\"atproto-space-commit\";sf);keyid=\"did:key:zDnaeoA2SUkGYYDAVZBKgd4xWMGadgX2U29YPw8iEvCuELmfi\";tag=\"atproto-space-commit\"";
        const FIXED_SHARED_SECRET_BASE64: &str = "2XYP6iF5whnXMOd8HStZcRr/FOrpIZNfLnyoleNwbw4=";

        fn rust_derived_secret() -> crate::space_kem::RequestSecret {
            encapsulate_with_ephemeral_key(&author_key(), &fixture_ephemeral_key()).expect("secret")
        }

        #[test]
        fn the_fixed_ephemeral_key_gives_the_pinned_request_header_and_secret() {
            let secret = rust_derived_secret();
            assert_eq!(STANDARD.encode(secret.secret()), FIXED_SHARED_SECRET_BASE64);
            let context = MacRequestContext::new(secret, "did:plc:fayevalentine", "unused");
            assert_eq!(context.accept_signature(), FIXED_ACCEPT_SIGNATURE);
        }

        #[test]
        fn the_oracle_response_to_the_rust_request_verifies_with_the_rust_derived_context() {
            let fixture: Value = serde_json::from_str(STRATOS_PRODUCED).expect("fixture");
            let entry = &fixture["rustMacRequest"];
            assert_eq!(entry["acceptSignature"], FIXED_ACCEPT_SIGNATURE);
            assert_eq!(entry["sharedSecret"]["value"], FIXED_SHARED_SECRET_BASE64);
            let commit = &entry["commit"];
            let body = json!({
                "ver": commit["ver"],
                "repo": commit["repo"],
                "space": commit["space"],
                "rev": commit["rev"],
                "data": {
                    "$bytes": commit["data"]["value"].as_str().expect("data").trim_end_matches('=')
                },
            });
            let headers = &entry["responseHeaders"];
            let received = |name: &str| vec![headers[name].as_str().expect("header").to_owned()];
            let response = CommitResponseHeaders {
                commit: received(COVERED),
                signature_input: received("signature-input"),
                signature: received("signature"),
            };
            let context = MacRequestContext::new(
                rust_derived_secret(),
                commit["repo"].as_str().expect("repo"),
                commit["space"].as_str().expect("space"),
            );

            let verified = verify_commit_response(context, &response, &body).expect("verified");

            assert_eq!(verified.repo(), commit["repo"].as_str().unwrap());
            assert_eq!(verified.space(), commit["space"].as_str().unwrap());
            assert_eq!(verified.rev(), commit["rev"].as_str().unwrap());
            assert_eq!(
                verified.data().as_slice(),
                STANDARD
                    .decode(commit["data"]["value"].as_str().unwrap())
                    .unwrap()
            );
        }
    }
}
