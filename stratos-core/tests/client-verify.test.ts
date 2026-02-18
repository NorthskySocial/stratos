/**
 * Tests for the client-facing verification module.
 * Verifies that isStratosAttestation, verifyStratosRecord, and extractAttestation
 * correctly parse and validate attestation CARs produced by the service.
 */
import { describe, it, expect } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as dagCbor from '@ipld/dag-cbor'
import {
  isStratosAttestation,
  verifyStratosRecord,
  extractAttestation,
} from '../src/client/verify.js'
import { encodeAttestation } from '../src/repo/attestation.js'

const DAG_CBOR_CODEC = 0x71

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = []
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80)
    value >>>= 7
  }
  bytes.push(value & 0x7f)
  return new Uint8Array(bytes)
}

async function buildAttestationCar(opts: {
  did: string
  collection: string
  rkey: string
  record: Record<string, unknown>
  sig?: Uint8Array
}): Promise<{ car: Uint8Array; recordCid: CID; attestationCid: CID }> {
  const { did, collection, rkey, record, sig = new Uint8Array(64) } = opts

  const recordBytes = dagCbor.encode(record)
  const recordHash = await sha256.digest(recordBytes)
  const recordCid = CID.createV1(DAG_CBOR_CODEC, recordHash)

  const attestationBytes = encodeAttestation(
    did,
    collection,
    rkey,
    recordCid.toString(),
    'rev1',
    sig,
  )
  const attestationHash = await sha256.digest(attestationBytes)
  const attestationCid = CID.createV1(DAG_CBOR_CODEC, attestationHash)

  const header = dagCbor.encode({ version: 1, roots: [attestationCid] })
  const headerVarInt = encodeVarint(header.length)

  const attCidBytes = attestationCid.bytes
  const attBlockVarInt = encodeVarint(
    attCidBytes.length + attestationBytes.length,
  )
  const recCidBytes = recordCid.bytes
  const recBlockVarInt = encodeVarint(recCidBytes.length + recordBytes.length)

  const carLength =
    headerVarInt.length +
    header.length +
    attBlockVarInt.length +
    attCidBytes.length +
    attestationBytes.length +
    recBlockVarInt.length +
    recCidBytes.length +
    recordBytes.length

  const car = new Uint8Array(carLength)
  let offset = 0
  car.set(headerVarInt, offset)
  offset += headerVarInt.length
  car.set(header, offset)
  offset += header.length
  car.set(attBlockVarInt, offset)
  offset += attBlockVarInt.length
  car.set(attCidBytes, offset)
  offset += attCidBytes.length
  car.set(attestationBytes, offset)
  offset += attestationBytes.length
  car.set(recBlockVarInt, offset)
  offset += recBlockVarInt.length
  car.set(recCidBytes, offset)
  offset += recCidBytes.length
  car.set(recordBytes, offset)

  return { car, recordCid, attestationCid }
}

async function buildPlainCar(
  record: Record<string, unknown>,
): Promise<Uint8Array> {
  const recordBytes = dagCbor.encode(record)
  const recordHash = await sha256.digest(recordBytes)
  const recordCid = CID.createV1(DAG_CBOR_CODEC, recordHash)

  const header = dagCbor.encode({ version: 1, roots: [recordCid] })
  const headerVarInt = encodeVarint(header.length)
  const cidBytes = recordCid.bytes
  const blockVarInt = encodeVarint(cidBytes.length + recordBytes.length)

  const carLength =
    headerVarInt.length +
    header.length +
    blockVarInt.length +
    cidBytes.length +
    recordBytes.length

  const car = new Uint8Array(carLength)
  let offset = 0
  car.set(headerVarInt, offset)
  offset += headerVarInt.length
  car.set(header, offset)
  offset += header.length
  car.set(blockVarInt, offset)
  offset += blockVarInt.length
  car.set(cidBytes, offset)
  offset += cidBytes.length
  car.set(recordBytes, offset)

  return car
}

describe('client/verify', () => {
  const did = 'did:plc:testverify'
  const collection = 'app.stratos.feed.post'
  const rkey = 'rec1'
  const record = { text: 'hello world', createdAt: '2025-01-01T00:00:00Z' }

  describe('isStratosAttestation', () => {
    it('should return true for an attestation CAR', async () => {
      const { car } = await buildAttestationCar({
        did,
        collection,
        rkey,
        record,
      })
      expect(isStratosAttestation(car)).toBe(true)
    })

    it('should return false for a plain record CAR', async () => {
      const car = await buildPlainCar(record)
      expect(isStratosAttestation(car)).toBe(false)
    })

    it('should return false for garbage bytes', () => {
      expect(isStratosAttestation(new Uint8Array([0, 1, 2, 3]))).toBe(false)
    })

    it('should return false for empty bytes', () => {
      expect(isStratosAttestation(new Uint8Array(0))).toBe(false)
    })
  })

  describe('verifyStratosRecord', () => {
    it('should verify a valid attestation CAR', async () => {
      const { car, recordCid } = await buildAttestationCar({
        did,
        collection,
        rkey,
        record,
      })

      const result = await verifyStratosRecord({
        did,
        collection,
        rkey,
        carBytes: car,
      })

      expect(result.cid).toBe(recordCid.toString())
      expect(result.record).toEqual(record)
    })

    it('should reject DID mismatch', async () => {
      const { car } = await buildAttestationCar({
        did,
        collection,
        rkey,
        record,
      })

      await expect(
        verifyStratosRecord({
          did: 'did:plc:wrong',
          collection,
          rkey,
          carBytes: car,
        }),
      ).rejects.toThrow('attestation DID mismatch')
    })

    it('should reject collection mismatch', async () => {
      const { car } = await buildAttestationCar({
        did,
        collection,
        rkey,
        record,
      })

      await expect(
        verifyStratosRecord({
          did,
          collection: 'wrong.collection',
          rkey,
          carBytes: car,
        }),
      ).rejects.toThrow('attestation collection mismatch')
    })

    it('should reject rkey mismatch', async () => {
      const { car } = await buildAttestationCar({
        did,
        collection,
        rkey,
        record,
      })

      await expect(
        verifyStratosRecord({
          did,
          collection,
          rkey: 'wrongrkey',
          carBytes: car,
        }),
      ).rejects.toThrow('attestation rkey mismatch')
    })

    it('should detect tampered block bytes', async () => {
      const { car } = await buildAttestationCar({
        did,
        collection,
        rkey,
        record,
      })

      // Flip a byte near the end (in the record block)
      const tampered = new Uint8Array(car)
      tampered[tampered.length - 5] ^= 0xff

      await expect(
        verifyStratosRecord({
          did,
          collection,
          rkey,
          carBytes: tampered,
        }),
      ).rejects.toThrow()
    })
  })

  describe('extractAttestation', () => {
    it('should extract attestation from valid CAR', async () => {
      const sig = new Uint8Array(64).fill(0x42)
      const { car } = await buildAttestationCar({
        did,
        collection,
        rkey,
        record,
        sig,
      })

      const attestation = extractAttestation(car)
      expect(attestation).not.toBeNull()
      expect(attestation!.type).toBe('stratos-record-attestation')
      expect(attestation!.v).toBe(1)
      expect(attestation!.did).toBe(did)
      expect(attestation!.collection).toBe(collection)
      expect(attestation!.rkey).toBe(rkey)
      expect(attestation!.codec).toBe('dag-cbor')
    })

    it('should return null for plain record CAR', async () => {
      const car = await buildPlainCar(record)
      expect(extractAttestation(car)).toBeNull()
    })

    it('should return null for garbage', () => {
      expect(extractAttestation(new Uint8Array([0, 1, 2]))).toBeNull()
    })
  })
})
