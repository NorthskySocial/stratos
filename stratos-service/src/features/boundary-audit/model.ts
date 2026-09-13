import { createHash } from 'node:crypto'
import { encode } from '@atcute/cbor'
import { verifySignature } from '@atproto/crypto'
import type { EnrollmentStoreWriter } from '@northskysocial/stratos-core'

export interface BoundaryState {
  enrolled: boolean
  active: boolean
  boundaries: string[]
}

export interface BoundaryOperation {
  $type: 'zone.stratos.boundary.operation'
  authority: string
  did: string
  sequence: number
  previousHash: string
  recordedAt: string
  signingKey: string
  before: BoundaryState
  after: BoundaryState
}

export interface SignedBoundaryOperation {
  operation: BoundaryOperation
  hash: string
  signature: string
}

export interface BoundaryCheckpoint {
  $type: 'zone.stratos.boundary.checkpoint'
  authority: string
  did: string
  sequence: number
  headHash: string
  recordedAt: string
  signingKey: string
  state: BoundaryState
}

export interface SignedBoundaryCheckpoint {
  checkpoint: BoundaryCheckpoint
  signature: string
  cursor: string
}

export interface BoundaryAuthoritySigner {
  publicKey: string
  sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

export class BoundaryHistoryTruncatedError extends Error {
  constructor() {
    super(
      'Boundary history cannot prove this cursor; recover a signed checkpoint',
    )
  }
}

export async function readBoundaryState(
  store: EnrollmentStoreWriter,
  did: string,
): Promise<BoundaryState> {
  const enrollment = await store.getEnrollment(did)
  return {
    enrolled: enrollment !== null,
    active: enrollment?.active ?? false,
    boundaries: [...new Set(await store.getBoundaries(did))].sort(),
  }
}

export function boundaryPayload(
  payload: BoundaryOperation | BoundaryCheckpoint,
): Uint8Array {
  return encode(payload)
}

export function boundaryHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function verifyBoundaryOperation(
  signed: SignedBoundaryOperation,
): Promise<boolean> {
  try {
    const bytes = boundaryPayload(signed.operation)
    return (
      signed.hash === boundaryHash(bytes) &&
      (await verifySignature(
        signed.operation.signingKey,
        bytes,
        Buffer.from(signed.signature, 'base64'),
      ))
    )
  } catch {
    return false
  }
}

export function encodeBoundaryCursor(
  did: string,
  sequence: number,
  hash: string,
): string {
  return Buffer.from(JSON.stringify([did, sequence, hash])).toString(
    'base64url',
  )
}

export function decodeBoundaryCursor(
  did: string,
  cursor?: string,
): { sequence: number; hash: string } {
  if (cursor === undefined) return { sequence: 0, hash: '' }
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    )
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== did ||
      !Number.isSafeInteger(value[1]) ||
      value[1] < 0 ||
      typeof value[2] !== 'string' ||
      (value[1] === 0 ? value[2] !== '' : !/^[a-f0-9]{64}$/.test(value[2]))
    ) {
      throw new BoundaryHistoryTruncatedError()
    }
    return { sequence: value[1], hash: value[2] }
  } catch {
    throw new BoundaryHistoryTruncatedError()
  }
}
