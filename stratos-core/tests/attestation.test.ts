import { describe, it, expect } from 'vitest'
import * as dagCbor from '@ipld/dag-cbor'
import {
  encodeAttestationForSigning,
  encodeAttestation,
  computeChainDigest,
} from '../src/repo/attestation.js'
import type { RecordAttestation } from '../src/repo/attestation.js'

describe('attestation', () => {
  const did = 'did:plc:testuser'
  const collection = 'app.stratos.feed.post'
  const rkey = 'abc123'
  const cid = 'bafyreia2vlm5wqm3sio5qiackpjxbgvysshf2x6bwmmhbdru7k7mjqpwq'
  const rev = '3lhx5g5iqss2k'

  describe('encodeAttestationForSigning', () => {
    it('should produce deterministic output', () => {
      const a = encodeAttestationForSigning(did, collection, rkey, cid, rev)
      const b = encodeAttestationForSigning(did, collection, rkey, cid, rev)
      expect(a).toEqual(b)
    })

    it('should encode all fields except sig', () => {
      const bytes = encodeAttestationForSigning(did, collection, rkey, cid, rev)
      const decoded = dagCbor.decode(bytes) as Omit<RecordAttestation, 'sig'>

      expect(decoded.type).toBe('stratos-record-attestation')
      expect(decoded.v).toBe(1)
      expect(decoded.did).toBe(did)
      expect(decoded.collection).toBe(collection)
      expect(decoded.rkey).toBe(rkey)
      expect(decoded.cid).toBe(cid)
      expect(decoded.rev).toBe(rev)
      expect(decoded.codec).toBe('dag-cbor')
      expect((decoded as Record<string, unknown>).sig).toBeUndefined()
    })

    it('should change output when any field changes', () => {
      const base = encodeAttestationForSigning(did, collection, rkey, cid, rev)
      const diffDid = encodeAttestationForSigning(
        'did:plc:other',
        collection,
        rkey,
        cid,
        rev,
      )
      const diffColl = encodeAttestationForSigning(
        did,
        'app.stratos.other',
        rkey,
        cid,
        rev,
      )
      const diffRkey = encodeAttestationForSigning(
        did,
        collection,
        'xyz',
        cid,
        rev,
      )
      const diffCid = encodeAttestationForSigning(
        did,
        collection,
        rkey,
        'bafyother',
        rev,
      )
      const diffRev = encodeAttestationForSigning(
        did,
        collection,
        rkey,
        cid,
        'otherrev',
      )

      expect(base).not.toEqual(diffDid)
      expect(base).not.toEqual(diffColl)
      expect(base).not.toEqual(diffRkey)
      expect(base).not.toEqual(diffCid)
      expect(base).not.toEqual(diffRev)
    })
  })

  describe('encodeAttestation', () => {
    it('should include sig bytes in the encoded block', () => {
      const sig = new Uint8Array(64).fill(0xab)
      const bytes = encodeAttestation(did, collection, rkey, cid, rev, sig)
      const decoded = dagCbor.decode(bytes) as RecordAttestation

      expect(decoded.type).toBe('stratos-record-attestation')
      expect(decoded.v).toBe(1)
      expect(decoded.did).toBe(did)
      expect(decoded.collection).toBe(collection)
      expect(decoded.rkey).toBe(rkey)
      expect(decoded.cid).toBe(cid)
      expect(decoded.rev).toBe(rev)
      expect(decoded.codec).toBe('dag-cbor')
      expect(new Uint8Array(decoded.sig!)).toEqual(sig)
    })

    it('should produce valid dag-cbor', () => {
      const sig = new Uint8Array(64).fill(0x42)
      const bytes = encodeAttestation(did, collection, rkey, cid, rev, sig)

      // Re-encoding the decoded value should produce the same bytes (determinism)
      const decoded = dagCbor.decode(bytes)
      const reEncoded = dagCbor.encode(decoded)
      expect(new Uint8Array(reEncoded)).toEqual(new Uint8Array(bytes))
    })
  })

  describe('computeChainDigest', () => {
    it('should produce 32-byte SHA-256 digest', async () => {
      const digest = await computeChainDigest(null, {
        action: 'create',
        uri: `at://${did}/${collection}/${rkey}`,
        cid,
        rev,
      })
      expect(digest).toBeInstanceOf(Uint8Array)
      expect(digest.length).toBe(32)
    })

    it('should be deterministic', async () => {
      const op = {
        action: 'create' as const,
        uri: `at://${did}/${collection}/${rkey}`,
        cid,
        rev,
      }
      const a = await computeChainDigest(null, op)
      const b = await computeChainDigest(null, op)
      expect(a).toEqual(b)
    })

    it('should use zero digest when prev is null', async () => {
      const op = {
        action: 'create' as const,
        uri: `at://${did}/${collection}/${rkey}`,
        cid,
        rev,
      }
      const fromNull = await computeChainDigest(null, op)
      const fromZero = await computeChainDigest(new Uint8Array(32), op)
      expect(fromNull).toEqual(fromZero)
    })

    it('should chain operations sequentially', async () => {
      const op1 = {
        action: 'create' as const,
        uri: `at://${did}/${collection}/rec1`,
        cid,
        rev: 'rev1',
      }
      const op2 = {
        action: 'create' as const,
        uri: `at://${did}/${collection}/rec2`,
        cid,
        rev: 'rev2',
      }

      const digest1 = await computeChainDigest(null, op1)
      const digest2 = await computeChainDigest(digest1, op2)

      // Different from first digest
      expect(digest2).not.toEqual(digest1)

      // Different from computing op2 without chaining
      const unchained = await computeChainDigest(null, op2)
      expect(digest2).not.toEqual(unchained)
    })

    it('should produce different digests for different actions', async () => {
      const uri = `at://${did}/${collection}/${rkey}`
      const create = await computeChainDigest(null, {
        action: 'create',
        uri,
        cid,
        rev,
      })
      const update = await computeChainDigest(null, {
        action: 'update',
        uri,
        cid,
        rev,
      })
      const del = await computeChainDigest(null, { action: 'delete', uri, rev })

      expect(create).not.toEqual(update)
      expect(create).not.toEqual(del)
      expect(update).not.toEqual(del)
    })
  })
})
