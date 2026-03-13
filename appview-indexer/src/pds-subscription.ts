import { readCar as iterateCar } from '@atcute/car'
import { decode, decodeFirst, fromBytes, toCidLink } from '@atcute/cbor'
import { CID } from 'multiformats/cid'
import { BlobRef } from '@atproto/lexicon'
import { WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import { WebSocket } from 'partysocket'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { BackgroundQueue } from '@atproto/bsky'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

export interface EnrollmentCallback {
  onEnrollmentDiscovered: (
    did: string,
    serviceUrl: string,
    boundaries: string[],
  ) => void
  onEnrollmentRemoved: (did: string) => void
}

export interface PdsSubscriptionOptions {
  service: string
  indexingService: IndexingService
  background: BackgroundQueue
  enrollmentCallback: EnrollmentCallback
  cursor?: number
  onCursorUpdate?: (cursor: number) => void
  onError?: (err: Error) => void
}

export class PdsSubscription {
  private ws: WebSocket | null = null
  private cursor: string
  private running = false

  constructor(private opts: PdsSubscriptionOptions) {
    this.cursor = opts.cursor !== undefined ? String(opts.cursor) : ''
  }

  start(): void {
    this.running = true
    this.connect()
  }

  stop(): void {
    this.running = false
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  getCursor(): string {
    return this.cursor
  }

  private connect(): void {
    if (!this.running) return

    const url = `${this.opts.service}/xrpc/com.atproto.sync.subscribeRepos${this.cursor ? `?cursor=${this.cursor}` : ''}`

    this.ws = new WebSocket(url)
    this.ws.binaryType = 'arraybuffer'

    this.ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      void this.handleMessage(new Uint8Array(e.data))
    }

    this.ws.onerror = (e: Event & { error?: unknown }) => {
      this.opts.onError?.(
        new Error('PDS firehose WebSocket error', { cause: e.error }),
      )
    }
  }

  private async handleMessage(chunk: Uint8Array): Promise<void> {
    try {
      const event = decodeChunk(chunk)
      if (!event) return

      await this.processEvent(event)

      if (event.seq !== undefined) {
        this.cursor = String(event.seq)
        this.opts.onCursorUpdate?.(event.seq)
      }
    } catch (err) {
      this.opts.onError?.(
        new Error('failed to process PDS firehose message', { cause: err }),
      )
    }
  }

  private async processEvent(event: FirehoseEvent): Promise<void> {
    if (event.$type === 'com.atproto.sync.subscribeRepos#commit') {
      const commitEvent = event as CommitEvent

      this.opts.background.add(() =>
        this.opts.indexingService.indexHandle(
          commitEvent.did,
          commitEvent.time,
        ),
      )

      await this.opts.indexingService.setCommitLastSeen(
        commitEvent.did,
        parseCid(commitEvent.commit),
        commitEvent.rev,
      )

      for (const op of commitEvent.ops) {
        const uri = AtUri.make(commitEvent.did, ...op.path.split('/'))

        if (op.action === 'delete') {
          await this.opts.indexingService.deleteRecord(uri)
          this.checkEnrollmentOp(commitEvent.did, op, 'delete')
          continue
        }

        if (!op.record) continue

        await this.opts.indexingService.indexRecord(
          uri,
          parseCid(op.cid!),
          jsonToLex(op.record),
          op.action === 'create' ? WriteOpAction.Create : WriteOpAction.Update,
          commitEvent.time,
        )

        this.checkEnrollmentOp(commitEvent.did, op, op.action)
      }
    } else if (event.$type === 'com.atproto.sync.subscribeRepos#identity') {
      const identityEvent = event as IdentityEvent
      await this.opts.indexingService.indexHandle(
        identityEvent.did,
        identityEvent.time,
        true,
      )
    } else if (event.$type === 'com.atproto.sync.subscribeRepos#account') {
      const accountEvent = event as AccountEvent
      if (accountEvent.active === false && accountEvent.status === 'deleted') {
        await this.opts.indexingService.deleteActor(accountEvent.did)
      } else {
        await this.opts.indexingService.updateActorStatus(
          accountEvent.did,
          accountEvent.active,
          accountEvent.status,
        )
      }
    } else if (event.$type === 'com.atproto.sync.subscribeRepos#sync') {
      const syncEvent = event as SyncEvent
      const cid = parseCid(iterateCar(syncEvent.blocks).header.data.roots[0])
      await Promise.all([
        this.opts.indexingService.setCommitLastSeen(
          syncEvent.did,
          cid,
          syncEvent.rev,
        ),
        this.opts.indexingService.indexHandle(syncEvent.did, syncEvent.time),
      ])
    }
  }

  private checkEnrollmentOp(did: string, op: RecordOp, action: string): void {
    const collection = op.path.split('/')[0]
    if (collection !== ENROLLMENT_COLLECTION) return

    if (action === 'create' || action === 'update') {
      const record = op.record as Record<string, unknown> | undefined
      if (!record) return

      const serviceUrl =
        typeof record.service === 'string' ? record.service : ''
      const boundaries = extractBoundaries(record)

      if (serviceUrl) {
        this.opts.enrollmentCallback.onEnrollmentDiscovered(
          did,
          serviceUrl,
          boundaries,
        )
      }
    } else if (action === 'delete') {
      this.opts.enrollmentCallback.onEnrollmentRemoved(did)
    }
  }
}

// --- Event types ---

interface FirehoseEvent {
  $type: string
  seq?: number
}

interface CommitEvent extends FirehoseEvent {
  did: string
  commit: string
  rev: string
  time: string
  ops: RecordOp[]
}

interface IdentityEvent extends FirehoseEvent {
  did: string
  time: string
}

interface AccountEvent extends FirehoseEvent {
  did: string
  active: boolean
  status?: string
}

interface SyncEvent extends FirehoseEvent {
  did: string
  blocks: Uint8Array
  rev: string
  time: string
}

export interface RecordOp {
  action: 'create' | 'update' | 'delete'
  path: string
  cid?: string
  record?: Record<string, unknown>
}

// --- CBOR/CAR utilities (ported from bsky-indexer) ---

export function decodeChunk(chunk: Uint8Array): FirehoseEvent | undefined {
  const [header, remainder] = decodeFirst(chunk)
  const [body, remainder2] = decodeFirst(remainder)
  if (remainder2.length > 0) {
    throw new Error('excess bytes in message')
  }

  const { t, op } = parseHeader(header)

  if (op === -1) {
    throw new Error(`firehose error: ${(body as { message?: string }).message}`)
  }

  if (t === '#commit') {
    const {
      seq,
      repo,
      commit,
      rev,
      blocks: blocksBytes,
      ops: commitOps,
      time,
    } = body as {
      seq: number
      repo: string
      commit: { $link: string }
      rev: string
      blocks: { $bytes: string }
      ops: Array<{
        action: string
        path: string
        cid?: { $link: string }
        prev?: { $link: string }
      }>
      time: string
    }

    if (!blocksBytes?.$bytes?.length) return undefined

    const blocks = fromBytes(blocksBytes)
    if (!blocks?.length) return undefined

    const car = readCar(blocks)

    const ops: RecordOp[] = []
    for (const op of commitOps) {
      const action = op.action as 'create' | 'update' | 'delete'
      if (action === 'create' || action === 'update') {
        if (!op.cid) continue
        const record = car.get(op.cid.$link) as
          | Record<string, unknown>
          | undefined
        if (!record) continue
        ops.push({ action, path: op.path, cid: op.cid.$link, record })
      } else if (action === 'delete') {
        ops.push({ action, path: op.path })
      }
    }

    return {
      $type: 'com.atproto.sync.subscribeRepos#commit',
      seq,
      did: repo,
      commit: commit.$link,
      rev,
      ops,
      time,
    } as CommitEvent
  } else if (t === '#sync') {
    const {
      seq,
      did,
      blocks: blocksBytes,
      rev,
      time,
    } = body as {
      seq: number
      did: string
      blocks: { $bytes: string }
      rev: string
      time: string
    }

    if (!blocksBytes?.$bytes?.length) return undefined
    const blocks = fromBytes(blocksBytes)

    return {
      $type: 'com.atproto.sync.subscribeRepos#sync',
      seq,
      did,
      blocks,
      rev,
      time,
    } as unknown as SyncEvent
  } else if (t === '#account' || t === '#identity') {
    return {
      $type: `com.atproto.sync.subscribeRepos${t}`,
      ...(body as Record<string, unknown>),
    } as FirehoseEvent
  }

  return undefined
}

function parseHeader(header: unknown): { t: string; op: 1 | -1 } {
  if (
    !header ||
    typeof header !== 'object' ||
    !('t' in header) ||
    typeof (header as Record<string, unknown>).t !== 'string' ||
    !('op' in header) ||
    typeof (header as Record<string, unknown>).op !== 'number'
  ) {
    throw new Error('invalid firehose header')
  }
  return {
    t: (header as { t: string }).t,
    op: (header as { op: number }).op as 1 | -1,
  }
}

export function readCar(buffer: Uint8Array): Map<string, unknown> {
  const records = new Map<string, unknown>()
  for (const { cid, bytes } of iterateCar(buffer).iterate()) {
    records.set(toCidLink(cid).$link, decode(bytes))
  }
  return records
}

export function parseCid(
  cid: { $link: string } | { bytes: Uint8Array } | CID | string,
): CID {
  if (cid instanceof CID) return cid
  if (typeof cid === 'string') return CID.parse(cid)
  if ('$link' in cid) return CID.parse(cid.$link)
  if ('bytes' in cid) return CID.decode(cid.bytes)
  throw new Error('invalid CID')
}

export function jsonToLex(val: Record<string, unknown>): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => jsonToLex(item))
  }

  if (val && typeof val === 'object') {
    if (
      '$link' in val &&
      typeof val['$link'] === 'string' &&
      Object.keys(val).length === 1
    ) {
      return CID.parse(val['$link'])
    }
    if ('bytes' in val && val['bytes'] instanceof Uint8Array) {
      return CID.decode(val.bytes as Uint8Array)
    }
    if (
      '$bytes' in val &&
      typeof val['$bytes'] === 'string' &&
      Object.keys(val).length === 1
    ) {
      return fromBytes({ $bytes: val.$bytes as string })
    }
    if (
      val['$type'] === 'blob' ||
      (typeof val['cid'] === 'string' && typeof val['mimeType'] === 'string')
    ) {
      if ('ref' in val && typeof val['size'] === 'number') {
        return new BlobRef(
          CID.decode((val.ref as { bytes: Uint8Array }).bytes),
          val.mimeType as string,
          val.size as number,
        )
      }
      return new BlobRef(
        CID.parse(val.cid as string),
        val.mimeType as string,
        -1,
        val as never,
      )
    }

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(val)) {
      result[key] = jsonToLex(val[key] as Record<string, unknown>)
    }
    return result
  }

  return val
}

function extractBoundaries(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((d) => d.value)
    .filter((v): v is string => typeof v === 'string')
}
