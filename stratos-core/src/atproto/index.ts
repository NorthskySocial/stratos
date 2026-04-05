import {
  type Cid as LexCid,
  decodeCid as decodeLexCid,
  parseCid as parseLexCid,
} from '@atproto/lex-data'
import { InvalidIdentifierError } from '../shared/errors.js'
import {
  cidForLex,
  encode as cborEncode,
  type LexValue,
} from '@atproto/lex-cbor'
import { fromUint8Array } from '@atcute/car'
import { decode, fromBytes, toCidLink } from '@atcute/cbor'
import { type CidLink, isCidLink } from '@atcute/cid'

/**
 * Encodes a record using CBOR.
 * @param record - The record to encode.
 * @returns The CBOR-encoded record.
 */
export function encodeRecord(record: unknown): Uint8Array {
  // Use CBOR encoding for records
  return cborEncode(record as LexValue)
}

/**
 * Computes the CID for a given record using SHA-256 and DAG-CBOR codec.
 * @param record - The record to compute the CID for.
 * @returns The computed CID.
 */
export async function computeCid(record: unknown): Promise<LexCid> {
  // Compute CID using SHA-256 and DAG-CBOR codec
  const cid = await cidForLex(record as LexValue)
  return parseCid(cid.toString())
}

export interface DecodedOp {
  action: 'create' | 'update' | 'delete'
  path: string
  collection: string
  rkey: string
  cid?: string
  record?: Record<string, unknown>
}

/**
 * Decode commit operations from a CAR file and a list of operations.
 * @param blocks - The CAR file as a Uint8Array.
 * @param ops - The list of operations to decode.
 * @returns An array of decoded operations.
 */
export function decodeCommitOps(
  blocks: Uint8Array,
  ops: Array<{
    action: string
    path: string
    cid?: { $link: string } | string | null
  }>,
): DecodedOp[] {
  if (!blocks.length) return []

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

/**
 * Read CAR blocks from a Uint8Array and return a map of CID links to decoded records.
 * @param buffer - The CAR file as a Uint8Array.
 * @returns A map of CID links to decoded records.
 */
function readCarBlocks(buffer: Uint8Array): Map<string, unknown> {
  const records = new Map<string, unknown>()
  for (const { cid, bytes } of fromUint8Array(buffer)) {
    records.set(toCidLink(cid).$link, decode(bytes))
  }
  return records
}

/**
 * Parse a CID from a string, CidLink, or Uint8Array.
 * @param cid - The CID to parse.
 * @returns The parsed CID.
 * @throws {InvalidIdentifierError} If the CID is invalid.
 */
export function parseCid(
  cid: CidLink | { bytes: Uint8Array } | LexCid | string,
): LexCid {
  if (typeof cid === 'string') return parseLexCid(cid)
  if (isCidLink(cid)) return parseLexCid(cid.$link)
  if (typeof cid === 'object' && 'bytes' in cid) {
    const bytes = (cid as { bytes: Uint8Array }).bytes
    return decodeLexCid(bytes)
  }
  // If it's already a Cid object (has version, code, multihash, bytes)
  if (typeof cid === 'object' && 'version' in cid && 'multihash' in cid) {
    return cid as LexCid
  }
  throw new InvalidIdentifierError('invalid CID')
}

export function jsonToLex(val: Record<string, unknown>): unknown {
  return toIpld(val)
}

/**
 * Convert an IPLD value to a JSON-compatible value
 * @param val - The IPLD value to convert
 * @returns The JSON-compatible value
 */
function toIpld(val: unknown): unknown {
  if (val == null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(toIpld)
  if (isCidLink(val)) return parseCid(val.$link)
  if (val instanceof Uint8Array) return val
  if (typeof val === 'object' && '_isBuffer' in val && val._isBuffer) {
    return val as unknown as Uint8Array
  }

  const obj = val as Record<string, unknown>
  const keys = Object.keys(obj)

  if (keys.length === 1 && typeof obj['$link'] === 'string') {
    return parseCid(obj['$link'])
  }

  if (keys.length === 1 && typeof obj['$bytes'] === 'string') {
    return fromBytes({ $bytes: obj['$bytes'] })
  }

  const result: Record<string, unknown> = {}
  for (const key of keys) {
    result[key] = toIpld(obj[key])
  }
  return result
}

/**
 * Extracts the boundaries from a record.
 * @param record - The record to extract boundaries from.
 * @returns An array of strings representing the boundaries.
 */
export function extractBoundaries(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((d) => d.value)
    .filter((v): v is string => typeof v === 'string')
}
