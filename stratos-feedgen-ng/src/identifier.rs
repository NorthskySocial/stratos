use std::fmt;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Did(String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdentifierError {
    InvalidDid,
    InvalidRecordUri,
}

impl fmt::Display for IdentifierError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDid => formatter.write_str("invalid DID"),
            Self::InvalidRecordUri => formatter.write_str("invalid record URI"),
        }
    }
}

impl std::error::Error for IdentifierError {}

impl fmt::Display for Did {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

const MAX_DID_BYTES: usize = 2048;

impl Did {
    pub fn parse(value: impl Into<String>) -> Result<Self, IdentifierError> {
        let value = value.into();
        let Some((method, identifier)) = value
            .strip_prefix("did:")
            .and_then(|rest| rest.split_once(':'))
        else {
            return Err(IdentifierError::InvalidDid);
        };
        if value.len() > MAX_DID_BYTES
            || method.is_empty()
            || identifier.is_empty()
            || !method.bytes().all(|byte| byte.is_ascii_lowercase())
            || identifier.ends_with(':')
            || !is_valid_did_identifier(identifier)
        {
            return Err(IdentifierError::InvalidDid);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

const SPACE_URI_PREFIX: &str = "at:space/";
const REPO_URI_PREFIX: &str = "at://";
const SPACE_PARTS: usize = 3;
const SPACE_RECORD_PARTS: usize = 6;

/// The one space type this feed generator syncs.
pub const FEED_SPACE_TYPE: &str = "zone.stratos.space.feed";

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SpaceUri {
    authority: Did,
    space_type: String,
    space_key: String,
}

impl SpaceUri {
    pub fn new(
        authority: &str,
        space_type: &str,
        space_key: &str,
    ) -> Result<Self, IdentifierError> {
        Ok(Self {
            authority: Did::parse(authority)?,
            space_type: validated_nsid(space_type)?,
            space_key: validated_space_key(space_key)?,
        })
    }

    pub fn parse(value: &str) -> Result<Self, IdentifierError> {
        match split_space_parts(value)?.as_slice() {
            [authority, space_type, space_key] => Self::new(authority, space_type, space_key),
            _ => Err(IdentifierError::InvalidRecordUri),
        }
    }

    pub fn authority(&self) -> &Did {
        &self.authority
    }

    pub fn space_type(&self) -> &str {
        &self.space_type
    }

    pub fn space_key(&self) -> &str {
        &self.space_key
    }

    pub fn record_uri(&self, author: &Did, collection: &str, rkey: &str) -> String {
        format!("{self}/{author}/{collection}/{rkey}")
    }

    /// Prefix shared by every space URI and space record URI of one authority.
    pub fn authority_prefix(authority: &str) -> String {
        format!("{SPACE_URI_PREFIX}{authority}/")
    }
}

impl fmt::Display for SpaceUri {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{SPACE_URI_PREFIX}{}/{}/{}",
            self.authority, self.space_type, self.space_key
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecordUri {
    Repo {
        author: Did,
        collection: String,
        rkey: String,
    },
    Space {
        authority: Did,
        space_type: String,
        space_key: String,
        author: Did,
        collection: String,
        rkey: String,
    },
}

impl RecordUri {
    pub fn parse(value: &str) -> Result<Self, IdentifierError> {
        if value.starts_with(SPACE_URI_PREFIX) {
            return match split_space_parts(value)?.as_slice() {
                [authority, space_type, space_key, author, collection, rkey] => {
                    let space = SpaceUri::new(authority, space_type, space_key)?;
                    Ok(Self::Space {
                        authority: space.authority,
                        space_type: space.space_type,
                        space_key: space.space_key,
                        author: Did::parse(*author)?,
                        collection: validated_nsid(collection)?,
                        rkey: validated_record_key(rkey)?,
                    })
                }
                _ => Err(IdentifierError::InvalidRecordUri),
            };
        }
        let value = value
            .strip_prefix(REPO_URI_PREFIX)
            .ok_or(IdentifierError::InvalidRecordUri)?;
        let segments: Vec<&str> = value.split('/').collect();
        match segments.as_slice() {
            [author, collection, rkey] if segments.iter().all(|segment| !segment.is_empty()) => {
                Ok(Self::Repo {
                    author: Did::parse(*author)?,
                    collection: validated_nsid(collection)?,
                    rkey: validated_record_key(rkey)?,
                })
            }
            _ => Err(IdentifierError::InvalidRecordUri),
        }
    }

    pub fn parse_space_record(value: &str) -> Result<Self, IdentifierError> {
        match Self::parse(value)? {
            space @ Self::Space { .. } => Ok(space),
            Self::Repo { .. } => Err(IdentifierError::InvalidRecordUri),
        }
    }

    pub fn author(&self) -> &Did {
        match self {
            Self::Repo { author, .. } | Self::Space { author, .. } => author,
        }
    }

    pub fn authority(&self) -> &Did {
        match self {
            Self::Repo { author, .. } => author,
            Self::Space { authority, .. } => authority,
        }
    }

    /// The space a space record belongs to; a custody record belongs to none.
    pub fn space(&self) -> Option<SpaceUri> {
        match self {
            Self::Repo { .. } => None,
            Self::Space {
                authority,
                space_type,
                space_key,
                ..
            } => Some(SpaceUri {
                authority: authority.clone(),
                space_type: space_type.clone(),
                space_key: space_key.clone(),
            }),
        }
    }
}

fn split_space_parts(value: &str) -> Result<Vec<&str>, IdentifierError> {
    let parts: Vec<&str> = value
        .strip_prefix(SPACE_URI_PREFIX)
        .ok_or(IdentifierError::InvalidRecordUri)?
        .split('/')
        .collect();
    let counted = parts.len() == SPACE_PARTS || parts.len() == SPACE_RECORD_PARTS;
    if !counted || parts.iter().any(|part| part.is_empty()) {
        return Err(IdentifierError::InvalidRecordUri);
    }
    Ok(parts)
}

fn is_valid_did_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
            continue;
        }
        if !bytes[index].is_ascii_alphanumeric()
            && !matches!(bytes[index], b'.' | b'_' | b':' | b'-')
        {
            return false;
        }
        index += 1;
    }
    true
}

fn validated_nsid(value: &str) -> Result<String, IdentifierError> {
    if !is_valid_nsid(value) {
        return Err(IdentifierError::InvalidRecordUri);
    }
    Ok(value.to_owned())
}

const MAX_NSID_BYTES: usize = 253 + 1 + 63;
const MAX_NSID_SEGMENT_BYTES: usize = 63;

/// The `@atproto/syntax` NSID grammar. Like a domain name, only the first
/// segment and the name must start with a letter.
pub(crate) fn is_valid_nsid(value: &str) -> bool {
    if value.len() > MAX_NSID_BYTES {
        return false;
    }
    let segments: Vec<&str> = value.split('.').collect();
    let [first, middle @ .., name] = segments.as_slice() else {
        return false;
    };
    !middle.is_empty()
        && starts_with_letter(first)
        && is_valid_domain_segment(first)
        && middle
            .iter()
            .all(|segment| is_valid_domain_segment(segment))
        && is_valid_name_segment(name)
}

fn starts_with_letter(segment: &str) -> bool {
    segment
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
}

fn is_valid_domain_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_NSID_SEGMENT_BYTES
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn is_valid_name_segment(segment: &str) -> bool {
    segment.len() <= MAX_NSID_SEGMENT_BYTES
        && starts_with_letter(segment)
        && segment.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn validated_space_key(value: &str) -> Result<String, IdentifierError> {
    if !is_valid_record_key(value) {
        return Err(IdentifierError::InvalidRecordUri);
    }
    Ok(value.to_owned())
}

fn validated_record_key(value: &str) -> Result<String, IdentifierError> {
    if !is_valid_record_key(value) {
        return Err(IdentifierError::InvalidRecordUri);
    }
    Ok(value.to_owned())
}

pub(crate) fn is_valid_record_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value != "."
        && value != ".."
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'~' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::{Did, IdentifierError, RecordUri, SpaceUri, is_valid_nsid};

    #[test]
    fn did_length_bound_applies_to_all_record_positions() {
        for length in 2046..=2050 {
            let did = format!("did:plc:{}", "a".repeat(length - 8));
            let valid = length <= 2048;
            assert_eq!(Did::parse(&did).is_ok(), valid, "length {length}");
            assert_eq!(
                RecordUri::parse(&format!("at://{did}/com.example.post/r")).is_ok(),
                valid
            );
            assert_eq!(
                SpaceUri::parse(&format!("at:space/{did}/com.example.space/key")).is_ok(),
                valid
            );
            assert_eq!(
                RecordUri::parse(&format!(
                    "at:space/{did}/com.example.space/key/did:plc:spike/com.example.post/r"
                ))
                .is_ok(),
                valid
            );
            assert_eq!(
                RecordUri::parse(&format!(
                    "at:space/did:plc:spike/com.example.space/key/{did}/com.example.post/r"
                ))
                .is_ok(),
                valid
            );
        }
    }

    #[test]
    fn did_limit_holds_for_multiple_methods_and_encoded_identifiers() {
        for method in ["plc", "web", "example"] {
            let prefix = format!("did:{method}:");
            for length in 2000..=2100 {
                let count = length - prefix.len();
                let identifier = format!("{}{}", "%41".repeat(count / 3), "a".repeat(count % 3));
                let did = format!("{prefix}{identifier}");
                assert_eq!(
                    Did::parse(did).is_ok(),
                    length <= 2048,
                    "method {method}, length {length}"
                );
            }
        }
    }

    #[test]
    fn parses_repository_records_with_the_author_as_authority() {
        let uri =
            RecordUri::parse("at://did:plc:spikespiegel/zone.stratos.feed.post/see-you").unwrap();
        assert_eq!(uri.author().as_str(), "did:plc:spikespiegel");
        assert_eq!(uri.authority().as_str(), "did:plc:spikespiegel");
    }

    #[test]
    fn parses_space_records_without_confusing_authority_and_author() {
        let uri = RecordUri::parse(
            "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/1",
        )
        .unwrap();
        assert_eq!(uri.authority().as_str(), "did:web:stratos.example");
        assert_eq!(uri.author().as_str(), "did:plc:fayevalentine");
    }

    #[test]
    fn space_record_parser_rejects_public_repository_records() {
        assert_eq!(
            RecordUri::parse_space_record(
                "at://did:plc:spikespiegel/zone.stratos.feed.post/see-you"
            ),
            Err(IdentifierError::InvalidRecordUri)
        );
    }

    #[test]
    fn rejects_malformed_or_ambiguous_record_uris() {
        for value in [
            "at:space/did:plc:spike/zone.stratos.space.feed/bebop/did:plc:faye/post",
            "at://did:plc:spike/zone.stratos.feed.post/",
            "https://did:plc:spike/zone.stratos.feed.post/1",
        ] {
            assert_eq!(
                RecordUri::parse(value),
                Err(IdentifierError::InvalidRecordUri)
            );
        }
        assert_eq!(
            Did::parse("did: plc:spike"),
            Err(IdentifierError::InvalidDid)
        );
        assert_eq!(Did::parse("did::spike"), Err(IdentifierError::InvalidDid));
        assert_eq!(
            Did::parse("did:UPPER:spike"),
            Err(IdentifierError::InvalidDid)
        );
        for value in [
            "did:plc:%",
            "did:plc:%zz",
            "did:plc1:spike",
            "did:plc:spike:",
        ] {
            assert_eq!(Did::parse(value), Err(IdentifierError::InvalidDid));
        }
    }

    #[test]
    fn rejects_invalid_space_and_record_components() {
        for value in [
            "at:space/did:web:stratos.example/not_an_nsid/bebop/did:plc:faye/zone.stratos.feed.post/1",
            "at:space/did:web:stratos.example/zone.stratos.space.feed/../did:plc:faye/zone.stratos.feed.post/1",
            "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:faye/zone..feed.post/1",
            "at://did:plc:spike/zone.stratos.feed.post/not/a/rkey",
        ] {
            assert_eq!(
                RecordUri::parse(value),
                Err(IdentifierError::InvalidRecordUri)
            );
        }
    }

    const SPACE: &str = "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop";
    const SPACE_POST: &str = "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/1";
    #[rustfmt::skip]
    const LEGACY_SPACE_URI: &str = "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop";

    #[test]
    fn a_space_uri_formats_back_to_the_string_it_parsed_from() {
        let space = SpaceUri::parse(SPACE).unwrap();
        assert_eq!(space.authority().as_str(), "did:web:stratos.example");
        assert_eq!(space.space_type(), "zone.stratos.space.feed");
        assert_eq!(space.space_key(), "bebop");
        assert_eq!(space.to_string(), SPACE);
        let author = Did::parse("did:plc:fayevalentine").unwrap();
        assert_eq!(
            space.record_uri(&author, "zone.stratos.feed.post", "1"),
            SPACE_POST
        );
        assert_eq!(RecordUri::parse(SPACE_POST).unwrap().space(), Some(space));
    }

    #[test]
    fn a_custody_record_belongs_to_no_space() {
        let uri = RecordUri::parse("at://did:plc:spikespiegel/zone.stratos.feed.post/1").unwrap();
        assert_eq!(uri.space(), None);
    }

    #[test]
    fn the_space_and_record_parsers_refuse_each_others_strings() {
        assert!(SpaceUri::parse(SPACE_POST).is_err());
        assert_eq!(
            RecordUri::parse(SPACE),
            Err(IdentifierError::InvalidRecordUri)
        );
        assert!(SpaceUri::parse("at://did:plc:spikespiegel/zone.stratos.feed.post/1").is_err());
    }

    #[test]
    fn a_legacy_spelling_is_not_a_space_uri() {
        let legacy_record =
            format!("{LEGACY_SPACE_URI}/did:plc:fayevalentine/zone.stratos.feed.post/1");
        assert!(SpaceUri::parse(LEGACY_SPACE_URI).is_err());
        assert!(RecordUri::parse(LEGACY_SPACE_URI).is_err());
        assert!(RecordUri::parse(&legacy_record).is_err());
    }

    #[test]
    fn counts_the_parts_after_the_space_marker_exactly() {
        for value in [
            format!("{SPACE}/"),
            format!("{SPACE}/did:plc:fayevalentine"),
            format!("{SPACE}/did:plc:fayevalentine/zone.stratos.feed.post"),
            format!("{SPACE_POST}/extra"),
            "at:space/did:web:stratos.example/zone.stratos.space.feed".to_owned(),
        ] {
            assert!(RecordUri::parse(&value).is_err(), "{value}");
            assert!(SpaceUri::parse(&value).is_err(), "{value}");
        }
    }

    // Copied from the upstream interop files nsid_syntax_valid.txt and
    // nsid_syntax_invalid.txt, which @atproto/syntax is tested against.
    const UPSTREAM_VALID_NSIDS: &[&str] = &[
        "com.ooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo.foo",
        "com.example.ooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
        "com.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.foo",
        "com.example.fooBar",
        "com.example.fooBarV2",
        "net.users.bob.ping",
        "a.b.c",
        "m.xn--masekowski-d0b.pl",
        "one.two.three",
        "one.two.three.four-and.FiVe",
        "one.2.three",
        "a-0.b-1.c",
        "a0.b1.cc",
        "cn.8.lex.stuff",
        "test.12345.record",
        "a01.thing.record",
        "a.0.c",
        "xn--fiqs8s.xn--fiqa61au8b7zsevnm8ak20mc4a87e.record.two",
        "a0.b1.c3",
        "com.example.f00",
        "onion.expyuzz4wqqyqhjn.spec.getThing",
        "onion.g2zyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.lex.deleteThing",
        "org.4chan.lex.getThing",
        "cn.8.lex.stuff",
        "onion.2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.lex.deleteThing",
    ];
    const UPSTREAM_INVALID_NSIDS: &[&str] = &[
        "com.oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo.foo",
        "com.example.oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
        "com.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.middle.foo",
        "com.example.foo.*",
        "com.example.foo.blah*",
        "com.example.foo.*blah",
        "com.exa💩ple.thing",
        "a-0.b-1.c-3",
        "a-0.b-1.c-o",
        "1.0.0.127.record",
        "0two.example.foo",
        "example.com",
        "com.example",
        "a.",
        ".one.two.three",
        "one.two.three ",
        "one.two..three",
        "one .two.three",
        " one.two.three",
        "com.exa💩ple.thing",
        "com.atproto.feed.p@st",
        "com.atproto.feed.p_st",
        "com.atproto.feed.p*st",
        "com.atproto.feed.po#t",
        "com.atproto.feed.p!ot",
        "com.example-.foo",
        "com.example.fooBar.2",
    ];

    #[test]
    fn accepts_and_refuses_the_upstream_nsid_vectors() {
        for value in UPSTREAM_VALID_NSIDS {
            assert!(is_valid_nsid(value), "{value:?} is valid upstream");
        }
        for value in UPSTREAM_INVALID_NSIDS {
            assert!(!is_valid_nsid(value), "{value:?} is invalid upstream");
        }
    }

    #[test]
    fn holds_the_nsid_length_and_name_limits() {
        let segment = |byte: &str| byte.repeat(63);
        let domain = [segment("a"), segment("b"), segment("c"), segment("d")].join(".");
        assert!(is_valid_nsid(&format!("{domain}.{}", "e".repeat(61))));
        assert!(!is_valid_nsid(&format!("{domain}.{}", "e".repeat(62))));
        assert!(is_valid_nsid(&format!("com.example.{}", "e".repeat(63))));
        assert!(!is_valid_nsid(&format!("com.example.{}", "e".repeat(64))));
        for value in [
            "com.example.2post",
            "com.example.po-st",
            "com.-example.post",
            "1com.example.post",
            "-com.example.post",
        ] {
            assert!(!is_valid_nsid(value), "{value}");
        }
        for value in ["com.123.post", "com.1-2.post", "COM.Example.Post"] {
            assert!(is_valid_nsid(value), "{value}");
        }
    }

    /// The procedural form of the upstream rules (`validateNsid`), so the
    /// grammar is checked against a second, differently shaped reading of them.
    fn upstream_validate_nsid(input: &str) -> bool {
        if input.len() > 253 + 1 + 63 {
            return false;
        }
        if !input
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        {
            return false;
        }
        let segments: Vec<&str> = input.split('.').collect();
        if segments.len() < 3 {
            return false;
        }
        for segment in &segments {
            if segment.is_empty() || segment.len() > 63 {
                return false;
            }
            if segment.starts_with('-') || segment.ends_with('-') {
                return false;
            }
        }
        let starts_with_digit = |segment: &str| segment.as_bytes()[0].is_ascii_digit();
        let name = segments[segments.len() - 1];
        !starts_with_digit(segments[0]) && !starts_with_digit(name) && !name.contains('-')
    }

    fn every_string(alphabet: &[u8], max_len: usize) -> Vec<String> {
        let mut all = vec![String::new()];
        let mut frontier = vec![String::new()];
        for _ in 0..max_len {
            frontier = frontier
                .iter()
                .flat_map(|prefix| {
                    alphabet.iter().map(move |byte| {
                        let mut next = prefix.clone();
                        next.push(char::from(*byte));
                        next
                    })
                })
                .collect();
            all.extend(frontier.iter().cloned());
        }
        all
    }

    #[test]
    fn agrees_with_the_upstream_rules_on_every_short_string() {
        let short = every_string(b"a0-.", 9)
            .into_iter()
            .chain(every_string(b"aZ0-._", 6));
        for value in short {
            assert_eq!(
                is_valid_nsid(&value),
                upstream_validate_nsid(&value),
                "{value:?}"
            );
        }
    }

    #[test]
    fn parses_records_in_a_collection_whose_middle_segment_starts_with_a_digit() {
        let repo = RecordUri::parse("at://did:plc:x/com.123.post/r").unwrap();
        assert_eq!(
            repo,
            RecordUri::Repo {
                author: Did::parse("did:plc:x").unwrap(),
                collection: "com.123.post".to_owned(),
                rkey: "r".to_owned(),
            }
        );
        assert!(
            RecordUri::parse(
                "at:space/did:web:stratos.example/zone.stratos.space.feed/bebop/did:plc:fayevalentine/com.123.post/r"
            )
            .is_ok()
        );
        assert!(RecordUri::parse("at://did:plc:x/1com.example.post/r").is_err());
    }
}
