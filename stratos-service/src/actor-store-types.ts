import type { AtUri } from '@atproto/syntax'
import type {
  BlobStore,
  BlockMap,
  CarBlock,
  CidSet,
  GetBacklinksOpts,
  ListRecordsOpts,
  RecordWithContent,
  RecordWithMeta,
  StatusAttr,
  StratosDbOrTx,
  StratosPgDbOrTx,
  StratosRecordDescript,
} from '@northskysocial/stratos-core'
import { Cid } from '@atproto/lex-data'

export type ActorStoreDb = StratosDbOrTx | StratosPgDbOrTx

// ─── Sequence Operations ────────────────────────────────────────────────────

/**
 * Interface for sequence operations in the actor store.
 */
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
    uri: string | AtUri,
    cid: string | null,
    includeSoftDeleted?: boolean,
  ): Promise<RecordWithMeta | null>
  hasRecord(
    uri: string | AtUri,
    cid: string | null,
    includeSoftDeleted?: boolean,
  ): Promise<boolean>
  getRecordTakedownStatus(uri: string | AtUri): Promise<StatusAttr | null>
  getCurrentRecordCid(uri: string | AtUri): Promise<Cid | null>
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
    uri: string,
    record: Record<string, unknown>,
  ): Promise<AtUri[]>
}

export interface ActorRecordTransactor extends ActorRecordReader {
  putRecord(record: {
    uri: string
    cid: Cid
    value: Record<string, unknown>
    content: Uint8Array
    indexedAt?: string
  }): Promise<void>
  indexRecord(
    uri: string | AtUri,
    cid: Cid,
    record: Record<string, unknown> | null,
    action?: 'create' | 'update',
    repoRev?: string,
    timestamp?: string,
  ): Promise<void>
  deleteRecord(uri: string | AtUri): Promise<void>
  removeBacklinksByUri(uri: string | AtUri): Promise<void>
  addBacklinks(
    backlinks: Array<{ uri: string | AtUri; path: string; linkTo: string }>,
  ): Promise<void>
  updateRecordTakedown(
    uri: string | AtUri,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void>
}

// ─── Repo Store Interface ───────────────────────────────────────────────────

export interface ActorRepoReader {
  db: ActorStoreDb
  cache: BlockMap
  readonly did?: string
  hasRoot(): Promise<boolean>
  getRoot(): Promise<Cid | null>
  getRootDetailed(): Promise<{ cid: Cid; rev: string } | null>
  getBytes(cid: Cid): Promise<Uint8Array | null>
  has(cid: Cid): Promise<boolean>
  getBlocks(cids: Cid[]): Promise<{ blocks: BlockMap; missing: Cid[] }>
  preloadBlocksForRev(rev: string): Promise<void>
  preloadRootSpine(commitCid: Cid): Promise<void>
  iterateCarBlocks(since?: string): AsyncIterable<CarBlock>
  getBlockRange(
    since?: string,
    cursor?: { rev: string; cid: string },
  ): Promise<Array<{ cid: string; repoRev: string; content: Uint8Array }>>
  countBlocks(): Promise<number>
  listExistingBlocks(): Promise<CidSet>
}

export interface ActorRepoTransactor extends ActorRepoReader {
  updateRoot(cid: Cid, rev: string, did: string): Promise<void>
  lockRoot(): Promise<{ cid: Cid; rev: string } | null>
  putBlock(cid: Cid, bytes: Uint8Array, rev: string): Promise<void>
  putBlocks(blocks: BlockMap, rev: string): Promise<void>
  deleteBlock(cid: Cid): Promise<void>
  deleteBlocks(cids: Cid[]): Promise<void>
  deleteBlocksForRev(rev: string): Promise<void>
  clearCache(): Promise<void>
}

// ─── Blob Store Interface ───────────────────────────────────────────────────

export interface ActorBlobReader {
  getBlobMetadata(cid: Cid): Promise<{ size: number; mimeType?: string } | null>
  getBlob(cid: Cid): Promise<{
    size: number
    mimeType?: string
    stream: AsyncIterable<Uint8Array>
  } | null>
  listBlobs(opts: {
    since?: string
    cursor?: string
    limit: number
  }): Promise<string[]>
  getBlobTakedownStatus(cid: Cid): Promise<StatusAttr | null>
  getRecordsForBlob(cid: Cid): Promise<string[]>
  hasBlob(cid: Cid): Promise<boolean>
}

export interface ActorBlobTransactor extends ActorBlobReader {
  trackBlob(blob: {
    cid: Cid
    mimeType: string
    size: number
    tempKey?: string | null
    width?: number | null
    height?: number | null
  }): Promise<void>
  associateBlobWithRecord(blobCid: Cid, recordUri: string): Promise<void>
  processBlobs(
    recordUri: string,
    blobs: Array<{ cid: Cid; mimeType: string; tempKey?: string | null }>,
  ): Promise<void>
  removeRecordBlobAssociations(recordUri: string): Promise<void>
  updateBlobTakedown(
    cid: Cid,
    takedown: { applied: boolean; ref?: string },
  ): Promise<void>
  deleteOrphanBlobs(): Promise<Cid[]>
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

/**
 * Interface for an actor store.
 *
 * Actor stores are responsible for managing the lifecycle of actors, including
 * their creation, destruction, and persistence. They provide a consistent
 * interface for accessing and manipulating actor-related data, including records,
 * repositories, and blobs.
 */
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
  readThenTransact<R, T>(
    did: string,
    readFn: (store: ActorReader) => R | PromiseLike<R>,
    transactFn: (
      readResult: Awaited<R>,
      store: ActorTransactor,
    ) => T | PromiseLike<T>,
  ): Promise<T>
  getBlobStore(did: string): BlobStore
  createSigningKey(did: string): Promise<import('@atproto/crypto').P256Keypair>
  loadSigningKey(
    did: string,
  ): Promise<import('@atproto/crypto').P256Keypair | null>
  deleteSigningKey(did: string): Promise<void>
}
