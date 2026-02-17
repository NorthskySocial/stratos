/**
 * Service-side attestation utilities for producing signed record attestations.
 *
 * Used by the Stratos service to create and sign attestations at record write
 * time. These are included in sync.getRecord CAR responses.
 *
 * For client-side verification of attestation CARs, see client/verify.ts.
 */
import { sha256 } from 'multiformats/hashes/sha2'
import * as dagCbor from '@ipld/dag-cbor'

/**
 * Per-record signed attestation payload.
 * The service signs this at write time to attest that a record with the given
 * CID exists at the specified URI. Verifiers can check content integrity (CID)
 * and non-repudiation (signature) without a Merkle tree.
 */
export interface RecordAttestation {
  type: 'stratos-record-attestation'
  v: 1
  did: string
  collection: string
  rkey: string
  cid: string
  rev: string
  // dag-cbor codec identifier, so verifiers know the encoding
  codec: 'dag-cbor'
  sig?: Uint8Array
}

/**
 * Repo integrity chain checkpoint.
 * A rolling hash over all record mutations, signed by the service key.
 * Provides tamper evidence for the full mutation history.
 */
export interface RepoCheckpoint {
  type: 'stratos-repo-checkpoint'
  v: 1
  did: string
  rev: string
  prev: Uint8Array | null
  digest: Uint8Array
  sig?: Uint8Array
}

/**
 * Encode an attestation payload (without sig) for signing.
 */
export function encodeAttestationForSigning(
  did: string,
  collection: string,
  rkey: string,
  cid: string,
  rev: string,
): Uint8Array {
  const payload: Omit<RecordAttestation, 'sig'> = {
    type: 'stratos-record-attestation',
    v: 1,
    did,
    collection,
    rkey,
    cid,
    rev,
    codec: 'dag-cbor',
  }
  return dagCbor.encode(payload)
}

/**
 * Encode a full attestation (with sig) as a block for CAR inclusion.
 */
export function encodeAttestation(
  did: string,
  collection: string,
  rkey: string,
  cid: string,
  rev: string,
  sig: Uint8Array,
): Uint8Array {
  const payload: RecordAttestation = {
    type: 'stratos-record-attestation',
    v: 1,
    did,
    collection,
    rkey,
    cid,
    rev,
    codec: 'dag-cbor',
    sig,
  }
  return dagCbor.encode(payload)
}

const ZERO_DIGEST = new Uint8Array(32)

/**
 * Compute the next chain digest by hashing the previous digest concatenated
 * with the CBOR-encoded operation.
 */
export async function computeChainDigest(
  prevDigest: Uint8Array | null,
  operation: {
    action: 'create' | 'update' | 'delete'
    uri: string
    cid?: string
    rev: string
  },
): Promise<Uint8Array> {
  const opBytes = dagCbor.encode(operation)
  const prev = prevDigest ?? ZERO_DIGEST
  const combined = new Uint8Array(prev.length + opBytes.length)
  combined.set(prev, 0)
  combined.set(opBytes, prev.length)
  const hash = await sha256.digest(combined)
  return new Uint8Array(hash.digest)
}
