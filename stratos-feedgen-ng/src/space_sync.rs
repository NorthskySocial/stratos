//! What a poll or a replacement admits into the projection: the collections it
//! reads and the bounds on what one record may carry.

use serde_json::Value;

use crate::{
    identifier::RecordUri,
    store::{InteractionKind, MAX_SUBJECT_URI_BYTES},
};

pub const POST_COLLECTION: &str = "zone.stratos.feed.post";
pub const MAX_SPACE_PAGE_OPS: usize = 1_000;
pub const MAX_SPACE_RECORD_BYTES: usize = 64 * 1024;
pub(crate) const MAX_CURSOR_BYTES: usize = 4 * 1024;
pub(crate) const MAX_CID_BYTES: usize = 256;

fn has_record_type(value: &Value, collection: &str) -> bool {
    value
        .as_object()
        .and_then(|record| record.get("$type"))
        .and_then(Value::as_str)
        == Some(collection)
}

/// The collections the projection serves from: posts and the interactions it
/// counts. A record of any other collection is hashed into the repo's state
/// and never read again, so its value is not worth holding.
pub(crate) fn is_projected_collection(collection: &str) -> bool {
    collection == POST_COLLECTION || InteractionKind::from_collection(collection).is_some()
}

pub(crate) fn is_admitted_record(collection: &str, value: &Value) -> bool {
    if collection == POST_COLLECTION {
        return has_record_type(value, POST_COLLECTION);
    }
    has_record_type(value, collection)
        && value
            .get("subject")
            .and_then(|subject| subject.get("uri"))
            .and_then(Value::as_str)
            .is_some_and(|subject_uri| {
                subject_uri.len() <= MAX_SUBJECT_URI_BYTES && RecordUri::parse(subject_uri).is_ok()
            })
}

pub(crate) fn serialize_bounded(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    struct LimitedBuffer {
        bytes: Vec<u8>,
    }

    impl std::io::Write for LimitedBuffer {
        fn write(&mut self, value: &[u8]) -> std::io::Result<usize> {
            if self.bytes.len().saturating_add(value.len()) > MAX_SPACE_RECORD_BYTES {
                return Err(std::io::Error::other("record exceeds configured limit"));
            }
            self.bytes.extend_from_slice(value);
            Ok(value.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut buffer = LimitedBuffer { bytes: Vec::new() };
    serde_json::to_writer(&mut buffer, value)?;
    Ok(buffer.bytes)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        MAX_SPACE_RECORD_BYTES, POST_COLLECTION, is_admitted_record, is_projected_collection,
        serialize_bounded,
    };
    use crate::store::{InteractionKind, MAX_SUBJECT_URI_BYTES};

    const SUBJECT: &str = "at:space/did:web:stratos.example.test/zone.stratos.space.feed/bebop/did:plc:spikespiegel/zone.stratos.feed.post/bang";

    #[test]
    fn an_interaction_is_admitted_only_with_its_own_type_and_a_usable_subject() {
        let like = InteractionKind::Like.collection();
        let long_but_valid_subject = format!(
            "at://did:plc:{}/{POST_COLLECTION}/bang",
            "a".repeat(2048 - "did:plc:".len())
        );
        assert!(crate::identifier::RecordUri::parse(&long_but_valid_subject).is_ok());
        assert!(long_but_valid_subject.len() > MAX_SUBJECT_URI_BYTES);

        assert!(is_admitted_record(
            like,
            &json!({ "$type": like, "subject": { "uri": SUBJECT } })
        ));
        for (reason, value) in [
            (
                "another type",
                json!({ "$type": "app.bsky.feed.repost", "subject": { "uri": SUBJECT } }),
            ),
            ("no subject", json!({ "$type": like })),
            (
                "a numeric subject",
                json!({ "$type": like, "subject": { "uri": 7 } }),
            ),
            (
                "a subject that is not a record uri",
                json!({ "$type": like, "subject": { "uri": "https://example.test" } }),
            ),
            (
                "a subject over the length the projection keeps",
                json!({ "$type": like, "subject": { "uri": long_but_valid_subject } }),
            ),
        ] {
            assert!(!is_admitted_record(like, &value), "{reason}");
        }
    }

    #[test]
    fn a_post_is_admitted_only_with_the_post_type() {
        assert!(is_admitted_record(
            POST_COLLECTION,
            &json!({ "$type": POST_COLLECTION })
        ));
        for value in [
            json!({ "$type": "app.bsky.feed.post" }),
            json!({ "text": "Bang" }),
            json!("zone.stratos.feed.post"),
        ] {
            assert!(!is_admitted_record(POST_COLLECTION, &value), "{value}");
        }
    }

    #[test]
    fn only_posts_and_the_interactions_it_counts_are_projected() {
        for collection in [
            POST_COLLECTION,
            InteractionKind::Like.collection(),
            InteractionKind::Repost.collection(),
        ] {
            assert!(is_projected_collection(collection), "{collection}");
        }
        for collection in ["app.bsky.feed.post", "app.bsky.graph.follow", ""] {
            assert!(!is_projected_collection(collection), "{collection}");
        }
    }

    #[test]
    fn a_value_is_serialized_up_to_the_record_limit_and_no_further() {
        let record =
            |text_bytes: usize| json!({ "$type": POST_COLLECTION, "text": "x".repeat(text_bytes) });
        let envelope = serialize_bounded(&record(0)).unwrap().len();

        let at_the_limit = serialize_bounded(&record(MAX_SPACE_RECORD_BYTES - envelope)).unwrap();
        assert_eq!(at_the_limit.len(), MAX_SPACE_RECORD_BYTES);
        assert!(serialize_bounded(&record(MAX_SPACE_RECORD_BYTES - envelope + 1)).is_err());
    }
}
