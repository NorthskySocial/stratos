/**
 * Unit tests for the space-credential minter (SWP-06).
 *
 * A space credential is a JWT the space authority signs with its own signing
 * key. These tests mint credentials with a local Secp256k1 keypair and verify
 * them by hand (decode header/payload + crypto.verifySignature) so we pin the
 * exact spec-shaped claim set — including the deliberate ABSENCE of `aud` — and
 * confirm the signature verifies against the signing key and ONLY that key.
 */
import { describe, expect, it } from 'vitest'
import { P256Keypair, Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import {
  ATPROTO_KID,
  SPACE_CREDENTIAL_TYP,
  mintSpaceCredential,
} from '../src/features/space-credential/minter.js'

const ISSUER_DID = 'did:web:stratos.test'
const SPACE_URI = `ats://${ISSUER_DID}/app.bsky.feed.generator/myspace`

interface DecodedJwt {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signingInput: string
  signatureBytes: Uint8Array
}

function decodeJwt(jwt: string): DecodedJwt {
  const parts = jwt.split('.')
  expect(parts).toHaveLength(3)
  return {
    header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
    payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
    signingInput: `${parts[0]}.${parts[1]}`,
    signatureBytes: new Uint8Array(Buffer.from(parts[2], 'base64url')),
  }
}

async function verifyAgainst(
  keyDid: string,
  decoded: DecodedJwt,
): Promise<boolean> {
  return verifySignature(
    keyDid,
    new TextEncoder().encode(decoded.signingInput),
    decoded.signatureBytes,
  )
}

describe('mintSpaceCredential', () => {
  it('mints a JWT with the exact spec-shaped header and claim set (no aud)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const iat = 1_700_000_000
    const { credential, exp, expiresAt, payload } = await mintSpaceCredential({
      signingKey,
      issuerDid: ISSUER_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
      iat,
      jti: 'nonce-1',
    })

    const decoded = decodeJwt(credential)

    // Header: typ / alg (ES256K for secp256k1) / kid = #atproto.
    expect(decoded.header).toEqual({
      typ: SPACE_CREDENTIAL_TYP,
      alg: 'ES256K',
      kid: ATPROTO_KID,
    })
    expect(SPACE_CREDENTIAL_TYP).toBe('atproto-space-credential+jwt')
    expect(ATPROTO_KID).toBe('#atproto')

    // Payload: iss / sub / iat / exp / jti — and crucially NO aud.
    expect(decoded.payload).toEqual({
      iss: ISSUER_DID,
      sub: SPACE_URI,
      iat,
      exp: iat + 7_200,
      jti: 'nonce-1',
    })
    expect('aud' in decoded.payload).toBe(false)

    // Returned metadata is consistent with the payload.
    expect(exp).toBe(iat + 7_200)
    expect(payload.exp).toBe(iat + 7_200)
    expect(expiresAt).toBe(new Date((iat + 7_200) * 1000).toISOString())
  })

  it('exp - iat equals the configured TTL', async () => {
    const signingKey = await Secp256k1Keypair.create()
    for (const ttl of [60, 3_600, 7_200, 86_400]) {
      const { payload } = await mintSpaceCredential({
        signingKey,
        issuerDid: ISSUER_DID,
        spaceUri: SPACE_URI,
        ttlSeconds: ttl,
      })
      expect(payload.exp - payload.iat).toBe(ttl)
    }
  })

  it('signature verifies against the signing key', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: ISSUER_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    const decoded = decodeJwt(credential)
    expect(await verifyAgainst(signingKey.did(), decoded)).toBe(true)
  })

  it('signature FAILS against a different key', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const otherKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: ISSUER_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    const decoded = decodeJwt(credential)
    expect(await verifyAgainst(otherKey.did(), decoded)).toBe(false)
    // Also fails against a different curve's key.
    const p256 = await P256Keypair.create()
    expect(await verifyAgainst(p256.did(), decoded)).toBe(false)
  })

  it('generates a unique jti when none is supplied', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const a = await mintSpaceCredential({
      signingKey,
      issuerDid: ISSUER_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    const b = await mintSpaceCredential({
      signingKey,
      issuerDid: ISSUER_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    expect(a.payload.jti).not.toBe(b.payload.jti)
    expect(typeof a.payload.jti).toBe('string')
    expect(a.payload.jti.length).toBeGreaterThan(0)
  })
})
