import { verifyRecord as atcuteVerifyRecord } from '@atcute/repo'
import { encode as cborEncode } from '@atcute/cbor'
import {
  create as cidCreate,
  toString as cidToString,
  CODEC_DCBOR,
} from '@atcute/cid'
import {
  getPublicKeyFromDidController,
  P256PublicKey,
  parseDidKey,
  type PublicKey,
  Secp256k1PublicKey,
} from '@atcute/crypto'
import { getAtprotoVerificationMaterial } from '@atcute/identity'
import { WebDidDocumentResolver } from '@atcute/identity-resolver'
import type {
  FetchAndVerifyOptions,
  ResolveSigningKeyOptions,
  VerificationLevel,
  VerifiedRecord,
} from './types.js'
import { getEnrollmentByServiceDid } from './discovery.js'

type DidString = `did:plc:${string}` | `did:web:${string}`

const verifyRecordCar = async (
  carBytes: Uint8Array,
  collection: string,
  rkey: string,
  did?: string,
  publicKey?: PublicKey,
  level?: VerificationLevel,
): Promise<VerifiedRecord> => {
  const result = await atcuteVerifyRecord({
    carBytes,
    collection,
    rkey,
    did: did as DidString | undefined,
    publicKey,
  })
  const resolvedLevel: VerificationLevel =
    level ?? (publicKey ? 'service-signature' : 'cid-integrity')
  return { cid: result.cid, record: result.record, level: resolvedLevel }
}

/**
 * verifies CID integrity and MST path for a record CAR without checking
 * the commit signature. proves data integrity but not provenance.
 *
 * @param carBytes the CAR file bytes containing the inclusion proof
 * @param collection the collection (NSID) the record belongs to
 * @param rkey the record key
 * @param did optional DID to verify against the commit's did field
 * @returns the verified record with its CID and verification level
 */
export const verifyCidIntegrity = async (
  carBytes: Uint8Array,
  collection: string,
  rkey: string,
  did?: string,
): Promise<VerifiedRecord> => {
  return verifyRecordCar(carBytes, collection, rkey, did)
}

/**
 * verifies that a record value matches its claimed CID by re-encoding the
 * value as DAG-CBOR and comparing hashes. accepts records in atproto JSON
 * interchange form ({$link} / {$bytes} wrappers are handled).
 *
 * this is the verification path for services that do not expose CAR
 * inclusion proofs — the Stratos service removed com.atproto.sync.getRecord,
 * so records fetched from it via com.atproto.repo.getRecord can only be
 * checked for CID integrity, not commit-signature provenance.
 *
 * @param value the record value as returned by com.atproto.repo.getRecord
 * @param expectedCid the CID claimed for the record
 * @returns the verified record with level 'cid-integrity'
 * @throws when the computed CID does not match the expected CID
 */
export const verifyRecordCid = async (
  value: unknown,
  expectedCid: string,
): Promise<VerifiedRecord> => {
  const bytes = cborEncode(value)
  const computed = cidToString(await cidCreate(CODEC_DCBOR, bytes))
  if (computed !== expectedCid) {
    throw new Error(
      `record CID mismatch: computed ${computed}, expected ${expectedCid}`,
    )
  }
  return { cid: computed, record: value, level: 'cid-integrity' }
}

/**
 * resolves the service's signing public key from its DID document.
 * uses WebDidDocumentResolver for validated DID document fetching and
 * getPublicKeyFromDidController for key type dispatch.
 *
 * pass a cache Map via options to memoize successful resolutions — the
 * key does not change unless the service rotates its signing key.
 *
 * @param serviceDid the service's did:web identifier
 * @param options optional configuration (fetch function, cache)
 * @returns the service's public signing key
 */
export const resolveServiceSigningKey = async (
  serviceDid: string,
  options?: ResolveSigningKeyOptions,
): Promise<PublicKey> => {
  const cached = options?.cache?.get(serviceDid)
  if (cached) return cached

  if (!serviceDid.startsWith('did:web:')) {
    throw new Error(`expected did:web, got: ${serviceDid}`)
  }

  const fetchFn = options?.fetchFn
  const resolver = new WebDidDocumentResolver(
    fetchFn ? { fetch: fetchFn } : undefined,
  )
  const doc = await resolver.resolve(serviceDid as `did:web:${string}`)

  const material = getAtprotoVerificationMaterial(doc)
  if (!material) {
    throw new Error('DID document has no #atproto verificationMethod')
  }

  const found = getPublicKeyFromDidController(material)

  let key: PublicKey
  switch (found.type) {
    case 'secp256k1':
      key = await Secp256k1PublicKey.importRaw(found.publicKeyBytes)
      break
    case 'p256':
      key = await P256PublicKey.importRaw(found.publicKeyBytes)
      break
  }

  options?.cache?.set(serviceDid, key)
  return key
}

/**
 * resolves a user's per-actor signing public key from their enrollment record
 * on their PDS. the enrollment record contains the did:key of the user's
 * signing key, which is decoded into the appropriate key type.
 *
 * callers should cache the returned key per (did, serviceDid) pair.
 *
 * @param pdsUrl the user's PDS service URL
 * @param did the user's DID
 * @param serviceDid the Stratos service's DID to find the enrollment for
 * @returns the user's public signing key, or null if no enrollment found
 */
export const resolveUserSigningKey = async (
  pdsUrl: string,
  did: string,
  serviceDid: string,
): Promise<PublicKey | null> => {
  const enrollment = await getEnrollmentByServiceDid(did, pdsUrl, serviceDid)
  if (!enrollment?.signingKey) return null

  const didKey = enrollment.signingKey
  if (!didKey.startsWith('did:key:')) {
    throw new Error(`invalid signing key format: ${didKey}`)
  }

  const found = parseDidKey(didKey)

  switch (found.type) {
    case 'secp256k1':
      return Secp256k1PublicKey.importRaw(found.publicKeyBytes)
    case 'p256':
      return P256PublicKey.importRaw(found.publicKeyBytes)
  }
}

/**
 * fetches a record with its inclusion proof via com.atproto.sync.getRecord
 * and verifies it. verification priority:
 * 1. userSigningKey — verifies the user's per-actor commit signature ('user-signature')
 * 2. serviceSigningKey — verifies the service's commit signature ('service-signature')
 * 3. neither — CID integrity and MST path validation only ('cid-integrity')
 *
 * note: the Stratos service no longer implements com.atproto.sync.getRecord
 * (removed with private image support, #84). this helper works against
 * standard PDSes and any service exposing CAR inclusion proofs; for records
 * fetched from a Stratos service, use verifyRecordCid instead.
 *
 * @param serviceUrl the service base URL
 * @param did the repo DID
 * @param collection the collection NSID
 * @param rkey the record key
 * @param options optional verification options
 * @returns the verified record
 */
export const fetchAndVerifyRecord = async (
  serviceUrl: string,
  did: string,
  collection: string,
  rkey: string,
  options?: FetchAndVerifyOptions,
): Promise<VerifiedRecord> => {
  const fetchFn = options?.fetchFn ?? fetch

  const params = new URLSearchParams({ did, collection, rkey })
  const url = new URL(`/xrpc/com.atproto.sync.getRecord?${params}`, serviceUrl)

  const res = await fetchFn(url.href)
  if (!res.ok) {
    throw new Error(
      `failed to fetch record proof: ${res.status} ${res.statusText}`,
    )
  }

  const carBytes = new Uint8Array(await res.arrayBuffer())

  if (options?.userSigningKey) {
    return verifyRecordCar(
      carBytes,
      collection,
      rkey,
      did,
      options.userSigningKey,
      'user-signature',
    )
  }

  return verifyRecordCar(
    carBytes,
    collection,
    rkey,
    did,
    options?.serviceSigningKey,
  )
}

/** module-level signing key cache used by verifyStratosRecord. */
const defaultSigningKeyCache = new Map<string, PublicKey>()

/**
 * verifies a Stratos record CAR with signature verification when possible,
 * falling back to CID integrity when the service signing key cannot be
 * resolved. service keys are cached across calls.
 *
 * note: obtain the CAR from a source that serves inclusion proofs (a PDS's
 * com.atproto.sync.getRecord, or an owner-scoped zone.stratos.sync.getRepo
 * export). the Stratos service does not serve per-record proofs; use
 * verifyRecordCid for records fetched from it via com.atproto.repo.getRecord.
 *
 * @param carBytes the CAR file bytes containing the inclusion proof
 * @param did the repo DID
 * @param collection the collection NSID
 * @param rkey the record key
 * @param serviceDid the service's did:web identifier, if known
 * @returns the verified record with its CID and verification level
 */
export const verifyStratosRecord = async (
  carBytes: Uint8Array,
  did: string,
  collection: string,
  rkey: string,
  serviceDid?: string,
): Promise<VerifiedRecord> => {
  let signingKey: PublicKey | undefined
  if (serviceDid) {
    try {
      signingKey = await resolveServiceSigningKey(serviceDid, {
        cache: defaultSigningKeyCache,
      })
    } catch {
      // key resolution failed — fall through to CID-only verification
    }
  }

  return verifyRecordCar(
    carBytes,
    collection,
    rkey,
    did,
    signingKey,
    signingKey ? 'service-signature' : 'cid-integrity',
  )
}
