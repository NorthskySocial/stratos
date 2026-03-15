import { fromUint8Array } from '@atcute/car'
import { decode, fromBytes, toCidLink } from '@atcute/cbor'
import { isCidLink, type CidLink } from '@atcute/cid'
import { CID } from 'multiformats/cid'
import { ipldToLex } from '@atproto/lexicon'

export interface DecodedOp {
  action: 'create' | 'update' | 'delete'
  path: string
  collection: string
  rkey: string
  cid?: string
  record?: Record<string, unknown>
}

export function decodeCommitOps(
  blocks: Uint8Array,
  ops: Array<{
    action: string
    path: string
    cid?: { $link: string } | null
  }>,
): DecodedOp[] {
  if (!blocks?.length) return []

  const car = readCarBlocks(blocks)
  const decoded: DecodedOp[] = []

  for (const op of ops) {
    const [collection, rkey] = op.path.split('/')
    const action = op.action as 'create' | 'update' | 'delete'

    if (action === 'delete') {
      decoded.push({ action, path: op.path, collection, rkey })
      continue
    }

    if (!op.cid) continue
    const cidLink = typeof op.cid === 'string' ? op.cid : op.cid.$link
    const record = car.get(cidLink) as Record<string, unknown> | undefined
    if (!record) continue

    decoded.push({
      action,
      path: op.path,
      collection,
      rkey,
      cid: cidLink,
      record,
    })
  }

  return decoded
}

function readCarBlocks(buffer: Uint8Array): Map<string, unknown> {
  const records = new Map<string, unknown>()
  for (const { cid, bytes } of fromUint8Array(buffer)) {
    records.set(toCidLink(cid).$link, decode(bytes))
  }
  return records
}

export function parseCid(
  cid: CidLink | { bytes: Uint8Array } | CID | string,
): CID {
  if (cid instanceof CID) return cid
  if (typeof cid === 'string') return CID.parse(cid)
  if (isCidLink(cid)) return CID.parse(cid.$link)
  if ('bytes' in cid) return CID.decode(cid.bytes)
  throw new Error('invalid CID')
}

export function jsonToLex(val: Record<string, unknown>): unknown {
  return ipldToLex(toIpld(val))
}

// Bridges both CBOR-decoded (CidLinkWrapper) and JSON-encoded ({$link}) CID
// formats to multiformats/cid CID objects that @atproto/lexicon expects.
function toIpld(val: unknown): unknown {
  if (val == null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(toIpld)
  if (isCidLink(val)) return CID.parse((val as CidLink).$link)
  if (val instanceof Uint8Array) return val

  const obj = val as Record<string, unknown>
  const keys = Object.keys(obj)

  // JSON-encoded CID: { "$link": "bafyrei..." }
  if (keys.length === 1 && typeof obj['$link'] === 'string') {
    return CID.parse(obj['$link'] as string)
  }

  // CBOR/JSON-encoded bytes: { "$bytes": "base64..." }
  if (keys.length === 1 && typeof obj['$bytes'] === 'string') {
    return fromBytes({ $bytes: obj['$bytes'] as string })
  }

  const result: Record<string, unknown> = {}
  for (const key of keys) {
    result[key] = toIpld(obj[key])
  }
  return result
}

export function extractBoundaries(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((d) => d.value)
    .filter((v): v is string => typeof v === 'string')
}
