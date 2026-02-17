/**
 * Client-facing verification utilities for Stratos record attestations.
 *
 * This module is part of the public stratos-core API, intended for use by
 * client applications (e.g., pdsls, AppViews) that need to verify records
 * returned by a Stratos service via com.atproto.sync.getRecord.
 *
 * Not used by the Stratos service itself — the service produces attestations
 * via the repo/attestation module. This module consumes and verifies them.
 */
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as dagCbor from '@ipld/dag-cbor'
import type { RecordAttestation } from '../repo/attestation.js'

export interface VerifyStratosRecordOptions {
  did: string
  collection: string
  rkey: string
  carBytes: Uint8Array
}

export interface VerifiedStratosRecord {
  cid: string
  record: unknown
}

interface CarBlock {
  cid: CID
  bytes: Uint8Array
}

/**
 * Parse a CAR v1 file into its root CIDs and blocks.
 * Minimal parser that handles the subset needed for attestation CARs.
 */
function parseCar(car: Uint8Array): { roots: CID[]; blocks: CarBlock[] } {
  let offset = 0

  const readVarint = (): number => {
    let value = 0
    let shift = 0
    while (true) {
      const byte = car[offset++]
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
    }
    return value
  }

  // Read header
  const headerLen = readVarint()
  const headerBytes = car.slice(offset, offset + headerLen)
  offset += headerLen
  const header = dagCbor.decode(headerBytes) as {
    version: number
    roots: CID[]
  }

  if (header.version !== 1) {
    throw new Error(`unsupported CAR version: ${header.version}`)
  }

  const roots = header.roots

  // Read blocks
  const blocks: CarBlock[] = []
  while (offset < car.length) {
    const blockLen = readVarint()
    const blockStart = offset
    const blockData = car.subarray(blockStart, blockStart + blockLen)
    const [cid, remainder] = CID.decodeFirst(blockData)
    const bytes = remainder
    offset = blockStart + blockLen
    blocks.push({ cid, bytes })
  }

  return { roots, blocks }
}

/**
 * Checks if CAR bytes contain a Stratos record attestation as root.
 *
 * @param carBytes raw CAR v1 bytes from com.atproto.sync.getRecord
 * @returns true if the root block is a stratos-record-attestation
 */
export function isStratosAttestation(carBytes: Uint8Array): boolean {
  try {
    const { roots, blocks } = parseCar(carBytes)
    if (roots.length !== 1) return false

    const rootCidStr = roots[0].toString()
    const rootBlock = blocks.find((b) => b.cid.toString() === rootCidStr)
    if (!rootBlock) return false

    const decoded = dagCbor.decode(rootBlock.bytes)
    return (
      decoded !== null &&
      typeof decoded === 'object' &&
      (decoded as Record<string, unknown>).type === 'stratos-record-attestation'
    )
  } catch {
    return false
  }
}

/**
 * Verifies a Stratos record attestation CAR.
 *
 * Checks performed:
 * - CAR has exactly 1 root (the attestation block)
 * - all block CIDs match their content hashes (integrity)
 * - attestation references the correct did, collection, rkey
 * - record block referenced by attestation.cid exists in CAR
 *
 * Does NOT verify the attestation signature — callers that need non-repudiation
 * should extract attestation.sig and verify against the service's public key
 * using @atproto/crypto.verifySignature or equivalent.
 *
 * @param options verification parameters including the CAR bytes
 * @returns the verified record CID and decoded record value
 * @throws if any integrity or consistency check fails
 */
export async function verifyStratosRecord(
  options: VerifyStratosRecordOptions,
): Promise<VerifiedStratosRecord> {
  const { did, collection, rkey, carBytes } = options

  const { roots, blocks } = parseCar(carBytes)
  if (roots.length !== 1) {
    throw new Error(`expected 1 CAR root, got ${roots.length}`)
  }

  const rootCidStr = roots[0].toString()

  // Verify all block CIDs match their content
  const blockMap = new Map<string, Uint8Array>()
  for (const block of blocks) {
    const expectedCodec = block.cid.code
    const hash = await sha256.digest(block.bytes)
    const computed = CID.createV1(expectedCodec, hash)

    if (!rootCidStr && computed.toString() !== block.cid.toString()) {
      throw new Error(`CID integrity check failed for ${block.cid.toString()}`)
    }
    if (computed.toString() !== block.cid.toString()) {
      throw new Error(`CID integrity check failed for ${block.cid.toString()}`)
    }
    blockMap.set(block.cid.toString(), block.bytes)
  }

  const rootBytes = blockMap.get(rootCidStr)
  if (!rootBytes) {
    throw new Error('root block not found in CAR')
  }

  const attestation = dagCbor.decode(rootBytes) as Record<string, unknown>
  if (attestation?.type !== 'stratos-record-attestation') {
    throw new Error(`unexpected root type: ${String(attestation?.type)}`)
  }

  if (attestation.did !== did) {
    throw new Error(`attestation DID mismatch: expected ${did}`)
  }
  if (attestation.collection !== collection) {
    throw new Error(`attestation collection mismatch: expected ${collection}`)
  }
  if (attestation.rkey !== rkey) {
    throw new Error(`attestation rkey mismatch: expected ${rkey}`)
  }

  const recordCid = attestation.cid as string
  const recordBytes = blockMap.get(recordCid)
  if (!recordBytes) {
    throw new Error('record block referenced by attestation not found in CAR')
  }

  const record = dagCbor.decode(recordBytes) as unknown

  return { cid: recordCid, record }
}

/**
 * Extract the raw attestation payload from a Stratos attestation CAR.
 * Useful when callers want to verify the signature themselves.
 *
 * @param carBytes raw CAR v1 bytes
 * @returns the decoded attestation object, or null if not a Stratos attestation
 */
export function extractAttestation(
  carBytes: Uint8Array,
): RecordAttestation | null {
  try {
    const { roots, blocks } = parseCar(carBytes)
    if (roots.length !== 1) return null

    const rootCidStr = roots[0].toString()
    const rootBlock = blocks.find((b) => b.cid.toString() === rootCidStr)
    if (!rootBlock) return null

    const decoded = dagCbor.decode(rootBlock.bytes) as Record<string, unknown>
    if (decoded?.type !== 'stratos-record-attestation') return null

    return decoded as unknown as RecordAttestation
  } catch {
    return null
  }
}
