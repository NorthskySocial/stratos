/**
 * The credential the service minter makes for fixed inputs under a frozen
 * clock is stable to the byte. The cross-check fixture hands this token to the
 * upstream package's verifier, and the fixture test reads the constant below,
 * so the token and the fixture cannot drift apart unseen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { mintSpaceHttpCredential } from '../src/features/space-credential/minter.js'

const AUTHORITY_DID = 'did:web:bebop.example'
const SPACE_URI = `at:space/${AUTHORITY_DID}/zone.stratos.space.feed/crew`
const AUTHORITY_SIGNING_KEY_HEX =
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const HOLDER_KEY_HEX =
  '5555555555555555555555555555555555555555555555555555555555555555'
const FROZEN_CLOCK_SECONDS = 1_000_000_000
const LIFETIME_SECONDS = 600
const CREDENTIAL_ID = 'spike-spiegel-credential'
const FIXED_CREDENTIAL =
  'eyJ0eXAiOiJhdHByb3RvLXNwYWNlLWNyZWRlbnRpYWwrand0IiwiYWxnIjoiRVMyNTZLIiwia2lkIjoiI2F0cHJvdG8ifQ.eyJpc3MiOiJkaWQ6d2ViOmJlYm9wLmV4YW1wbGUiLCJzdWIiOiJhdDpzcGFjZS9kaWQ6d2ViOmJlYm9wLmV4YW1wbGUvem9uZS5zdHJhdG9zLnNwYWNlLmZlZWQvY3JldyIsImlhdCI6MTAwMDAwMDAwMCwiZXhwIjoxMDAwMDAwNjAwLCJqdGkiOiJzcGlrZS1zcGllZ2VsLWNyZWRlbnRpYWwiLCJjbmYiOnsia2lkIjoiZGlkOmtleTp6RG5hZVdNOHptQml3emY4bjQydk1DUGRYQVdQdnQ4VDEzWFFNQlhabVpvTEIzZkNGIn0sInN0cmF0b3NCb3VuZGFyeVJldmlzaW9uIjoxfQ.LPYdky2qhc7JLfDnxcEJH9NdXh-kcpvEk-4mk_WC1rp8P1oexCV-rW3iqDhugUXP1tFLJnnNQDA_bfVaZKl2xQ'

const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))

describe('the credential minted for fixed inputs', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is byte for byte the pinned token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FROZEN_CLOCK_SECONDS * 1000)
    const signingKey = await Secp256k1Keypair.import(
      fromHex(AUTHORITY_SIGNING_KEY_HEX),
    )
    const holder = await P256Keypair.import(fromHex(HOLDER_KEY_HEX))

    const { credential, payload } = await mintSpaceHttpCredential({
      signingKey,
      issuerDid: AUTHORITY_DID,
      spaceUri: SPACE_URI,
      keyId: holder.did(),
      ttlSeconds: LIFETIME_SECONDS,
      boundaryRevision: 1,
      jti: CREDENTIAL_ID,
    })

    expect(payload.iat).toBe(FROZEN_CLOCK_SECONDS)
    expect(credential).toBe(FIXED_CREDENTIAL)
  })
})
