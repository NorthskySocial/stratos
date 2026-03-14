import { fromUint8Array } from '@atcute/car'
import { decode, fromBytes, toCidLink } from '@atcute/cbor'
import { CID } from 'multiformats/cid'
import { BlobRef } from '@atproto/lexicon'

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

export function extractBoundaries(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((d) => d.value)
    .filter((v): v is string => typeof v === 'string')
}
