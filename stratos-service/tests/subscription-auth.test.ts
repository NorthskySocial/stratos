/**
 * Tests for zone.stratos.sync.subscribeRecords authentication.
 *
 * The syncToken parameter carries a service JWT that AppViews use to
 * authenticate. This tests the verifyServiceAuth function that validates
 * those tokens, covering the acceptance and rejection paths an AppView
 * indexer will encounter — including the expiry case that triggers on
 * reconnect when a stale token is reused.
 */
import { describe, it, expect, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import type { IdResolver } from '@atproto/identity'
import { verifyServiceAuth } from '../src/auth/index.js'

const OUR_DID = 'did:web:stratos.test'
const LXM = 'zone.stratos.sync.subscribeRecords'

/**
 * Build a minimal mock IdResolver that returns a DID document containing
 * the given keypair's verification method.
 */
function createMockIdResolver(keypair: Secp256k1Keypair): IdResolver {
  // Use Multikey type so getDidKeyFromMultibase routes through parseMultikey,
  // which correctly handles the multicodec-prefixed encoding that did:key: uses.
  const publicKeyMultibase = keypair.did().slice('did:key:'.length)
  return {
    did: {
      resolve: vi.fn().mockResolvedValue({
        id: keypair.did(),
        verificationMethod: [
          {
            id: `${keypair.did()}#key`,
            type: 'Multikey',
            controller: keypair.did(),
            publicKeyMultibase,
          },
        ],
      }),
    },
  } as unknown as IdResolver
}

describe('verifyServiceAuth (syncToken validation)', () => {
  it('accepts a valid service JWT', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(keypair)

    const token = await createServiceJwt({
      iss: keypair.did(),
      aud: OUR_DID,
      lxm: LXM,
      keypair,
    })

    const result = await verifyServiceAuth(
      `Bearer ${token}`,
      OUR_DID,
      LXM,
      idResolver,
    )

    expect(result.iss).toBe(keypair.did())
    expect(result.aud).toBe(OUR_DID)
  })

  it('rejects an expired token', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(keypair)

    const token = await createServiceJwt({
      iss: keypair.did(),
      aud: OUR_DID,
      lxm: LXM,
      keypair,
      exp: Math.floor(Date.now() / 1000) - 60,
    })

    await expect(
      verifyServiceAuth(`Bearer ${token}`, OUR_DID, LXM, idResolver),
    ).rejects.toThrow('Token expired')
  })

  it('rejects a token with the wrong audience', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(keypair)

    const token = await createServiceJwt({
      iss: keypair.did(),
      aud: 'did:web:wrong.service',
      lxm: LXM,
      keypair,
    })

    await expect(
      verifyServiceAuth(`Bearer ${token}`, OUR_DID, LXM, idResolver),
    ).rejects.toThrow('Invalid aud claim')
  })

  it('rejects a token with a mismatched lxm', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(keypair)

    const token = await createServiceJwt({
      iss: keypair.did(),
      aud: OUR_DID,
      lxm: 'zone.stratos.sync.otherEndpoint',
      keypair,
    })

    await expect(
      verifyServiceAuth(`Bearer ${token}`, OUR_DID, LXM, idResolver),
    ).rejects.toThrow('Invalid lxm claim')
  })

  it('rejects a token signed by a different key than the one in the DID document', async () => {
    const resolvedKeypair = await Secp256k1Keypair.create({ exportable: true })
    const signingKeypair = await Secp256k1Keypair.create({ exportable: true })

    // Resolver returns resolvedKeypair's public key, but token is signed by signingKeypair
    const idResolver = createMockIdResolver(resolvedKeypair)

    const token = await createServiceJwt({
      iss: resolvedKeypair.did(),
      aud: OUR_DID,
      lxm: LXM,
      keypair: signingKeypair,
    })

    await expect(
      verifyServiceAuth(`Bearer ${token}`, OUR_DID, LXM, idResolver),
    ).rejects.toThrow('Invalid signature')
  })

  it('rejects a malformed authorization header', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(keypair)

    await expect(
      verifyServiceAuth('notabearer token', OUR_DID, LXM, idResolver),
    ).rejects.toThrow('Invalid authorization header format')
  })

  it('rejects a non-JWT token', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(keypair)

    await expect(
      verifyServiceAuth('Bearer notajwtatall', OUR_DID, LXM, idResolver),
    ).rejects.toThrow('Invalid JWT format')
  })

  describe('reconnect token expiry', () => {
    it('a fresh token issued on reconnect is accepted after the prior token expires', async () => {
      const keypair = await Secp256k1Keypair.create({ exportable: true })
      const idResolver = createMockIdResolver(keypair)

      const expiredToken = await createServiceJwt({
        iss: keypair.did(),
        aud: OUR_DID,
        lxm: LXM,
        keypair,
        exp: Math.floor(Date.now() / 1000) - 1,
      })

      // Stale token from the previous connection is rejected
      await expect(
        verifyServiceAuth(`Bearer ${expiredToken}`, OUR_DID, LXM, idResolver),
      ).rejects.toThrow('Token expired')

      // Re-minting on reconnect produces a valid token
      const freshToken = await createServiceJwt({
        iss: keypair.did(),
        aud: OUR_DID,
        lxm: LXM,
        keypair,
      })

      const result = await verifyServiceAuth(
        `Bearer ${freshToken}`,
        OUR_DID,
        LXM,
        idResolver,
      )
      expect(result.iss).toBe(keypair.did())
    })
  })
})
