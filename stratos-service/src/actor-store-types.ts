import type { CID } from 'multiformats/cid'
import type { AtUri } from '@atproto/syntax'
import type {
  BlobStore,
  StatusAttr,
  ListRecordsOpts,
  RecordWithContent,
  RecordWithMeta,
  GetBacklinksOpts,
  StratosRecordDescript,
  CarBlock,
  BlockMap,
  CidSet,
} from '@northskysocial/stratos-core'

// ─── Sequence Operations ────────────────────────────────────────────────────

export interface SequenceOperations {
  getLatestSeq(): Promise<number>
  getOldestSeq(): Promise<number>
  getEventsSince(
    cursor: number,
    limit?: number,
  ): Promise<
    Array<{
      seq: number
      did: string
      eventType: string
      event: Buffer
      invalidated: number
      sequencedAt: string
    }>
  >
  appendEvent(event: {
    did: string
    eventType: string
    event: Buffer
    invalidated: number
    sequencedAt: string
  }): Promise<void>
}

// ─── Record Store Interface ─────────────────────────────────────────────────

export interface ActorRecordReader {
  recordCount(): Promise<number>
  listAll(): Promise<StratosRecordDescript[]>
  listCollections(): Promise<string[]>
  listRecordsForCollection(opts: ListRecordsOpts): Promise<RecordWithContent[]>
  getRecord(
    uri: AtUri,
    cid: string | null,
    includeSoftDeleted?: boolean,
  ): Promise<RecordWithMeta | null>
  hasRecord(
    uri: AtUri,
    cid: string | null,
    includeSoftDeleted?: boolean,
  ): Promise<boolean>
  getRecordTakedownStatus(uri: AtUri): Promise<StatusAttr | null>
  getCurrentRecordCid(uri: AtUri): Promise<CID | null>
  getRecordBacklinks(opts: GetBacklinksOpts): Promise<
    Array<{
      uri: string
      cid: string
      collection: string
      rkey: string
      repoRev: string | null
      indexedAt: string
      takedownRef: string | null
    }>
  >
  getBacklinkConflicts(
    uri: AtUri,
    record: Record<string, unknown>,
  ): Promise<AtUri[]>
}

export interface ActorRecordTransactor extends ActorRecordReader {
  indexRecord(
    uri: AtUri,
    cid: CID,
    record: Record<string, unknown> | null,
    action?: 'create' | 'update',
    repoRev?: string,
    timestamp?: string,
  ): Promise<void>
  deleteRecord(uri: AtUri): Promise<void>
  removeBacklinksByUri(uri: AtUri): Promise<void>
  addBacklinks(
    backlinks: Array<{ uri: string; path: string; linkTo: string }>,
  ): Promise<void>
  updateRecordTakedown(
    uri: AtUri,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void>
}

// ─── Repo Store Interface ───────────────────────────────────────────────────

export interface ActorRepoReader {
  cache: BlockMap
  hasRoot(): Promise<boolean>
  getRoot(): Promise<CID | null>
  getRootDetailed(): Promise<{ cid: CID; rev: string } | null>
  getBytes(cid: CID): Promise<Uint8Array | null>
  has(cid: CID): Promise<boolean>
  getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }>
  iterateCarBlocks(since?: string): AsyncIterable<CarBlock>
  getBlockRange(
    since?: string,
    cursor?: { rev: string; cid: string },
  ): Promise<Array<{ cid: string; repoRev: string; content: Uint8Array }>>
  countBlocks(): Promise<number>
  listExistingBlocks(): Promise<CidSet>
}

export interface ActorRepoTransactor extends ActorRepoReader {
  updateRoot(cid: CID, rev: string, did: string): Promise<void>
  putBlock(cid: CID, bytes: Uint8Array, rev: string): Promise<void>
  putBlocks(blocks: BlockMap, rev: string): Promise<void>
  deleteBlock(cid: CID): Promise<void>
  deleteBlocks(cids: CID[]): Promise<void>
  deleteBlocksForRev(rev: string): Promise<void>
  clearCache(): Promise<void>
}

// ─── Blob Store Interface ───────────────────────────────────────────────────

export interface ActorBlobReader {
  getBlobMetadata(cid: CID): Promise<{ size: number; mimeType?: string } | null>
  getBlob(cid: CID): Promise<{
    size: number
    mimeType?: string
    stream: AsyncIterable<Uint8Array>
  } | null>
  listBlobs(opts: {
    since?: string
    cursor?: string
    limit: number
  }): Promise<string[]>
  getBlobTakedownStatus(cid: CID): Promise<StatusAttr | null>
  getRecordsForBlob(cid: CID): Promise<string[]>
  hasBlob(cid: CID): Promise<boolean>
}

export interface ActorBlobTransactor extends ActorBlobReader {
  trackBlob(blob: {
    cid: CID
    mimeType: string
    size: number
    tempKey?: string | null
    width?: number | null
    height?: number | null
  }): Promise<void>
  associateBlobWithRecord(blobCid: CID, recordUri: string): Promise<void>
  processBlobs(
    recordUri: string,
    blobs: Array<{ cid: CID; mimeType: string; tempKey?: string | null }>,
  ): Promise<void>
  removeRecordBlobAssociations(recordUri: string): Promise<void>
  updateBlobTakedown(
    cid: CID,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void>
  deleteOrphanBlobs(): Promise<CID[]>
}

// ─── Actor Store Interfaces ─────────────────────────────────────────────────

export interface ActorReader {
  did: string
  record: ActorRecordReader
  repo: ActorRepoReader
  blob: ActorBlobReader
  sequence: SequenceOperations
}

export interface ActorTransactor {
  did: string
  record: ActorRecordTransactor
  repo: ActorRepoTransactor
  blob: ActorBlobTransactor
  sequence: SequenceOperations
}

export interface ActorStore {
  close?(): Promise<void>
  exists(did: string): Promise<boolean>
  create(did: string): Promise<void>
  destroy(did: string): Promise<void>
  read<T>(
    did: string,
    fn: (store: ActorReader) => T | PromiseLike<T>,
  ): Promise<T>
  transact<T>(
    did: string,
    fn: (store: ActorTransactor) => T | PromiseLike<T>,
  ): Promise<T>
  getBlobStore(did: string): BlobStore
  createSigningKey(did: string): Promise<import('@atproto/crypto').P256Keypair>
  loadSigningKey(
    did: string,
  ): Promise<import('@atproto/crypto').P256Keypair | null>
  deleteSigningKey(did: string): Promise<void>
}
