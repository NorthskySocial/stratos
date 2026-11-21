//! The set hash a space host commits to: a homomorphic digest of every record
//! in one member's repo, following the pinned upstream `packages/space/src/lthash.ts`.
//! Each element expands to 1024 little-endian 16-bit lanes (BLAKE3 extended
//! output) that are added into, or subtracted from, a 2048-byte state; the
//! commit carries the SHA-256 of that state.

use std::fmt;

use cid::Cid;
use sha2::{Digest, Sha256};

use crate::identifier::{is_valid_nsid, is_valid_record_key};

pub const STATE_BYTES: usize = 2048;
pub const DIGEST_BYTES: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SetHashStateError {
    WrongLength { found: usize },
}

impl fmt::Display for SetHashStateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongLength { found } => {
                write!(
                    formatter,
                    "set hash state is {found} bytes, not {STATE_BYTES}"
                )
            }
        }
    }
}

impl std::error::Error for SetHashStateError {}

const LANE_COUNT: usize = STATE_BYTES / 2;
const SEPARATOR: char = '/';
#[derive(Clone, Eq, PartialEq)]
pub struct SetHashState {
    lanes: [u16; LANE_COUNT],
}

impl SetHashState {
    pub fn empty() -> Self {
        Self {
            lanes: [0; LANE_COUNT],
        }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, SetHashStateError> {
        if bytes.len() != STATE_BYTES {
            return Err(SetHashStateError::WrongLength { found: bytes.len() });
        }
        Ok(Self {
            lanes: lanes_from_le_bytes(bytes),
        })
    }

    pub fn to_bytes(&self) -> [u8; STATE_BYTES] {
        let mut bytes = [0_u8; STATE_BYTES];
        for (pair, lane) in bytes.as_chunks_mut::<2>().0.iter_mut().zip(&self.lanes) {
            *pair = lane.to_le_bytes();
        }
        bytes
    }

    pub fn add(&mut self, element: &str) {
        for (lane, addend) in self.lanes.iter_mut().zip(expand(element)) {
            *lane = lane.wrapping_add(addend);
        }
    }

    pub fn remove(&mut self, element: &str) {
        for (lane, subtrahend) in self.lanes.iter_mut().zip(expand(element)) {
            *lane = lane.wrapping_sub(subtrahend);
        }
    }

    pub fn digest(&self) -> [u8; DIGEST_BYTES] {
        Sha256::digest(self.to_bytes()).into()
    }
}

impl fmt::Debug for SetHashState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SetHashState { digest: ")?;
        for byte in self.digest() {
            write!(formatter, "{byte:02x}")?;
        }
        formatter.write_str(" }")
    }
}

fn expand(element: &str) -> [u16; LANE_COUNT] {
    let mut expanded = [0_u8; STATE_BYTES];
    blake3::Hasher::new()
        .update(element.as_bytes())
        .finalize_xof()
        .fill(&mut expanded);
    lanes_from_le_bytes(&expanded)
}

fn lanes_from_le_bytes(bytes: &[u8]) -> [u16; LANE_COUNT] {
    let mut lanes = [0_u16; LANE_COUNT];
    for (lane, pair) in lanes.iter_mut().zip(bytes.as_chunks::<2>().0) {
        *lane = u16::from_le_bytes(*pair);
    }
    lanes
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordPathError {
    InvalidCollection,
    InvalidRecordKey,
}

impl fmt::Display for RecordPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidCollection => formatter.write_str("invalid collection"),
            Self::InvalidRecordKey => formatter.write_str("invalid record key"),
        }
    }
}

impl std::error::Error for RecordPathError {}

/// A record's collection (an NSID) and record key, each checked against the
/// atproto syntax rules.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordPath {
    collection: String,
    rkey: String,
}

impl RecordPath {
    pub fn parse(collection: &str, rkey: &str) -> Result<Self, RecordPathError> {
        if !is_valid_nsid(collection) {
            return Err(RecordPathError::InvalidCollection);
        }
        if !is_valid_record_key(rkey) {
            return Err(RecordPathError::InvalidRecordKey);
        }
        Ok(Self {
            collection: collection.to_owned(),
            rkey: rkey.to_owned(),
        })
    }

    pub fn collection(&self) -> &str {
        &self.collection
    }

    pub fn rkey(&self) -> &str {
        &self.rkey
    }
}

/// The text a record contributes to the set hash: `{collection}/{rkey}/{cid}`.
pub fn set_hash_element(path: &RecordPath, cid: &Cid) -> String {
    format!(
        "{}{SEPARATOR}{}{SEPARATOR}{cid}",
        path.collection(),
        path.rkey()
    )
}

#[cfg(test)]
mod tests {
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    };
    use serde_json::Value;

    use super::*;

    const LTHASH: &str = include_str!("../../test/spaces-alignment/november/fixtures/lthash.json");
    const OP_PAGES: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/op-pages.json");

    fn fixture(text: &str) -> Value {
        serde_json::from_str(text).expect("fixture is json")
    }

    fn bytes_of(field: &Value) -> Vec<u8> {
        STANDARD
            .decode(field["value"].as_str().expect("base64 field"))
            .expect("base64")
    }

    fn state_of(field: &Value) -> SetHashState {
        SetHashState::from_bytes(&bytes_of(field)).expect("2048 bytes")
    }

    fn elements() -> Vec<String> {
        fixture(LTHASH)["elements"]
            .as_array()
            .expect("elements")
            .iter()
            .map(|element| element.as_str().expect("element").to_owned())
            .collect()
    }

    fn built_from(elements: &[String]) -> SetHashState {
        let mut state = SetHashState::empty();
        for element in elements {
            state.add(element);
        }
        state
    }

    fn element_of_op(collection: &str, rkey: &str, cid: &str) -> String {
        let path = RecordPath::parse(collection, rkey).expect("valid path");
        set_hash_element(&path, &Cid::try_from(cid).expect("valid cid"))
    }

    // Oracle vectors (lthash.json).

    #[test]
    fn the_empty_state_has_the_oracle_empty_digest() {
        let expected = bytes_of(&fixture(LTHASH)["emptyDigest"]);
        assert_eq!(SetHashState::empty().digest().as_slice(), expected);
        assert_eq!(SetHashState::empty().to_bytes(), [0_u8; STATE_BYTES]);
    }

    #[test]
    fn all_elements_give_the_oracle_state_and_digest() {
        let vectors = fixture(LTHASH);
        let state = built_from(&elements());
        assert_eq!(state.to_bytes().as_slice(), bytes_of(&vectors["stateAll"]));
        assert_eq!(state.digest().as_slice(), bytes_of(&vectors["digestAll"]));
    }

    #[test]
    fn the_same_elements_in_another_order_give_the_oracle_state() {
        let vectors = fixture(LTHASH);
        let mut reversed = elements();
        reversed.reverse();
        let state = built_from(&reversed);
        assert_eq!(
            state.to_bytes().as_slice(),
            bytes_of(&vectors["stateReordered"])
        );
        assert_eq!(
            state.digest().as_slice(),
            bytes_of(&vectors["digestReordered"])
        );
    }

    #[test]
    fn removing_an_element_gives_the_oracle_state() {
        let vectors = fixture(LTHASH);
        let mut state = built_from(&elements());
        state.remove(vectors["removedElement"].as_str().expect("element"));
        assert_eq!(
            state.to_bytes().as_slice(),
            bytes_of(&vectors["stateAfterRemove"])
        );
        assert_eq!(
            state.digest().as_slice(),
            bytes_of(&vectors["digestAfterRemove"])
        );
    }

    #[test]
    fn a_state_read_from_oracle_bytes_exports_the_same_bytes() {
        let vectors = fixture(LTHASH);
        let state = state_of(&vectors["stateAll"]);
        assert_eq!(state.to_bytes().as_slice(), bytes_of(&vectors["stateAll"]));
        assert_eq!(state.digest().as_slice(), bytes_of(&vectors["digestAll"]));
    }

    #[test]
    fn element_text_is_collection_rkey_and_cid() {
        for element in elements() {
            let [collection, rkey, cid] = element.split('/').collect::<Vec<_>>()[..] else {
                panic!("three parts");
            };
            assert_eq!(element_of_op(collection, rkey, cid), element);
        }
    }

    // Oracle vectors (op-pages.json): the pages apply as the oracle RepoCommit
    // applied them, a removal of prev before an addition of cid.

    #[test]
    fn applying_each_page_gives_the_oracle_commit_digest_and_final_state() {
        let vectors = fixture(OP_PAGES);
        let mut state = SetHashState::empty();
        for page in vectors["pages"].as_array().expect("pages") {
            for op in page["ops"].as_array().expect("ops") {
                let collection = op["collection"].as_str().expect("collection");
                let rkey = op["rkey"].as_str().expect("rkey");
                if let Some(prev) = op["prev"].as_str() {
                    state.remove(&element_of_op(collection, rkey, prev));
                }
                if let Some(cid) = op["cid"].as_str() {
                    state.add(&element_of_op(collection, rkey, cid));
                }
            }
            let expected = STANDARD_NO_PAD
                .decode(page["commit"]["data"]["$bytes"].as_str().expect("data"))
                .expect("unpadded base64 digest");
            assert_eq!(state.digest().as_slice(), expected);
        }
        assert_eq!(
            state.to_bytes().as_slice(),
            bytes_of(&vectors["stateAfterLastPage"])
        );
    }

    // Cross-check against a model.

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from((self.0 >> 33) % bound as u64).expect("fits")
        }
    }

    #[test]
    fn random_add_and_remove_sequences_match_a_state_rebuilt_from_the_survivors() {
        let pool: Vec<String> = (0..6)
            .map(|index| format!("zone.stratos.feed.post/ein{index}/bafyreispike{index}"))
            .collect();
        let mut generator = Lcg(0x5eed_0001);
        for _ in 0..200 {
            let mut state = SetHashState::empty();
            let mut counts = vec![0_u32; pool.len()];
            for _ in 0..(1 + generator.next(40)) {
                let at = generator.next(pool.len());
                if counts[at] > 0 && generator.next(2) == 0 {
                    state.remove(&pool[at]);
                    counts[at] -= 1;
                } else {
                    state.add(&pool[at]);
                    counts[at] += 1;
                }
            }
            let mut rebuilt = SetHashState::empty();
            for (element, count) in pool.iter().zip(&counts) {
                for _ in 0..*count {
                    rebuilt.add(element);
                }
            }
            assert_eq!(state, rebuilt);
        }
    }

    #[test]
    fn adding_then_removing_an_element_returns_the_earlier_state() {
        let pool = elements();
        let mut generator = Lcg(0x5eed_0002);
        for _ in 0..200 {
            let mut state = SetHashState::empty();
            for _ in 0..generator.next(5) {
                state.add(&pool[generator.next(pool.len())]);
            }
            let earlier = state.clone();
            let element = &pool[generator.next(pool.len())];
            state.add(element);
            assert_ne!(state, earlier);
            state.remove(element);
            assert_eq!(state, earlier);
        }
    }

    // Real values.

    #[test]
    fn a_state_of_any_other_length_is_refused() {
        for length in [0, 1, 2047, 2049, 4096] {
            assert_eq!(
                SetHashState::from_bytes(&vec![0_u8; length]),
                Err(SetHashStateError::WrongLength { found: length })
            );
        }
        assert!(SetHashState::from_bytes(&[0_u8; STATE_BYTES]).is_ok());
    }

    #[test]
    fn debug_output_is_the_digest_and_not_the_state() {
        let state = built_from(&elements());
        let printed = format!("{state:?}");
        assert!(printed.len() < 200, "{printed}");
        assert!(printed.contains(&hex_of(&state.digest())));
    }

    fn hex_of(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn a_path_with_an_invalid_collection_or_record_key_is_refused() {
        let path = RecordPath::parse("zone.stratos.feed.post", "swordfish").expect("valid");
        assert_eq!(path.collection(), "zone.stratos.feed.post");
        assert_eq!(path.rkey(), "swordfish");
        let long_label = "a".repeat(64);
        for (collection, rkey, error) in [
            (
                "not a collection",
                "swordfish",
                RecordPathError::InvalidCollection,
            ),
            ("a/b.c.d", "swordfish", RecordPathError::InvalidCollection),
            ("", "swordfish", RecordPathError::InvalidCollection),
            ("feed.post", "swordfish", RecordPathError::InvalidCollection),
            (
                &format!("{long_label}.stratos.post"),
                "ein",
                RecordPathError::InvalidCollection,
            ),
            (
                "zone.stratos.feed.post",
                "",
                RecordPathError::InvalidRecordKey,
            ),
            (
                "zone.stratos.feed.post",
                "a/b",
                RecordPathError::InvalidRecordKey,
            ),
            (
                "zone.stratos.feed.post",
                "..",
                RecordPathError::InvalidRecordKey,
            ),
            (
                "zone.stratos.feed.post",
                ".",
                RecordPathError::InvalidRecordKey,
            ),
            (
                "zone.stratos.feed.post",
                &"k".repeat(513),
                RecordPathError::InvalidRecordKey,
            ),
        ] {
            assert_eq!(
                RecordPath::parse(collection, rkey),
                Err(error),
                "{collection} {rkey}"
            );
        }
        assert!(RecordPath::parse("zone.stratos.feed.post", &"k".repeat(512)).is_ok());
    }
}
