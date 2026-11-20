use serde::Deserialize;
use serde_json::Value;

use crate::identifier::{Did, RecordUri};

const TAKEDOWN_VALUE: &str = "!takedown";
const RECORD_SUBJECT_TYPE: &str = "zone.stratos.moderation.defs#recordSubject";
const ACCOUNT_SUBJECT_TYPE: &str = "zone.stratos.moderation.defs#accountSubject";
const MAX_SUBJECT_URI_BYTES: usize = 2048;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LabelSubject {
    Record { uri: String, author_did: String },
    Account { did: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModerationLabel {
    pub seq: u64,
    pub subject: LabelSubject,
    pub neg: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LabelPage {
    pub cursor: u64,
    pub labels: Vec<ModerationLabel>,
    /// Record subjects whose URI is no record URI, so no stored row can name them.
    pub skipped_subjects: usize,
}

enum ParsedSubject {
    Subject(LabelSubject),
    Ignored,
    UnparseableRecordUri,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LabelPageError {
    InvalidJson,
    InvalidCursor,
    TooManyLabels,
    InvalidSequence,
    InvalidSubject,
    MissingCreatedAt,
}

impl std::fmt::Display for LabelPageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidJson => "label page is not valid JSON",
            Self::InvalidCursor => "label page cursor is invalid",
            Self::TooManyLabels => "label page exceeds the requested limit",
            Self::InvalidSequence => "label page sequence is invalid",
            Self::InvalidSubject => "label page subject is invalid",
            Self::MissingCreatedAt => "label page label has no creation time",
        })
    }
}

impl std::error::Error for LabelPageError {}

#[derive(Deserialize)]
struct RawPage {
    cursor: Option<String>,
    labels: Vec<RawLabel>,
}

#[derive(Deserialize)]
struct RawLabel {
    seq: Option<u64>,
    subject: Option<Value>,
    val: Option<String>,
    neg: Option<bool>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
}

/// The whole page is rejected on any structural fault so a consumer never
/// advances its cursor past labels it could not read. A record subject whose
/// URI is within bounds but is no record URI is skipped and counted instead.
pub fn parse_label_page(
    body: &[u8],
    request_cursor: u64,
    limit: u16,
) -> Result<LabelPage, LabelPageError> {
    let raw: RawPage = serde_json::from_slice(body).map_err(|_| LabelPageError::InvalidJson)?;
    let cursor = parse_decimal_cursor(raw.cursor.as_deref())?;
    if cursor < request_cursor {
        return Err(LabelPageError::InvalidCursor);
    }
    if raw.labels.len() > usize::from(limit) {
        return Err(LabelPageError::TooManyLabels);
    }
    let mut previous_seq = request_cursor;
    let mut labels = Vec::new();
    let mut skipped_subjects = 0;
    for raw_label in raw.labels {
        let seq = raw_label.seq.ok_or(LabelPageError::InvalidSequence)?;
        if seq <= previous_seq || seq > cursor {
            return Err(LabelPageError::InvalidSequence);
        }
        previous_seq = seq;
        if raw_label.created_at.is_none() {
            return Err(LabelPageError::MissingCreatedAt);
        }
        if raw_label.val.as_deref() != Some(TAKEDOWN_VALUE) {
            continue;
        }
        let subject = match parse_subject(raw_label.subject.as_ref())? {
            ParsedSubject::Subject(subject) => subject,
            ParsedSubject::Ignored => continue,
            ParsedSubject::UnparseableRecordUri => {
                skipped_subjects += 1;
                continue;
            }
        };
        labels.push(ModerationLabel {
            seq,
            subject,
            neg: raw_label.neg.unwrap_or(false),
        });
    }
    Ok(LabelPage {
        cursor,
        labels,
        skipped_subjects,
    })
}

fn parse_decimal_cursor(cursor: Option<&str>) -> Result<u64, LabelPageError> {
    let cursor = cursor.ok_or(LabelPageError::InvalidCursor)?;
    if cursor.is_empty() || !cursor.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(LabelPageError::InvalidCursor);
    }
    cursor.parse().map_err(|_| LabelPageError::InvalidCursor)
}

fn parse_subject(subject: Option<&Value>) -> Result<ParsedSubject, LabelPageError> {
    let Some(subject) = subject else {
        return Err(LabelPageError::InvalidSubject);
    };
    let kind = subject.get("$type").and_then(Value::as_str);
    match kind {
        Some(RECORD_SUBJECT_TYPE) => {
            let uri = subject
                .get("uri")
                .and_then(Value::as_str)
                .filter(|uri| uri.len() <= MAX_SUBJECT_URI_BYTES)
                .ok_or(LabelPageError::InvalidSubject)?;
            let Ok(parsed) = RecordUri::parse(uri) else {
                return Ok(ParsedSubject::UnparseableRecordUri);
            };
            Ok(ParsedSubject::Subject(LabelSubject::Record {
                uri: uri.to_owned(),
                author_did: parsed.author().as_str().to_owned(),
            }))
        }
        Some(ACCOUNT_SUBJECT_TYPE) => {
            let did = subject
                .get("did")
                .and_then(Value::as_str)
                .ok_or(LabelPageError::InvalidSubject)?;
            Did::parse(did).map_err(|_| LabelPageError::InvalidSubject)?;
            Ok(ParsedSubject::Subject(LabelSubject::Account {
                did: did.to_owned(),
            }))
        }
        // Skipping an unreadable takedown would advance the cursor past it.
        None => Err(LabelPageError::InvalidSubject),
        Some(_) => Ok(ParsedSubject::Ignored),
    }
}

#[cfg(test)]
mod tests {
    use super::{LabelPageError, LabelSubject, parse_label_page};

    const REPO_URI: &str = "at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1";
    const SPACE_URI: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";

    fn record_label(seq: u64, uri: &str) -> String {
        format!(
            r##"{{"seq":{seq},"subject":{{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"{uri}"}},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}}"##
        )
    }

    fn page(cursor: &str, labels: &[String]) -> Vec<u8> {
        format!(r#"{{"cursor":"{cursor}","labels":[{}]}}"#, labels.join(",")).into_bytes()
    }

    #[test]
    fn parses_repo_space_and_account_labels() {
        let account = r##"{"seq":3,"subject":{"$type":"zone.stratos.moderation.defs#accountSubject","did":"did:plc:edwardwong"},"val":"!takedown","neg":true,"createdAt":"2026-11-01T00:00:00Z"}"##;
        let body = page(
            "3",
            &[
                record_label(1, REPO_URI),
                record_label(2, SPACE_URI),
                account.to_owned(),
            ],
        );
        let parsed = parse_label_page(&body, 0, 100).unwrap();
        assert_eq!(parsed.cursor, 3);
        assert_eq!(parsed.labels.len(), 3);
        assert_eq!(
            parsed.labels[0].subject,
            LabelSubject::Record {
                uri: REPO_URI.to_owned(),
                author_did: "did:plc:spikespiegel".to_owned()
            }
        );
        assert!(!parsed.labels[0].neg);
        assert_eq!(
            parsed.labels[1].subject,
            LabelSubject::Record {
                uri: SPACE_URI.to_owned(),
                author_did: "did:plc:fayevalentine".to_owned()
            }
        );
        assert_eq!(
            parsed.labels[2].subject,
            LabelSubject::Account {
                did: "did:plc:edwardwong".to_owned()
            }
        );
        assert!(parsed.labels[2].neg);
    }

    #[test]
    fn rejects_the_whole_page_on_any_structural_fault() {
        let long_uri = format!(
            "at://did:plc:spikespiegel/zone.stratos.feed.post/{}",
            "a".repeat(2100)
        );
        let no_created_at = r##"{"seq":1,"subject":{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1"},"val":"!takedown"}"##;
        let no_seq = r##"{"subject":{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1"},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let bad_account = r##"{"seq":1,"subject":{"$type":"zone.stratos.moderation.defs#accountSubject","did":"not-a-did"},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let untyped_takedown = r##"{"seq":1,"subject":{"uri":"at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1"},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let non_string_type_takedown = r##"{"seq":1,"subject":{"$type":7,"did":"did:plc:spikespiegel"},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let scalar_subject_takedown = r##"{"seq":1,"subject":"did:plc:spikespiegel","val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let subjectless_takedown =
            r##"{"seq":1,"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let uriless_record_subject = r##"{"seq":1,"subject":{"$type":"zone.stratos.moderation.defs#recordSubject"},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let numeric_uri_record_subject = r##"{"seq":1,"subject":{"$type":"zone.stratos.moderation.defs#recordSubject","uri":7},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let cases: Vec<(&str, Vec<u8>, u64, u16)> = vec![
            ("invalid json", b"{".to_vec(), 0, 100),
            ("missing cursor", br#"{"labels":[]}"#.to_vec(), 0, 100),
            (
                "numeric cursor",
                br#"{"cursor":3,"labels":[]}"#.to_vec(),
                0,
                100,
            ),
            ("signed cursor", page("-1", &[]), 0, 100),
            ("non-decimal cursor", page("0x10", &[]), 0, 100),
            (
                "cursor above u64",
                page("18446744073709551616", &[]),
                0,
                100,
            ),
            ("cursor below request", page("4", &[]), 5, 100),
            (
                "more labels than limit",
                page("2", &[record_label(1, REPO_URI), record_label(2, REPO_URI)]),
                0,
                1,
            ),
            ("missing seq", page("1", &[no_seq.to_owned()]), 0, 100),
            (
                "seq at request cursor",
                page("5", &[record_label(5, REPO_URI)]),
                5,
                100,
            ),
            (
                "seq above cursor",
                page("1", &[record_label(2, REPO_URI)]),
                0,
                100,
            ),
            (
                "seq not increasing",
                page("5", &[record_label(3, REPO_URI), record_label(3, REPO_URI)]),
                0,
                100,
            ),
            (
                "seq decreasing",
                page("5", &[record_label(4, REPO_URI), record_label(2, REPO_URI)]),
                0,
                100,
            ),
            (
                "record subject without a uri",
                page("1", &[uriless_record_subject.to_owned()]),
                0,
                100,
            ),
            (
                "record subject with a numeric uri",
                page("1", &[numeric_uri_record_subject.to_owned()]),
                0,
                100,
            ),
            (
                "oversized record uri",
                page("1", &[record_label(1, &long_uri)]),
                0,
                100,
            ),
            (
                "invalid account did",
                page("1", &[bad_account.to_owned()]),
                0,
                100,
            ),
            (
                "missing createdAt",
                page("1", &[no_created_at.to_owned()]),
                0,
                100,
            ),
            (
                "takedown subject without $type",
                page("1", &[untyped_takedown.to_owned()]),
                0,
                100,
            ),
            (
                "takedown subject with a non-string $type",
                page("1", &[non_string_type_takedown.to_owned()]),
                0,
                100,
            ),
            (
                "takedown subject that is not an object",
                page("1", &[scalar_subject_takedown.to_owned()]),
                0,
                100,
            ),
            (
                "takedown without a subject",
                page("1", &[subjectless_takedown.to_owned()]),
                0,
                100,
            ),
        ];
        for (name, body, request_cursor, limit) in cases {
            assert!(
                parse_label_page(&body, request_cursor, limit).is_err(),
                "{name} must reject the page"
            );
        }
    }

    #[test]
    fn skips_unknown_subject_types_and_other_values() {
        let unknown_subject = r##"{"seq":1,"subject":{"$type":"zone.stratos.moderation.defs#cometSubject","id":"ein"},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let other_value = r##"{"seq":2,"subject":{"$type":"zone.stratos.moderation.defs#recordSubject","uri":"at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1"},"val":"spam","createdAt":"2026-11-01T00:00:00Z"}"##;
        let body = page(
            "3",
            &[
                unknown_subject.to_owned(),
                other_value.to_owned(),
                record_label(3, REPO_URI),
            ],
        );
        let parsed = parse_label_page(&body, 0, 100).unwrap();
        assert_eq!(parsed.cursor, 3);
        assert_eq!(parsed.labels.len(), 1);
        assert_eq!(parsed.labels[0].seq, 3);
    }

    #[test]
    fn other_values_are_skipped_whatever_their_subject() {
        let untyped = r##"{"seq":1,"subject":{"uri":"at://did:plc:spikespiegel/zone.stratos.feed.post/bebop1"},"val":"spam","createdAt":"2026-11-01T00:00:00Z"}"##;
        let subjectless = r##"{"seq":2,"val":"spam","createdAt":"2026-11-01T00:00:00Z"}"##;
        let scalar =
            r##"{"seq":3,"subject":"ein","val":"spam","createdAt":"2026-11-01T00:00:00Z"}"##;
        let body = page(
            "4",
            &[
                untyped.to_owned(),
                subjectless.to_owned(),
                scalar.to_owned(),
                record_label(4, REPO_URI),
            ],
        );
        let parsed = parse_label_page(&body, 0, 100).unwrap();
        assert_eq!(parsed.cursor, 4);
        assert_eq!(parsed.labels.len(), 1);
        assert_eq!(parsed.labels[0].seq, 4);
    }

    #[test]
    fn errors_carry_no_input_text() {
        let untyped = r##"{"seq":1,"subject":{"uri":"https://leak.example.test/ed"},"val":"!takedown","createdAt":"2026-11-01T00:00:00Z"}"##;
        let body = page("1", &[untyped.to_owned()]);
        let error = parse_label_page(&body, 0, 100).unwrap_err();
        assert_eq!(error, LabelPageError::InvalidSubject);
        for text in [error.to_string(), format!("{error:?}")] {
            assert!(!text.contains("leak.example.test"));
        }
    }

    const LEGACY_SPACE_URI: &str = "at://did:web:stratos.example.test/space/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/swordfish";

    fn negated_record_label(seq: u64, uri: &str) -> String {
        record_label(seq, uri).replace(r#""val":"!takedown""#, r#""val":"!takedown","neg":true"#)
    }

    #[test]
    fn skips_and_counts_a_takedown_whose_uri_is_no_record_uri() {
        for unparseable in [
            "https://example.test/x",
            LEGACY_SPACE_URI,
            "at://did:plc:spikespiegel/zone.stratos.feed.post/",
        ] {
            let body = page(
                "3",
                &[
                    record_label(1, REPO_URI),
                    record_label(2, unparseable),
                    record_label(3, SPACE_URI),
                ],
            );
            let parsed = parse_label_page(&body, 0, 100).unwrap();
            assert_eq!(parsed.cursor, 3, "{unparseable}");
            assert_eq!(
                parsed
                    .labels
                    .iter()
                    .map(|label| label.seq)
                    .collect::<Vec<_>>(),
                [1, 3],
                "{unparseable}"
            );
            assert_eq!(parsed.skipped_subjects, 1, "{unparseable}");
        }
    }

    #[test]
    fn skips_and_counts_a_negation_whose_uri_is_no_record_uri() {
        let body = page(
            "3",
            &[
                record_label(1, REPO_URI),
                negated_record_label(2, LEGACY_SPACE_URI),
                negated_record_label(3, SPACE_URI),
            ],
        );
        let parsed = parse_label_page(&body, 0, 100).unwrap();
        assert_eq!(parsed.cursor, 3);
        assert_eq!(
            parsed
                .labels
                .iter()
                .map(|label| (label.seq, label.neg))
                .collect::<Vec<_>>(),
            [(1, false), (3, true)]
        );
        assert_eq!(parsed.skipped_subjects, 1);
    }

    #[test]
    fn counts_only_takedowns_it_could_not_read() {
        let spam = record_label(1, LEGACY_SPACE_URI).replace("!takedown", "spam");
        let body = page("2", &[spam, record_label(2, REPO_URI)]);
        let parsed = parse_label_page(&body, 0, 100).unwrap();
        assert_eq!(parsed.labels.len(), 1);
        assert_eq!(parsed.skipped_subjects, 0);
    }

    #[test]
    fn a_page_of_readable_subjects_skips_nothing() {
        let body = page(
            "2",
            &[record_label(1, REPO_URI), record_label(2, SPACE_URI)],
        );
        assert_eq!(parse_label_page(&body, 0, 100).unwrap().skipped_subjects, 0);
    }
}
