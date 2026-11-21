//! Reader for the archive a space host answers `getRepo` with: a metadata
//! header carrying the repo's commit, then one path and one record per pair in
//! strict path order, then an end marker. It is fed bytes as they arrive and
//! keeps only the unread tail of the item in progress. Nothing it yields is
//! authenticated: the metadata is trusted only after the response's MAC is
//! verified against it, and the records only after the store's digest check.
//!
//! Layout, as the pinned upstream STAR package reads it: the magic
//! `2a 6c 01 00`, the metadata as a length and a canonical DAG-CBOR map, then
//! per record `01`, a length and the path, a length and the record bytes, and
//! last `00` with nothing after it. Every length is an unsigned varint in its
//! shortest form of at most nine bytes.

use std::fmt;

use serde_json::Value;

use crate::{
    config::{
        MAX_SPACE_ARCHIVE_BYTES, MAX_SPACE_ARCHIVE_KEY_BYTES, MAX_SPACE_ARCHIVE_META_BYTES,
        MAX_SPACE_ARCHIVE_VALUE_BYTES, MAX_SPACE_REPO_RECORDS,
    },
    space_record::{RecordDecodeRefusal, decode_record},
    space_set_hash::RecordPath,
};

/// The `$type` of the metadata of a repo archive.
pub const REPO_ARCHIVE_TYPE: &str = "atproto-space-repo";

const MAGIC: [u8; 4] = [0x2a, 0x6c, 0x01, 0x00];
const CONTROL_PAIR: u8 = 0x01;
const CONTROL_END: u8 = 0x00;
const MAX_VARINT_BYTES: usize = 9;
const VARINT_PAYLOAD_BITS: u32 = 7;
const VARINT_CONTINUATION: u8 = 0x80;

/// What an archive may not exceed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveLimit {
    Metadata,
    Key,
    Value,
    Archive,
    Records,
}

/// Why an archive is refused. None of these carries input text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveRefusal {
    BadHeader,
    BadLength,
    LimitExceeded(ArchiveLimit),
    UnexpectedEnd,
    UnknownControl,
    TrailingBytes,
    MetadataNotAMap,
    BadMetadata,
    WrongMetadataType,
}

impl fmt::Display for ArchiveRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::BadHeader => "the archive does not start with the magic and a metadata length",
            Self::BadLength => {
                "a length in the archive is not a shortest-form varint of nine bytes or fewer"
            }
            Self::LimitExceeded(ArchiveLimit::Metadata) => "the archive metadata is over its limit",
            Self::LimitExceeded(ArchiveLimit::Key) => "an archive path is over its limit",
            Self::LimitExceeded(ArchiveLimit::Value) => "an archive record is over its limit",
            Self::LimitExceeded(ArchiveLimit::Archive) => "the archive is over its size limit",
            Self::LimitExceeded(ArchiveLimit::Records) => "the archive holds too many records",
            Self::UnexpectedEnd => "the archive ended before its end marker",
            Self::UnknownControl => "the archive holds a control byte that is neither pair nor end",
            Self::TrailingBytes => "the archive holds bytes after its end marker",
            Self::MetadataNotAMap => "the archive metadata is not a map",
            Self::BadMetadata => "the archive metadata is not canonical DAG-CBOR",
            Self::WrongMetadataType => "the archive metadata is not that of a repo archive",
        })
    }
}

impl std::error::Error for ArchiveRefusal {}

/// One thing read from an archive, in archive order: the metadata once, then
/// each record's path and bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ArchiveItem {
    Metadata(Value),
    Record { path: Vec<u8>, value: Vec<u8> },
}

enum State {
    Magic,
    MetadataLength,
    Metadata { length: usize },
    Control,
    KeyLength,
    Key { length: usize },
    ValueLength { key: Vec<u8> },
    Value { key: Vec<u8>, length: usize },
    Ended,
    Failed(ArchiveRefusal),
}

/// A reader that is fed chunks of any size with `push`, hands out finished
/// items with `next_item`, and is closed with `finish` when the input ends.
/// `finish` is the end of the archive: until it answers `Ok`, nothing read is
/// known to be complete, and the end marker alone does not say that no byte
/// follows it.
pub struct ArchiveReader {
    buffer: Vec<u8>,
    unread_from: usize,
    consumed: usize,
    received: usize,
    records: usize,
    state: State,
}

impl Default for ArchiveReader {
    fn default() -> Self {
        Self::new()
    }
}

impl ArchiveReader {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            unread_from: 0,
            consumed: 0,
            received: 0,
            records: 0,
            state: State::Magic,
        }
    }

    /// Adds received bytes. Refuses at once when they would take the archive past
    /// its size limit, or when the end marker has already been read.
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ArchiveRefusal> {
        match self.state {
            State::Failed(refusal) => return Err(refusal),
            State::Ended if !chunk.is_empty() => return self.fail(ArchiveRefusal::TrailingBytes),
            _ => {}
        }
        if chunk.len() > MAX_SPACE_ARCHIVE_BYTES - self.received {
            return self.fail(ArchiveRefusal::LimitExceeded(ArchiveLimit::Archive));
        }
        self.received += chunk.len();
        self.buffer.drain(..self.unread_from);
        self.unread_from = 0;
        self.buffer.extend_from_slice(chunk);
        Ok(())
    }

    /// The next finished item, or `None` when more bytes are needed or the end
    /// marker has been read.
    pub fn next_item(&mut self) -> Result<Option<ArchiveItem>, ArchiveRefusal> {
        loop {
            if let State::Failed(refusal) = self.state {
                return Err(refusal);
            }
            match self.step() {
                Ok(Step::Item(item)) => return Ok(Some(item)),
                Ok(Step::Moved) => {}
                Ok(Step::NeedBytes) => return Ok(None),
                Err(refusal) => return self.fail(refusal),
            }
        }
    }

    /// Closes the input. Only an archive that ended with its end marker and
    /// nothing after it is complete.
    pub fn finish(self) -> Result<(), ArchiveRefusal> {
        match self.state {
            State::Failed(refusal) => Err(refusal),
            State::Ended => Ok(()),
            _ => Err(ArchiveRefusal::UnexpectedEnd),
        }
    }

    fn fail<T>(&mut self, refusal: ArchiveRefusal) -> Result<T, ArchiveRefusal> {
        self.state = State::Failed(refusal);
        self.buffer = Vec::new();
        self.unread_from = 0;
        Err(refusal)
    }

    fn unread(&self) -> &[u8] {
        &self.buffer[self.unread_from..]
    }

    fn consume(&mut self, length: usize) {
        self.unread_from += length;
        self.consumed += length;
    }

    // A declared length is judged before any byte of the item is waited for or
    // allocated: against the item's own limit, then against what is left of the
    // archive's.
    fn check_declared(
        &self,
        length: u64,
        item_limit: usize,
        limit: ArchiveLimit,
    ) -> Result<usize, ArchiveRefusal> {
        let length = usize::try_from(length)
            .ok()
            .filter(|length| *length <= item_limit)
            .ok_or(ArchiveRefusal::LimitExceeded(limit))?;
        if length > MAX_SPACE_ARCHIVE_BYTES - self.consumed {
            return Err(ArchiveRefusal::LimitExceeded(ArchiveLimit::Archive));
        }
        Ok(length)
    }

    fn step(&mut self) -> Result<Step, ArchiveRefusal> {
        match std::mem::replace(&mut self.state, State::Ended) {
            State::Magic => {
                let available = self.unread();
                let compared = available.len().min(MAGIC.len());
                if available[..compared] != MAGIC[..compared] {
                    self.state = State::Magic;
                    return Err(ArchiveRefusal::BadHeader);
                }
                if available.len() < MAGIC.len() {
                    self.state = State::Magic;
                    return Ok(Step::NeedBytes);
                }
                self.consume(MAGIC.len());
                self.state = State::MetadataLength;
                Ok(Step::Moved)
            }
            State::MetadataLength => {
                let Some((declared, width)) = self.read_varint(ArchiveRefusal::BadHeader)? else {
                    self.state = State::MetadataLength;
                    return Ok(Step::NeedBytes);
                };
                self.consume(width);
                let length = self.check_declared(
                    declared,
                    MAX_SPACE_ARCHIVE_META_BYTES,
                    ArchiveLimit::Metadata,
                )?;
                self.state = State::Metadata { length };
                Ok(Step::Moved)
            }
            State::Metadata { length } => {
                if self.unread().len() < length {
                    self.state = State::Metadata { length };
                    return Ok(Step::NeedBytes);
                }
                let decoded = decode_record(&self.unread()[..length]);
                self.consume(length);
                let (_, metadata) = decoded.map_err(|refusal| match refusal {
                    RecordDecodeRefusal::NotAMap => ArchiveRefusal::MetadataNotAMap,
                    _ => ArchiveRefusal::BadMetadata,
                })?;
                self.state = State::Control;
                Ok(Step::Item(ArchiveItem::Metadata(metadata)))
            }
            State::Control => {
                let Some(&control) = self.unread().first() else {
                    self.state = State::Control;
                    return Ok(Step::NeedBytes);
                };
                match control {
                    CONTROL_END => {
                        self.consume(1);
                        if !self.unread().is_empty() {
                            return Err(ArchiveRefusal::TrailingBytes);
                        }
                        self.state = State::Ended;
                        Ok(Step::NeedBytes)
                    }
                    CONTROL_PAIR => {
                        if self.records >= MAX_SPACE_REPO_RECORDS {
                            return Err(ArchiveRefusal::LimitExceeded(ArchiveLimit::Records));
                        }
                        self.consume(1);
                        self.state = State::KeyLength;
                        Ok(Step::Moved)
                    }
                    _ => Err(ArchiveRefusal::UnknownControl),
                }
            }
            State::KeyLength => {
                let Some((declared, width)) = self.read_varint(ArchiveRefusal::BadLength)? else {
                    self.state = State::KeyLength;
                    return Ok(Step::NeedBytes);
                };
                self.consume(width);
                let length =
                    self.check_declared(declared, MAX_SPACE_ARCHIVE_KEY_BYTES, ArchiveLimit::Key)?;
                self.state = State::Key { length };
                Ok(Step::Moved)
            }
            State::Key { length } => {
                if self.unread().len() < length {
                    self.state = State::Key { length };
                    return Ok(Step::NeedBytes);
                }
                let key = self.unread()[..length].to_vec();
                self.consume(length);
                self.state = State::ValueLength { key };
                Ok(Step::Moved)
            }
            State::ValueLength { key } => {
                let Some((declared, width)) = self.read_varint(ArchiveRefusal::BadLength)? else {
                    self.state = State::ValueLength { key };
                    return Ok(Step::NeedBytes);
                };
                self.consume(width);
                let length = self.check_declared(
                    declared,
                    MAX_SPACE_ARCHIVE_VALUE_BYTES,
                    ArchiveLimit::Value,
                )?;
                self.state = State::Value { key, length };
                Ok(Step::Moved)
            }
            State::Value { key, length } => {
                if self.unread().len() < length {
                    self.state = State::Value { key, length };
                    return Ok(Step::NeedBytes);
                }
                let value = self.unread()[..length].to_vec();
                self.consume(length);
                self.records += 1;
                self.state = State::Control;
                Ok(Step::Item(ArchiveItem::Record { path: key, value }))
            }
            State::Ended => {
                self.state = State::Ended;
                Ok(Step::NeedBytes)
            }
            State::Failed(refusal) => Err(refusal),
        }
    }

    // An unsigned varint at the front of the unread bytes: seven bits a byte,
    // least significant group first, the high bit set on all but the last byte,
    // at most nine bytes, and no padding zero byte after the first.
    fn read_varint(
        &self,
        malformed: ArchiveRefusal,
    ) -> Result<Option<(u64, usize)>, ArchiveRefusal> {
        let mut value: u64 = 0;
        for (index, &byte) in self.unread().iter().take(MAX_VARINT_BYTES).enumerate() {
            value += u64::from(byte & !VARINT_CONTINUATION) << (VARINT_PAYLOAD_BITS * index as u32);
            if byte & VARINT_CONTINUATION == 0 {
                if byte == 0 && index > 0 {
                    return Err(malformed);
                }
                return Ok(Some((value, index + 1)));
            }
        }
        if self.unread().len() >= MAX_VARINT_BYTES {
            return Err(malformed);
        }
        Ok(None)
    }
}

enum Step {
    Item(ArchiveItem),
    Moved,
    NeedBytes,
}

/// The commit a page body carries, from the archive's metadata: the metadata
/// is the commit with the archive type added, so the type is checked and
/// removed and the other members pass through to the MAC verifier, which
/// decides what they must be.
pub fn commit_from_metadata(metadata: Value) -> Result<Value, ArchiveRefusal> {
    let Value::Object(mut members) = metadata else {
        return Err(ArchiveRefusal::MetadataNotAMap);
    };
    match members.remove("$type") {
        Some(Value::String(kind)) if kind == REPO_ARCHIVE_TYPE => Ok(Value::Object(members)),
        _ => Err(ArchiveRefusal::WrongMetadataType),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordOrderRefusal {
    InvalidPath,
    OutOfOrder,
}

impl fmt::Display for RecordOrderRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPath => "an archive path is not a collection and a record key",
            Self::OutOfOrder => "the archive paths are not strictly increasing by bytes",
        })
    }
}

impl std::error::Error for RecordOrderRefusal {}

/// Checks one path of an archive: it is a collection and a record key of valid
/// syntax, and its bytes are above the previous path's. The order is that of the
/// whole text `collection/rkey` as bytes, which is not always the order of the
/// pair (collection, rkey): `a.b.c.d/x` comes before `a.b.c/x`.
pub fn check_record_order(
    previous: Option<&[u8]>,
    key: &[u8],
) -> Result<RecordPath, RecordOrderRefusal> {
    let text = std::str::from_utf8(key).map_err(|_| RecordOrderRefusal::InvalidPath)?;
    let mut parts = text.split('/');
    let (Some(collection), Some(rkey), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(RecordOrderRefusal::InvalidPath);
    };
    let path = RecordPath::parse(collection, rkey).map_err(|_| RecordOrderRefusal::InvalidPath)?;
    if previous.is_some_and(|earlier| key <= earlier) {
        return Err(RecordOrderRefusal::OutOfOrder);
    }
    Ok(path)
}

#[cfg(test)]
mod counting {
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
    };

    thread_local! {
        static LARGEST_REQUEST: Cell<usize> = const { Cell::new(0) };
    }

    fn note(size: usize) {
        LARGEST_REQUEST.with(|largest| largest.set(largest.get().max(size)));
    }

    /// Wraps the system allocator and remembers, per thread, the largest block
    /// asked for, so a test can show that a declared length was never trusted
    /// with memory.
    pub(super) struct CountingAllocator;

    // SAFETY: every call is forwarded unchanged to the system allocator; the
    // only addition is a write to a thread-local `Cell` that needs no
    // allocation or destructor.
    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            note(layout.size());
            unsafe { System.alloc(layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            note(layout.size());
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) }
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            note(new_size);
            unsafe { System.realloc(pointer, layout, new_size) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    pub(super) fn largest_request_during<T>(work: impl FnOnce() -> T) -> (T, usize) {
        LARGEST_REQUEST.with(|largest| largest.set(0));
        let outcome = work();
        (outcome, LARGEST_REQUEST.with(Cell::get))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        space_kem::{AuthorKemKey, encapsulate_with_ephemeral_key},
        space_mac::{CommitResponseHeaders, MacRequestContext, verify_commit_response},
        space_set_hash::{SetHashState, set_hash_element},
    };
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    };

    const REPO_ARCHIVE: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/repo-archive.json");
    const RECORD_CID: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/record-cid.json");
    const COMMIT_MAC: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/commit-mac.json");
    const ORACLE_EXPORT: &str =
        include_str!("../../test/spaces-alignment/november/fixtures/hpke-export-oracle.json");

    const SPACE: &str = "at:space/did:web:bebop.example/zone.stratos.space.feed/crew";
    const REPO: &str = "did:plc:fayevalentine";
    const ARCHIVE_RECORDS: [(&str, &str); 4] = [
        ("a like with a strong reference", "app.bsky.feed.like/ed"),
        ("a repost", "app.bsky.feed.repost/jet"),
        ("a follow", "app.bsky.graph.follow/faye"),
        ("a post", "zone.stratos.feed.post/swordfish"),
    ];
    const MAGIC_BYTES: [u8; 4] = [0x2a, 0x6c, 0x01, 0x00];

    fn fixture() -> Value {
        serde_json::from_str(REPO_ARCHIVE).expect("fixture is json")
    }

    fn hex_bytes(text: &str) -> Vec<u8> {
        assert_eq!(text.len() % 2, 0, "{text}");
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
            .collect()
    }

    fn archive_bytes(section: &str) -> Vec<u8> {
        STANDARD
            .decode(fixture()[section]["bytes"].as_str().expect("bytes"))
            .expect("base64")
    }

    // The bytes of a record in record-cid.json, by name.
    fn record_bytes(name: &str) -> Vec<u8> {
        let vectors: Value = serde_json::from_str(RECORD_CID).expect("json");
        let row = vectors["records"]
            .as_array()
            .expect("records")
            .iter()
            .find(|row| row["name"] == name)
            .expect("record");
        let oracle = row["oracle"].as_str().expect("oracle");
        let hex = oracle
            .strip_prefix("accepted ")
            .and_then(|rest| rest.split_once(' '))
            .expect("accepted")
            .0;
        hex_bytes(hex)
    }

    #[derive(Debug, Eq, PartialEq)]
    struct Read {
        metadata: Option<Value>,
        records: Vec<(Vec<u8>, Vec<u8>)>,
    }

    fn read_in_chunks(chunks: &[&[u8]]) -> Result<Read, ArchiveRefusal> {
        let mut reader = ArchiveReader::new();
        let mut read = Read {
            metadata: None,
            records: Vec::new(),
        };
        for chunk in chunks {
            reader.push(chunk)?;
            while let Some(item) = reader.next_item()? {
                match item {
                    ArchiveItem::Metadata(metadata) => read.metadata = Some(metadata),
                    ArchiveItem::Record { path, value } => read.records.push((path, value)),
                }
            }
        }
        reader.finish()?;
        Ok(read)
    }

    fn read_whole(bytes: &[u8]) -> Result<Read, ArchiveRefusal> {
        read_in_chunks(&[bytes])
    }

    // The commit the oracle wrote, from the header text of its commit MAC.
    fn commit_header_member(name: &str, open: char, close: char) -> String {
        let header = fixture()["archive"]["macHeaders"]["atproto-space-commit"]
            .as_str()
            .expect("header")
            .to_owned();
        let start = header.find(&format!("{name}={open}")).expect(name) + name.len() + 2;
        let end = start + header[start..].find(close).expect("close");
        header[start..end].to_owned()
    }

    fn commit_data() -> Vec<u8> {
        STANDARD
            .decode(commit_header_member("data", ':', ':'))
            .expect("data")
    }

    fn expected_metadata() -> Value {
        serde_json::json!({
            "$type": REPO_ARCHIVE_TYPE,
            "ver": 1,
            "repo": commit_header_member("repo", '"', '"'),
            "space": commit_header_member("space", '"', '"'),
            "rev": commit_header_member("rev", '"', '"'),
            "data": { "$bytes": STANDARD_NO_PAD.encode(commit_data()) },
        })
    }

    // Archive builders for the cases the oracle fixture does not hold.

    fn varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        while value >= 0x80 {
            bytes.push((value % 0x80) as u8 | 0x80);
            value /= 0x80;
        }
        bytes.push(value as u8);
        bytes
    }

    fn framed(bytes: &[u8]) -> Vec<u8> {
        let mut out = varint(bytes.len() as u64);
        out.extend_from_slice(bytes);
        out
    }

    fn pair(key: &[u8], value: &[u8]) -> Vec<u8> {
        let mut out = vec![0x01];
        out.extend(framed(key));
        out.extend(framed(value));
        out
    }

    fn type_only_metadata() -> Vec<u8> {
        let (_, metadata) = decode_record(&metadata_bytes(0)).expect("canonical");
        assert_eq!(metadata, serde_json::json!({ "$type": REPO_ARCHIVE_TYPE }));
        metadata_bytes(0)
    }

    // The canonical map {"$type": ..., "p": text}, `padding` characters long.
    fn metadata_bytes(padding: usize) -> Vec<u8> {
        use crate::space_record::encode_record;
        let record = if padding == 0 {
            serde_json::json!({ "$type": REPO_ARCHIVE_TYPE })
        } else {
            serde_json::json!({ "$type": REPO_ARCHIVE_TYPE, "p": "a".repeat(padding) })
        };
        encode_record(&record).expect("encodes")
    }

    fn metadata_of_length(length: usize) -> Vec<u8> {
        let floor = metadata_bytes(0).len();
        (1..=length - floor)
            .map(metadata_bytes)
            .find(|candidate| candidate.len() == length)
            .expect("a padding gives the length")
    }

    fn archive_of(metadata: &[u8], pairs: &[Vec<u8>]) -> Vec<u8> {
        let mut out = MAGIC_BYTES.to_vec();
        out.extend(framed(metadata));
        for one in pairs {
            out.extend_from_slice(one);
        }
        out.push(0x00);
        out
    }

    fn mac_context() -> MacRequestContext {
        let export: Value = serde_json::from_str(ORACLE_EXPORT).expect("fixture");
        let author = AuthorKemKey::from_did_key(
            export["oracleExport"]["authorKemDid"]
                .as_str()
                .expect("did"),
        )
        .expect("author key");
        let ephemeral = hex_bytes(
            export["oracleExport"]["ephemeralPrivateKey"]["value"]
                .as_str()
                .expect("hex"),
        );
        let secret = encapsulate_with_ephemeral_key(&author, &ephemeral).expect("secret");
        MacRequestContext::new(secret, REPO, SPACE)
    }

    fn mac_headers() -> CommitResponseHeaders {
        let commit_mac: Value = serde_json::from_str(COMMIT_MAC).expect("fixture");
        let headers = &fixture()["archive"]["macHeaders"];
        CommitResponseHeaders {
            commit: vec![
                headers["atproto-space-commit"]
                    .as_str()
                    .expect("h")
                    .to_owned(),
            ],
            signature_input: vec![
                commit_mac["acceptSignature"]
                    .as_str()
                    .expect("r")
                    .to_owned(),
            ],
            signature: vec![headers["signature"].as_str().expect("s").to_owned()],
        }
    }

    // Everything a synchronizer would ask of an archive short of the store: the
    // reader, the commit, the response's MAC against it, each record's path,
    // order and canonical form, and the digest. The answer names the layer that
    // refused.
    fn judge(bytes: &[u8]) -> Result<(), String> {
        let read = read_whole(bytes).map_err(|refusal| format!("reader {refusal:?}"))?;
        let metadata = read
            .metadata
            .clone()
            .expect("a finished archive has metadata");
        let commit =
            commit_from_metadata(metadata).map_err(|refusal| format!("commit {refusal:?}"))?;
        let verified = verify_commit_response(mac_context(), &mac_headers(), &commit)
            .map_err(|error| format!("mac {error:?}"))?;
        let mut state = SetHashState::empty();
        let mut previous: Option<Vec<u8>> = None;
        for (key, value) in &read.records {
            let path = check_record_order(previous.as_deref(), key)
                .map_err(|refusal| format!("order {refusal:?}"))?;
            previous = Some(key.clone());
            let (cid, _) = decode_record(value).map_err(|refusal| format!("record {refusal:?}"))?;
            state.add(&set_hash_element(&path, &cid));
        }
        if &state.digest() != verified.data() {
            return Err("digest".to_owned());
        }
        Ok(())
    }

    // Oracle vectors: archives the pinned package wrote.

    #[test]
    fn the_oracle_archive_reads_to_its_commit_and_its_four_records() {
        let read = read_whole(&archive_bytes("archive")).expect("reads");
        let metadata = read.metadata.expect("metadata");
        assert_eq!(metadata, expected_metadata());
        assert_eq!(metadata["repo"], REPO);
        assert_eq!(metadata["space"], SPACE);
        let expected: Vec<(Vec<u8>, Vec<u8>)> = ARCHIVE_RECORDS
            .iter()
            .map(|(name, path)| (path.as_bytes().to_vec(), record_bytes(name)))
            .collect();
        assert_eq!(read.records, expected);
    }

    #[test]
    fn the_oracle_archive_of_the_empty_repo_reads_to_a_commit_and_no_records() {
        let read = read_whole(&archive_bytes("empty")).expect("reads");
        let metadata = read.metadata.expect("metadata");
        assert_eq!(metadata["$type"], REPO_ARCHIVE_TYPE);
        assert_eq!(
            STANDARD_NO_PAD
                .decode(metadata["data"]["$bytes"].as_str().expect("data"))
                .expect("base64"),
            SetHashState::empty().digest()
        );
        assert!(read.records.is_empty());
    }

    // Cross-check of the layers over one oracle archive: the response's MAC
    // verifies for the commit read from its metadata, the paths pass, every
    // record decodes, and the set hash of them is the commit's data.
    #[test]
    fn the_oracle_archive_passes_every_layer_and_hashes_to_its_commit() {
        assert_eq!(judge(&archive_bytes("archive")), Ok(()));
        let commit = commit_from_metadata(
            read_whole(&archive_bytes("archive"))
                .expect("reads")
                .metadata
                .expect("metadata"),
        )
        .expect("commit");
        assert_eq!(
            commit,
            serde_json::json!({
                "ver": 1,
                "repo": REPO,
                "space": SPACE,
                "rev": commit_header_member("rev", '"', '"'),
                "data": { "$bytes": STANDARD_NO_PAD.encode(commit_data()) },
            })
        );
    }

    // Every refused variant of the fixture, with the layer that refuses it here
    // and the oracle's verdict beside it. The oracle refuses each too; where it
    // refuses later than this code does, the row says so.
    const VARIANT_LAYERS: &[(&str, &str)] = &[
        ("cut before the end marker", "reader UnexpectedEnd"),
        ("cut inside a value", "reader UnexpectedEnd"),
        ("an unknown control byte", "reader UnknownControl"),
        ("one byte after the end", "reader TrailingBytes"),
        ("two records swapped", "order OutOfOrder"),
        ("a record repeated", "order OutOfOrder"),
        ("a path that is not collection/rkey", "order InvalidPath"),
        ("one value byte changed", "digest"),
        // The oracle refuses these bytes at the digest, because it hashes the
        // received bytes; here the record decoder refuses them first.
        (
            "a non-canonical encoding of the record",
            "record NotCanonical",
        ),
        ("metadata type changed", "commit WrongMetadataType"),
        (
            "metadata revision changed",
            "mac Invalid(CommitDiffersFromSignedHeader)",
        ),
        (
            "a metadata length above the limit",
            "reader LimitExceeded(Metadata)",
        ),
        ("a key length above the limit", "reader LimitExceeded(Key)"),
        (
            "a value length above the limit, no bytes",
            "reader LimitExceeded(Value)",
        ),
    ];

    fn apply_edit(archive: &[u8], edit: &Value) -> Vec<u8> {
        let at = edit["at"].as_u64().expect("at") as usize;
        let remove = edit["remove"].as_u64().expect("remove") as usize;
        let mut out = archive[..at].to_vec();
        out.extend(hex_bytes(edit["insert"].as_str().expect("insert")));
        out.extend_from_slice(&archive[at + remove..]);
        out
    }

    #[test]
    fn every_refused_variant_of_the_oracle_archive_is_refused_at_its_layer() {
        let fixture = fixture();
        let edits = fixture["refused"].as_array().expect("refused");
        assert_eq!(edits.len(), VARIANT_LAYERS.len());
        let archive = archive_bytes("archive");
        let mut wrong = Vec::new();
        for (edit, (name, layer)) in edits.iter().zip(VARIANT_LAYERS) {
            assert_eq!(edit["name"], *name);
            assert!(
                edit["verdict"]
                    .as_str()
                    .expect("verdict")
                    .starts_with("refused: "),
                "{name}: the oracle refuses it"
            );
            let outcome = judge(&apply_edit(&archive, edit));
            if outcome != Err((*layer).to_owned()) {
                wrong.push(format!("{name}: {outcome:?}"));
            }
        }
        assert_eq!(wrong, Vec::<String>::new());
    }

    // Framing edge table. The oracle column is the pinned STAR reader
    // (`@atproto/star`, Node 24.22.0) with the repo profile's limits of 64 KiB,
    // 4 KiB and 1 MiB, its pairs drained: `accepted N pairs` or its error
    // message (always a StarParseError except one). The reader here reads no
    // base64 and the oracle's framing uses no runtime facility that differs
    // between runtimes. The Rust column is `reader` then `commit_from_metadata`;
    // `None` means the same acceptance. Every row the oracle refuses is
    // refused here; no row the oracle accepts is refused except the limits no
    // upstream rule has, which are in the limit table.

    struct FramingRow {
        name: &'static str,
        hex: &'static str,
        oracle: &'static str,
        stratos: Option<ArchiveRefusal>,
    }

    const FRAMING_ROWS: &[FramingRow] = &[
        FramingRow {
            name: "an empty input",
            hex: "",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "the first magic byte only",
            hex: "2a",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "three magic bytes",
            hex: "2a6c01",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "the magic and nothing else",
            hex: "2a6c0100",
            oracle: "refused: unexpected end of archive",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "magic with byte 0 changed",
            hex: "3a6c01001aa165247479706572617470726f746f2d73706163652d7265706f00",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "magic with byte 1 changed",
            hex: "2a7c01001aa165247479706572617470726f746f2d73706163652d7265706f00",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "magic with byte 2 changed",
            hex: "2a6c11001aa165247479706572617470726f746f2d73706163652d7265706f00",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "magic with byte 3 changed",
            hex: "2a6c01101aa165247479706572617470726f746f2d73706163652d7265706f00",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "magic of version 2 (2a 6c 02 00)",
            hex: "2a6c02001aa165247479706572617470726f746f2d73706163652d7265706f00",
            oracle: "refused: invalid magic bytes",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "metadata length 0",
            hex: "2a6c01000000",
            oracle: "refused: invalid metadata",
            stratos: Some(ArchiveRefusal::BadMetadata),
        },
        FramingRow {
            name: "metadata length varint 80 00 (padded zero)",
            hex: "2a6c0100800000",
            oracle: "refused: non-canonical varint",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "metadata length varint written in two bytes with a padded tail (a0 00)",
            hex: "2a6c0100a00000",
            oracle: "refused: non-canonical varint",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "metadata length as a nine byte varint (2^56)",
            hex: "2a6c010080808080808080800100",
            oracle: "refused: length 72057594037927940 exceeds limit of 65536",
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Metadata)),
        },
        FramingRow {
            name: "metadata length as ten bytes of continuation",
            hex: "2a6c01008080808080808080808000",
            oracle: "refused: varint too long",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "metadata length as nine continuation bytes and no end",
            hex: "2a6c0100808080808080808080",
            oracle: "refused: varint too long",
            stratos: Some(ArchiveRefusal::BadHeader),
        },
        FramingRow {
            name: "metadata length declared 100, ten bytes given",
            hex: "2a6c010064a1652474797065726174",
            oracle: "refused: unexpected end of archive",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "metadata length cut inside its varint",
            hex: "2a6c010080",
            oracle: "refused: unexpected end of archive",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "metadata an array",
            hex: "2a6c0100018000",
            oracle: "refused: metadata must be a map with a $type",
            stratos: Some(ArchiveRefusal::MetadataNotAMap),
        },
        FramingRow {
            name: "metadata a text",
            hex: "2a6c010002616100",
            oracle: "refused: metadata must be a map with a $type",
            stratos: Some(ArchiveRefusal::MetadataNotAMap),
        },
        FramingRow {
            name: "metadata an integer",
            hex: "2a6c0100010100",
            oracle: "refused: metadata must be a map with a $type",
            stratos: Some(ArchiveRefusal::MetadataNotAMap),
        },
        FramingRow {
            name: "metadata a map without $type",
            hex: "2a6c010006a1637665720100",
            oracle: "refused: metadata must be a map with a $type",
            stratos: Some(ArchiveRefusal::WrongMetadataType),
        },
        FramingRow {
            name: "metadata $type that is not text",
            hex: "2a6c010008a16524747970650100",
            oracle: "refused: metadata must be a map with a $type",
            stratos: Some(ArchiveRefusal::WrongMetadataType),
        },
        FramingRow {
            name: "metadata with keys out of canonical order",
            hex: "2a6c01000ba26524747970656061620100",
            oracle: "refused: metadata is not canonical DRISL",
            stratos: Some(ArchiveRefusal::BadMetadata),
        },
        FramingRow {
            name: "metadata with a byte after its map inside its length",
            hex: "2a6c01001ba165247479706572617470726f746f2d73706163652d7265706f0000",
            oracle: "refused: invalid metadata",
            stratos: Some(ArchiveRefusal::BadMetadata),
        },
        FramingRow {
            name: "metadata an indefinite-length map",
            hex: "2a6c01000abf6524747970656178ff00",
            oracle: "refused: invalid metadata",
            stratos: Some(ArchiveRefusal::BadMetadata),
        },
        FramingRow {
            name: "metadata with a float",
            hex: "2a6c010014a26166fb3ff8000000000000652474797065617800",
            oracle: "refused: Error: Non-integer numbers (1.5) are not supported by the AT Data Model",
            stratos: Some(ArchiveRefusal::BadMetadata),
        },
        FramingRow {
            name: "no pairs and the end marker",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f00",
            oracle: "accepted 0 pairs",
            stratos: None,
        },
        FramingRow {
            name: "one pair",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0107612e622e632f64017800",
            oracle: "accepted 1 pairs",
            stratos: None,
        },
        FramingRow {
            name: "a pair with an empty key",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0100017800",
            oracle: "accepted 1 pairs",
            stratos: None,
        },
        FramingRow {
            name: "a pair with an empty value",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0107612e622e632f640000",
            oracle: "accepted 1 pairs",
            stratos: None,
        },
        FramingRow {
            name: "end of input right after the metadata",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f",
            oracle: "refused: unexpected end of archive",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "a pair control byte and then the end of input",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f01",
            oracle: "refused: unexpected end of archive",
            stratos: Some(ArchiveRefusal::UnexpectedEnd),
        },
        FramingRow {
            name: "control byte 2 where a pair belongs",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0200",
            oracle: "refused: invalid control byte: 2",
            stratos: Some(ArchiveRefusal::UnknownControl),
        },
        FramingRow {
            name: "control byte 3 where a pair belongs",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0300",
            oracle: "refused: invalid control byte: 3",
            stratos: Some(ArchiveRefusal::UnknownControl),
        },
        FramingRow {
            name: "control byte 128 where a pair belongs",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f8000",
            oracle: "refused: invalid control byte: 128",
            stratos: Some(ArchiveRefusal::UnknownControl),
        },
        FramingRow {
            name: "control byte 255 where a pair belongs",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706fff00",
            oracle: "refused: invalid control byte: 255",
            stratos: Some(ArchiveRefusal::UnknownControl),
        },
        FramingRow {
            name: "key length varint 80 00 (padded zero)",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f018000017800",
            oracle: "refused: non-canonical varint",
            stratos: Some(ArchiveRefusal::BadLength),
        },
        FramingRow {
            name: "value length varint 80 00 (padded zero)",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f01016b800000",
            oracle: "refused: non-canonical varint",
            stratos: Some(ArchiveRefusal::BadLength),
        },
        FramingRow {
            name: "key length as ten bytes of continuation",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0180808080808080808080",
            oracle: "refused: varint too long",
            stratos: Some(ArchiveRefusal::BadLength),
        },
        FramingRow {
            name: "value length as ten bytes of continuation",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f01016b80808080808080808080",
            oracle: "refused: varint too long",
            stratos: Some(ArchiveRefusal::BadLength),
        },
        FramingRow {
            name: "key length 2^40 declared without bytes",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f01808080808020",
            oracle: "refused: length 1099511627776 exceeds limit of 4096",
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Key)),
        },
        FramingRow {
            name: "value length 2^40 declared without bytes",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f01016b808080808020",
            oracle: "refused: length 1099511627776 exceeds limit of 1048576",
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Value)),
        },
        FramingRow {
            name: "value length 2^56 declared without bytes (nine byte varint)",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f01016b808080808080808001",
            oracle: "refused: length 72057594037927940 exceeds limit of 1048576",
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Value)),
        },
        FramingRow {
            name: "value length 2^63 declared without bytes (nine byte varint)",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f01016bffffffffffffffff7f",
            oracle: "refused: length 9223372036854776000 exceeds limit of 1048576",
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Value)),
        },
        FramingRow {
            name: "two end markers",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0000",
            oracle: "refused: unexpected bytes after end of archive",
            stratos: Some(ArchiveRefusal::TrailingBytes),
        },
        FramingRow {
            name: "an end marker and then a pair",
            hex: "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f000107612e622e632f650179",
            oracle: "refused: unexpected bytes after end of archive",
            stratos: Some(ArchiveRefusal::TrailingBytes),
        },
    ];

    fn read_and_commit(bytes: &[u8]) -> Result<Read, ArchiveRefusal> {
        let read = read_whole(bytes)?;
        commit_from_metadata(
            read.metadata
                .clone()
                .expect("a finished archive has metadata"),
        )?;
        Ok(read)
    }

    #[test]
    fn every_framing_edge_input_gets_the_oracle_verdict_or_its_named_refusal() {
        assert!(FRAMING_ROWS.len() >= 45);
        let mut disagreements = Vec::new();
        for row in FRAMING_ROWS {
            let outcome = read_and_commit(&hex_bytes(row.hex));
            if outcome.as_ref().err().copied() != row.stratos {
                disagreements.push(format!("{}: {outcome:?}", row.name));
                continue;
            }
            match (row.oracle.strip_prefix("accepted "), &outcome) {
                (Some(pairs), Ok(read)) => {
                    let expected: usize = pairs.trim_end_matches(" pairs").parse().expect("count");
                    if read.records.len() != expected {
                        disagreements.push(format!("{}: {} records", row.name, read.records.len()));
                    }
                }
                (Some(_), Err(_)) => {
                    disagreements.push(format!("{}: refused but the oracle accepts it", row.name))
                }
                (None, Ok(_)) => disagreements.push(format!(
                    "{}: accepted but the oracle refuses it ({})",
                    row.name, row.oracle
                )),
                (None, Err(_)) => {}
            }
        }
        assert_eq!(disagreements, Vec::<String>::new());
    }

    // Limits at the edge, built here. The oracle column is its answer to the
    // same bytes with the limits above. The oracle has no record count and no
    // whole-archive limit, so the rows over those are stricter, each with its
    // reason.

    struct LimitRow {
        name: &'static str,
        oracle: &'static str,
        build: fn() -> Vec<u8>,
        stratos: Option<ArchiveRefusal>,
        stricter_because: Option<&'static str>,
    }

    fn with_pairs(pairs: &[Vec<u8>]) -> Vec<u8> {
        archive_of(&type_only_metadata(), pairs)
    }

    fn many_pairs(count: usize) -> Vec<u8> {
        let pairs: Vec<Vec<u8>> = (0..count)
            .map(|at| pair(format!("a.b.c/k{at:06}").as_bytes(), b"x"))
            .collect();
        with_pairs(&pairs)
    }

    // Values of 1 MiB fill an archive of exactly `total` bytes.
    fn archive_of_size(total: usize) -> Vec<u8> {
        let fixed = archive_of(&type_only_metadata(), &[]).len();
        let mut remaining = total - fixed;
        let mut pairs = Vec::new();
        while remaining > 0 {
            let key = format!("a.b.c/k{:03}", pairs.len());
            let overhead = 1 + 1 + key.len() + 3;
            let value_length = (remaining - overhead).min(1 << 20);
            pairs.push(pair(key.as_bytes(), &vec![0x76; value_length]));
            remaining -= pairs.last().expect("a pair").len();
        }
        let archive = with_pairs(&pairs);
        assert_eq!(archive.len(), total);
        archive
    }

    const LIMIT_ROWS: &[LimitRow] = &[
        LimitRow {
            name: "metadata of 65536 bytes",
            oracle: "accepted 0 pairs",
            build: || archive_of(&metadata_of_length(64 * 1024), &[]),
            stratos: None,
            stricter_because: None,
        },
        LimitRow {
            name: "metadata of 65537 bytes",
            oracle: "refused: length 65537 exceeds limit of 65536",
            build: || archive_of(&metadata_of_length(64 * 1024 + 1), &[]),
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Metadata)),
            stricter_because: None,
        },
        LimitRow {
            name: "a key of 4096 bytes",
            oracle: "accepted 1 pairs",
            build: || with_pairs(&[pair(&[b'k'; 4096], b"x")]),
            stratos: None,
            stricter_because: None,
        },
        LimitRow {
            name: "a key of 4097 bytes",
            oracle: "refused: length 4097 exceeds limit of 4096",
            build: || with_pairs(&[pair(&[b'k'; 4097], b"x")]),
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Key)),
            stricter_because: None,
        },
        LimitRow {
            name: "a value of 1048576 bytes",
            oracle: "accepted 1 pairs",
            build: || with_pairs(&[pair(b"a.b.c/d", &vec![b'v'; 1 << 20])]),
            stratos: None,
            stricter_because: None,
        },
        LimitRow {
            name: "a value of 1048577 bytes",
            oracle: "refused: length 1048577 exceeds limit of 1048576",
            build: || with_pairs(&[pair(b"a.b.c/d", &vec![b'v'; (1 << 20) + 1])]),
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Value)),
            stricter_because: None,
        },
        LimitRow {
            name: "a value length of 1048577 declared without bytes",
            oracle: "refused: length 1048577 exceeds limit of 1048576",
            build: declared_oversized_value,
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Value)),
            stricter_because: None,
        },
        LimitRow {
            name: "20000 pairs",
            oracle: "accepted 20000 pairs",
            build: || many_pairs(MAX_SPACE_REPO_RECORDS),
            stratos: None,
            stricter_because: None,
        },
        LimitRow {
            name: "20001 pairs",
            oracle: "accepted 20001 pairs",
            build: || many_pairs(MAX_SPACE_REPO_RECORDS + 1),
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Records)),
            stricter_because: Some(
                "the oracle has no record count; a repo above the local count is a failed target, never a truncated state",
            ),
        },
        LimitRow {
            name: "an archive of 16777216 bytes",
            oracle: "accepted 16 pairs",
            build: || archive_of_size(MAX_SPACE_ARCHIVE_BYTES),
            stratos: None,
            stricter_because: None,
        },
        LimitRow {
            name: "an archive of 16777217 bytes",
            oracle: "accepted 16 pairs",
            build: || archive_of_size(MAX_SPACE_ARCHIVE_BYTES + 1),
            stratos: Some(ArchiveRefusal::LimitExceeded(ArchiveLimit::Archive)),
            stricter_because: Some(
                "the oracle has no whole-archive limit; a repo above the local size is a failed target, never a truncated state",
            ),
        },
    ];

    // The oracle's answer for a declaration of a value of 1 MiB + 1 bytes with
    // none of them following.
    fn declared_oversized_value() -> Vec<u8> {
        let mut bytes = MAGIC_BYTES.to_vec();
        bytes.extend(framed(&type_only_metadata()));
        bytes.push(0x01);
        bytes.extend(framed(b"k"));
        bytes.extend(varint((1 << 20) + 1));
        bytes
    }

    #[test]
    fn every_limit_row_gets_the_oracle_verdict_or_its_labelled_refusal() {
        let mut disagreements = Vec::new();
        for row in LIMIT_ROWS {
            let outcome = read_and_commit(&(row.build)());
            if outcome.as_ref().err().copied() != row.stratos {
                disagreements.push(format!("{}: {outcome:?}", row.name));
                continue;
            }
            let oracle_accepts = row.oracle.starts_with("accepted");
            if oracle_accepts && outcome.is_err() && row.stricter_because.is_none() {
                disagreements.push(format!("{}: stricter without a reason", row.name));
            }
            if !oracle_accepts && outcome.is_ok() {
                disagreements.push(format!("{}: accepted but the oracle refuses it", row.name));
            }
            if row.stricter_because.is_some() && !(oracle_accepts && outcome.is_err()) {
                disagreements.push(format!("{}: labelled stricter but is not", row.name));
            }
        }
        assert_eq!(disagreements, Vec::<String>::new());
    }

    // The oracle accepts none of the 55 proper prefixes of this two-record
    // archive and none of the 256 bytes appended to it.

    const TWO_RECORD_ARCHIVE: &str = "2a6c01001aa165247479706572617470726f746f2d73706163652d7265706f0107612e622e632f640278790107612e622e632f65017a00";

    #[test]
    fn no_prefix_of_an_archive_and_no_archive_with_a_byte_appended_is_read() {
        let archive = hex_bytes(TWO_RECORD_ARCHIVE);
        assert_eq!(read_and_commit(&archive).expect("reads").records.len(), 2);
        assert_eq!(archive.len(), 55);
        for end in 0..archive.len() {
            assert!(read_and_commit(&archive[..end]).is_err(), "prefix {end}");
        }
        for extra in 0..=u8::MAX {
            let mut longer = archive.clone();
            longer.push(extra);
            assert_eq!(
                read_and_commit(&longer),
                Err(ArchiveRefusal::TrailingBytes),
                "byte {extra}"
            );
        }
    }

    // Chunking: the same archive in any split reads to the same output, and a
    // refused one to the same refusal.

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

    fn split_at_random<'a>(bytes: &'a [u8], generator: &mut Lcg) -> Vec<&'a [u8]> {
        let mut chunks = Vec::new();
        let mut from = 0;
        while from < bytes.len() {
            let widest = match generator.below(4) {
                0 => 1,
                1 => 8,
                2 => 64,
                _ => 512,
            };
            let to = (from + 1 + generator.below(widest)).min(bytes.len());
            chunks.push(&bytes[from..to]);
            if generator.below(8) == 0 {
                chunks.push(&bytes[to..to]);
            }
            from = to;
        }
        chunks
    }

    #[test]
    fn two_hundred_seeded_splits_of_each_oracle_archive_read_the_same() {
        let mut generator = Lcg(0x5eed_0044);
        for section in ["archive", "empty"] {
            let bytes = archive_bytes(section);
            let whole = read_whole(&bytes).expect("reads");
            let one_at_a_time: Vec<&[u8]> = bytes.chunks(1).collect();
            assert_eq!(
                read_in_chunks(&one_at_a_time).as_ref(),
                Ok(&whole),
                "{section}"
            );
            for round in 0..200 {
                let chunks = split_at_random(&bytes, &mut generator);
                assert_eq!(
                    read_in_chunks(&chunks).as_ref(),
                    Ok(&whole),
                    "{section} {round}"
                );
            }
        }
    }

    #[test]
    fn a_refused_variant_is_refused_the_same_way_in_any_split() {
        let mut generator = Lcg(0x5eed_0045);
        let archive = archive_bytes("archive");
        let fixture = fixture();
        for edit in fixture["refused"].as_array().expect("refused") {
            let bytes = apply_edit(&archive, edit);
            let whole = read_whole(&bytes);
            let one_at_a_time: Vec<&[u8]> = bytes.chunks(1).collect();
            assert_eq!(read_in_chunks(&one_at_a_time), whole, "{}", edit["name"]);
            for round in 0..20 {
                let chunks = split_at_random(&bytes, &mut generator);
                assert_eq!(read_in_chunks(&chunks), whole, "{} {round}", edit["name"]);
            }
        }
    }

    #[test]
    fn the_reader_holds_only_the_unread_tail_of_the_item_in_progress() {
        let mut reader = ArchiveReader::new();
        let bytes = archive_bytes("archive");
        let mut largest_tail = 0;
        for chunk in bytes.chunks(7) {
            reader.push(chunk).expect("pushes");
            while reader.next_item().expect("reads").is_some() {}
            largest_tail = largest_tail.max(reader.unread().len());
        }
        let longest_item = ARCHIVE_RECORDS
            .iter()
            .map(|(name, path)| record_bytes(name).len() + path.len() + 4)
            .max()
            .expect("records");
        assert!(largest_tail <= longest_item, "{largest_tail} bytes held");
        reader.finish().expect("complete");
    }

    // Allocation: a declared length is judged before memory is given to it.

    const NO_ALLOCATION_THIS_LARGE: usize = 32 * 1024;

    fn refused_at_once(declaration: &[u8]) -> (Result<Option<ArchiveItem>, ArchiveRefusal>, usize) {
        counting::largest_request_during(|| {
            let mut reader = ArchiveReader::new();
            reader.push(declaration).expect("pushes");
            loop {
                match reader.next_item() {
                    Ok(Some(_)) => {}
                    other => return other,
                }
            }
        })
    }

    #[test]
    fn a_value_of_a_mebibyte_and_one_declared_without_bytes_is_refused_at_once_and_allocates_nothing_of_that_size()
     {
        let (outcome, largest) = refused_at_once(&declared_oversized_value());
        assert_eq!(
            outcome,
            Err(ArchiveRefusal::LimitExceeded(ArchiveLimit::Value))
        );
        assert!(
            largest < NO_ALLOCATION_THIS_LARGE,
            "{largest} bytes asked for"
        );
    }

    #[test]
    fn a_key_or_metadata_over_its_limit_declared_without_bytes_is_refused_at_once_too() {
        let mut key_declared = MAGIC_BYTES.to_vec();
        key_declared.extend(framed(&type_only_metadata()));
        key_declared.push(0x01);
        key_declared.extend(varint(4 * 1024 + 1));
        let (outcome, largest) = refused_at_once(&key_declared);
        assert_eq!(
            outcome,
            Err(ArchiveRefusal::LimitExceeded(ArchiveLimit::Key))
        );
        assert!(largest < NO_ALLOCATION_THIS_LARGE, "{largest}");

        let mut metadata_declared = MAGIC_BYTES.to_vec();
        metadata_declared.extend(varint(64 * 1024 + 1));
        let (outcome, largest) = refused_at_once(&metadata_declared);
        assert_eq!(
            outcome,
            Err(ArchiveRefusal::LimitExceeded(ArchiveLimit::Metadata))
        );
        assert!(largest < NO_ALLOCATION_THIS_LARGE, "{largest}");
    }

    #[test]
    fn a_value_within_its_limit_declared_but_not_sent_waits_without_reserving_it() {
        let mut declared = MAGIC_BYTES.to_vec();
        declared.extend(framed(&type_only_metadata()));
        declared.push(0x01);
        declared.extend(framed(b"a.b.c/d"));
        declared.extend(varint(1 << 20));
        declared.extend_from_slice(&[0x76; 10]);
        let (outcome, largest) = refused_at_once(&declared);
        assert_eq!(outcome, Ok(None));
        assert!(largest < NO_ALLOCATION_THIS_LARGE, "{largest}");
    }

    #[test]
    fn an_item_that_would_end_past_the_archive_limit_is_refused_at_its_declaration() {
        let mut reader = ArchiveReader::new();
        let near_limit = archive_of_size(MAX_SPACE_ARCHIVE_BYTES - 100);
        let without_end = &near_limit[..near_limit.len() - 1];
        for chunk in without_end.chunks(1 << 16) {
            reader.push(chunk).expect("pushes");
            while reader.next_item().expect("reads").is_some() {}
        }
        reader.push(&[0x01]).expect("pushes");
        reader.push(&framed(b"a.b.c/z")).expect("pushes");
        reader.push(&varint(200)).expect("pushes");
        assert_eq!(
            reader.next_item(),
            Err(ArchiveRefusal::LimitExceeded(ArchiveLimit::Archive))
        );
    }

    #[test]
    fn a_refused_reader_stays_refused() {
        let mut reader = ArchiveReader::new();
        reader.push(&[0x2a, 0x00]).expect("pushes");
        assert_eq!(reader.next_item(), Err(ArchiveRefusal::BadHeader));
        assert_eq!(reader.push(&[0x6c]), Err(ArchiveRefusal::BadHeader));
        assert_eq!(reader.next_item(), Err(ArchiveRefusal::BadHeader));
        assert_eq!(reader.finish(), Err(ArchiveRefusal::BadHeader));
    }

    #[test]
    fn bytes_pushed_after_the_end_marker_are_refused_at_the_push() {
        let mut reader = ArchiveReader::new();
        reader.push(&archive_bytes("empty")).expect("pushes");
        while reader.next_item().expect("reads").is_some() {}
        assert_eq!(reader.push(&[]), Ok(()));
        assert_eq!(reader.push(&[0x00]), Err(ArchiveRefusal::TrailingBytes));
        assert_eq!(reader.finish(), Err(ArchiveRefusal::TrailingBytes));
    }

    // The commit function.

    #[test]
    fn the_commit_is_the_metadata_without_its_type() {
        let metadata = serde_json::json!({
            "$type": REPO_ARCHIVE_TYPE, "ver": 1, "repo": REPO, "space": SPACE,
            "rev": "3jzfcijpj2z2d", "data": { "$bytes": "AAAA" },
        });
        assert_eq!(
            commit_from_metadata(metadata).expect("commit"),
            serde_json::json!({
                "ver": 1, "repo": REPO, "space": SPACE, "rev": "3jzfcijpj2z2d",
                "data": { "$bytes": "AAAA" },
            })
        );
    }

    #[test]
    fn a_metadata_of_another_type_or_none_is_not_a_repo_commit() {
        for metadata in [
            serde_json::json!({ "ver": 1 }),
            serde_json::json!({ "$type": "atproto-space-meta", "ver": 1 }),
            serde_json::json!({ "$type": 1 }),
            serde_json::json!({ "$type": "ATPROTO-SPACE-REPO" }),
            serde_json::json!({ "$type": null }),
        ] {
            assert_eq!(
                commit_from_metadata(metadata.clone()),
                Err(ArchiveRefusal::WrongMetadataType),
                "{metadata}"
            );
        }
        assert_eq!(
            commit_from_metadata(serde_json::json!([1])),
            Err(ArchiveRefusal::MetadataNotAMap)
        );
    }

    // Record order. The oracle column is the pinned reader of an archive of
    // these paths in this order (`readRepoStar`, in the earlier space spelling
    // that reader insists on): `accepted` or `refused: records out of order`.
    // The order is that of the bytes of the whole path text.

    struct OrderRow {
        name: &'static str,
        keys: &'static [&'static str],
        oracle: &'static str,
        stratos: Option<RecordOrderRefusal>,
    }

    const ORDER_ROWS: &[OrderRow] = &[
        OrderRow {
            name: "ascending rkeys",
            keys: &["a.b.c/a", "a.b.c/b"],
            oracle: "accepted",
            stratos: None,
        },
        OrderRow {
            name: "descending rkeys",
            keys: &["a.b.c/b", "a.b.c/a"],
            oracle: "refused: records out of order",
            stratos: Some(RecordOrderRefusal::OutOfOrder),
        },
        OrderRow {
            name: "the same path twice",
            keys: &["a.b.c/a", "a.b.c/a"],
            oracle: "refused: records out of order",
            stratos: Some(RecordOrderRefusal::OutOfOrder),
        },
        OrderRow {
            name: "a dot-extended collection first (bytes order)",
            keys: &["a.b.c.d/x", "a.b.c/x"],
            oracle: "accepted",
            stratos: None,
        },
        OrderRow {
            name: "the shorter collection first (pair order)",
            keys: &["a.b.c/x", "a.b.c.d/x"],
            oracle: "refused: records out of order",
            stratos: Some(RecordOrderRefusal::OutOfOrder),
        },
        OrderRow {
            name: "uppercase before lowercase",
            keys: &["a.b.c/B", "a.b.c/a"],
            oracle: "accepted",
            stratos: None,
        },
        OrderRow {
            name: "lowercase before uppercase",
            keys: &["a.b.c/a", "a.b.c/B"],
            oracle: "refused: records out of order",
            stratos: Some(RecordOrderRefusal::OutOfOrder),
        },
        OrderRow {
            name: "hyphen before dot in a record key",
            keys: &["a.b.c/a-b", "a.b.c/a.b"],
            oracle: "accepted",
            stratos: None,
        },
        OrderRow {
            name: "dot before hyphen in a record key",
            keys: &["a.b.c/a.b", "a.b.c/a-b"],
            oracle: "refused: records out of order",
            stratos: Some(RecordOrderRefusal::OutOfOrder),
        },
        OrderRow {
            name: "a prefix key before its extension",
            keys: &["a.b.c/a", "a.b.c/ab"],
            oracle: "accepted",
            stratos: None,
        },
        OrderRow {
            name: "an extension before its prefix key",
            keys: &["a.b.c/ab", "a.b.c/a"],
            oracle: "refused: records out of order",
            stratos: Some(RecordOrderRefusal::OutOfOrder),
        },
        OrderRow {
            name: "three ascending paths across collections",
            keys: &[
                "app.bsky.feed.like/ed",
                "app.bsky.graph.follow/faye",
                "zone.stratos.feed.post/swordfish",
            ],
            oracle: "accepted",
            stratos: None,
        },
        OrderRow {
            name: "collections one letter apart",
            keys: &["app.bsky.feed.like/a", "app.bsky.feed.likf/a"],
            oracle: "accepted",
            stratos: None,
        },
    ];

    fn first_order_refusal(keys: &[&[u8]]) -> Option<RecordOrderRefusal> {
        let mut previous: Option<&[u8]> = None;
        for key in keys {
            if let Err(refusal) = check_record_order(previous, key) {
                return Some(refusal);
            }
            previous = Some(key);
        }
        None
    }

    #[test]
    fn every_path_order_gets_the_oracle_verdict() {
        for row in ORDER_ROWS {
            let keys: Vec<&[u8]> = row.keys.iter().map(|key| key.as_bytes()).collect();
            assert_eq!(first_order_refusal(&keys), row.stratos, "{}", row.name);
            assert_eq!(
                row.oracle == "accepted",
                row.stratos.is_none(),
                "{}: the oracle's verdict",
                row.name
            );
        }
    }

    #[test]
    fn the_byte_order_of_whole_paths_is_not_the_order_of_collection_then_key() {
        let bytes_first: [&[u8]; 2] = [b"a.b.c.d/x", b"a.b.c/x"];
        assert_eq!(first_order_refusal(&bytes_first), None);
        let pair_order = (("a.b.c.d", "x"), ("a.b.c", "x"));
        assert!(pair_order.0 > pair_order.1);
    }

    // A path's shape. The oracle column is the pinned reader of an archive of
    // that one path: `accepted` or the start of its refusal.

    struct ShapeRow {
        name: &'static str,
        key_hex: &'static str,
        oracle: &'static str,
        stratos: Option<RecordOrderRefusal>,
    }

    const SHAPE_ROWS: &[ShapeRow] = &[
        ShapeRow {
            name: "a path with no slash",
            key_hex: "612e622e63",
            oracle: "refused: invalid record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a path with two slashes",
            key_hex: "612e622e632f642f65",
            oracle: "refused: invalid record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "an empty path",
            key_hex: "",
            oracle: "refused: invalid record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a path starting with a slash",
            key_hex: "2f64",
            oracle: "refused: invalid NSID in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a path ending with a slash",
            key_hex: "612e622e632f",
            oracle: "refused: invalid record key in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a collection of two segments",
            key_hex: "612e622f64",
            oracle: "refused: invalid NSID in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a collection with an empty segment",
            key_hex: "612e2e632f64",
            oracle: "refused: invalid NSID in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a collection starting with a digit in its first segment",
            key_hex: "31612e622e632f64",
            oracle: "refused: invalid NSID in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a collection with an uppercase authority letter",
            key_hex: "412e622e632f64",
            oracle: "accepted",
            stratos: None,
        },
        ShapeRow {
            name: "a collection with an underscore",
            key_hex: "612e622e635f642f65",
            oracle: "refused: invalid NSID in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a record key of a single dot",
            key_hex: "612e622e632f2e",
            oracle: "refused: invalid record key in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a record key of two dots",
            key_hex: "612e622e632f2e2e",
            oracle: "refused: invalid record key in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a record key with a space",
            key_hex: "612e622e632f612062",
            oracle: "refused: invalid record key in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a record key with a tilde",
            key_hex: "612e622e632f617e62",
            oracle: "accepted",
            stratos: None,
        },
        ShapeRow {
            name: "a record key with a colon",
            key_hex: "612e622e632f613a62",
            oracle: "accepted",
            stratos: None,
        },
        ShapeRow {
            name: "a record key with a percent sign",
            key_hex: "612e622e632f612562",
            oracle: "refused: invalid record key in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a record key with a non-ASCII letter",
            key_hex: "612e622e632fc3a9",
            oracle: "refused: invalid record key in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a collection with a segment of 64 characters",
            key_hex: "616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161612e622e632f6b",
            oracle: "refused: invalid NSID in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a collection with a segment of 63 characters",
            key_hex: "6161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161612e622e632f6b",
            oracle: "accepted",
            stratos: None,
        },
        ShapeRow {
            name: "a path that is not UTF-8 (a.b.c/ then ff)",
            key_hex: "612e622e632fff",
            oracle: "refused: invalid record key in record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
        ShapeRow {
            name: "a path with an overlong UTF-8 slash (c0 af)",
            key_hex: "612e622e63c0af64",
            oracle: "refused: invalid record path",
            stratos: Some(RecordOrderRefusal::InvalidPath),
        },
    ];

    #[test]
    fn every_path_shape_gets_the_oracle_verdict() {
        for row in SHAPE_ROWS {
            let key = hex_bytes(row.key_hex);
            assert_eq!(
                check_record_order(None, &key).err(),
                row.stratos,
                "{}",
                row.name
            );
            assert_eq!(
                row.oracle == "accepted",
                row.stratos.is_none(),
                "{}: the oracle's verdict",
                row.name
            );
        }
    }

    fn long_collection(length: usize) -> String {
        let mut collection = ["a", "b", "c", "d"]
            .iter()
            .map(|letter| letter.repeat(63))
            .collect::<Vec<_>>()
            .join(".");
        collection.push('.');
        collection.push_str(&"e".repeat(length - collection.len()));
        collection
    }

    // The oracle accepts a record key of 512 characters and a collection of 317
    // and refuses 513 and 318 (invalid record key / invalid NSID in record path).
    #[test]
    fn path_parts_at_their_length_limits_are_accepted_and_one_over_refused() {
        let key = |collection: &str, rkey: &str| format!("{collection}/{rkey}");
        assert!(check_record_order(None, key("a.b.c", &"k".repeat(512)).as_bytes()).is_ok());
        assert_eq!(
            check_record_order(None, key("a.b.c", &"k".repeat(513)).as_bytes()).err(),
            Some(RecordOrderRefusal::InvalidPath)
        );
        assert!(check_record_order(None, key(&long_collection(317), "k").as_bytes()).is_ok());
        assert_eq!(
            check_record_order(None, key(&long_collection(318), "k").as_bytes()).err(),
            Some(RecordOrderRefusal::InvalidPath)
        );
    }

    #[test]
    fn a_checked_path_is_the_parsed_collection_and_key() {
        let path = check_record_order(
            Some(b"app.bsky.feed.like/ed"),
            b"zone.stratos.feed.post/swordfish",
        )
        .expect("in order");
        assert_eq!(path.collection(), "zone.stratos.feed.post");
        assert_eq!(path.rkey(), "swordfish");
    }
}
