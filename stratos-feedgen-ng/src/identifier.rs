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

impl Did {
    pub fn parse(value: impl Into<String>) -> Result<Self, IdentifierError> {
        let value = value.into();
        let Some((method, identifier)) = value
            .strip_prefix("did:")
            .and_then(|rest| rest.split_once(':'))
        else {
            return Err(IdentifierError::InvalidDid);
        };
        if method.is_empty()
            || identifier.is_empty()
            || !method
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
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
        let value = value
            .strip_prefix("at://")
            .ok_or(IdentifierError::InvalidRecordUri)?;
        let segments: Vec<&str> = value.split('/').collect();
        if segments.iter().any(|segment| segment.is_empty()) {
            return Err(IdentifierError::InvalidRecordUri);
        }
        match segments.as_slice() {
            [author, collection, rkey] => Ok(Self::Repo {
                author: Did::parse(*author)?,
                collection: validated_nsid(collection)?,
                rkey: validated_record_key(rkey)?,
            }),
            [
                authority,
                "space",
                space_type,
                space_key,
                author,
                collection,
                rkey,
            ] => Ok(Self::Space {
                authority: Did::parse(*authority)?,
                space_type: validated_nsid(space_type)?,
                space_key: validated_space_key(space_key)?,
                author: Did::parse(*author)?,
                collection: validated_nsid(collection)?,
                rkey: validated_record_key(rkey)?,
            }),
            _ => Err(IdentifierError::InvalidRecordUri),
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

fn is_valid_nsid(value: &str) -> bool {
    if value.len() > 317 {
        return false;
    }
    let labels: Vec<&str> = value.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            let bytes = label.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 63
                && bytes[0].is_ascii_lowercase()
                && bytes[bytes.len() - 1].is_ascii_alphanumeric()
                && bytes
                    .iter()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        })
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

fn is_valid_record_key(value: &str) -> bool {
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
    use super::{Did, IdentifierError, RecordUri};

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
            "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:fayevalentine/zone.stratos.feed.post/1",
        )
        .unwrap();
        assert_eq!(uri.authority().as_str(), "did:web:stratos.example");
        assert_eq!(uri.author().as_str(), "did:plc:fayevalentine");
    }

    #[test]
    fn rejects_malformed_or_ambiguous_record_uris() {
        for value in [
            "at://did:plc:spike/space/zone.stratos.space.feed/bebop/did:plc:faye/post",
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
        for value in ["did:plc:%", "did:plc:%zz"] {
            assert_eq!(Did::parse(value), Err(IdentifierError::InvalidDid));
        }
    }

    #[test]
    fn rejects_invalid_space_and_record_components() {
        for value in [
            "at://did:web:stratos.example/space/not_an_nsid/bebop/did:plc:faye/zone.stratos.feed.post/1",
            "at://did:web:stratos.example/space/zone.stratos.space.feed/../did:plc:faye/zone.stratos.feed.post/1",
            "at://did:web:stratos.example/space/zone.stratos.space.feed/bebop/did:plc:faye/Zone.stratos.feed.post/1",
            "at://did:plc:spike/zone.stratos.feed.post/not/a/rkey",
        ] {
            assert_eq!(
                RecordUri::parse(value),
                Err(IdentifierError::InvalidRecordUri)
            );
        }
    }
}
