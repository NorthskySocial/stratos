/**
 * Unit tests for the space-credential verifier.
 *
 * A space credential is a JWT this service mints and later re-accepts on its
 * read/sync surface. Verification happens against OUR OWN signing key (no DID
 * resolution). These tests mint real credentials with a local Secp256k1 keypair
 * and assert the verifier accepts a good one and rejects each distinct failure
 * mode with a distinct typed error — including that it is deliberately
 * MULTI-USE (no `jti` consumption).
 */
import { describe, expect, it } from 'vitest'
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import { mintSpaceCredential } from '../src/features/space-credential/minter.js'
import {
  ForeignSpaceCredentialError,
  InvalidSpaceCredentialAlgError,
  InvalidSpaceCredentialKidError,
  InvalidSpaceCredentialSignatureError,
  InvalidSpaceCredentialSubError,
  InvalidSpaceCredentialTypError,
  MalformedSpaceCredentialError,
  SpaceCredentialExpiredError,
  verifySpaceCredential,
} from '../src/infra/auth/space-credential-verifier.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const SPACE_URI = makeSpaceUri(
  SERVICE_DID,
  'app.bsky.feed.generator',
  'myspace',
)

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** Re-sign a hand-built header/payload with a keypair (compact JWT). */
async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: Secp256k1Keypair | P256Keypair,
): Promise<string> {
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const sig = await key.sign(new TextEncoder().encode(signingInput))
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`
}

describe('verifySpaceCredential', () => {
  it('accepts a valid credential and returns its space URI', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })

    const result = await verifySpaceCredential(credential, {
      serviceKey: signingKey,
      serviceDid: SERVICE_DID,
    })
    expect(result).toEqual({ spaceUri: SPACE_URI })
  })

  it('is MULTI-USE: the same credential verifies repeatedly (no jti burn)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    const deps = { serviceKey: signingKey, serviceDid: SERVICE_DID }
    await expect(verifySpaceCredential(credential, deps)).resolves.toEqual({
      spaceUri: SPACE_URI,
    })
    await expect(verifySpaceCredential(credential, deps)).resolves.toEqual({
      spaceUri: SPACE_URI,
    })
    await expect(verifySpaceCredential(credential, deps)).resolves.toEqual({
      spaceUri: SPACE_URI,
    })
  })

  it('rejects an expired credential', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const iat = Math.floor(Date.now() / 1000) - 10_000
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 60, // exp = iat + 60, well in the past
      iat,
    })
    await expect(
      verifySpaceCredential(credential, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(SpaceCredentialExpiredError)
  })

  it('rejects a credential signed by a DIFFERENT (foreign) key', async () => {
    const authorityKey = await Secp256k1Keypair.create()
    const attackerKey = await Secp256k1Keypair.create()
    const { credential } = await mintSpaceCredential({
      signingKey: attackerKey, // signed by the wrong key
      issuerDid: SERVICE_DID,
      spaceUri: SPACE_URI,
      ttlSeconds: 7_200,
    })
    await expect(
      verifySpaceCredential(credential, {
        serviceKey: authorityKey, // verified against OUR key
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialSignatureError)
  })

  it('rejects a foreign-space credential (sub.spaceDid ≠ serviceDid)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const foreignSpace = makeSpaceUri(
      'did:web:other.example',
      'app.bsky.feed.generator',
      'x',
    )
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri: foreignSpace,
      ttlSeconds: 7_200,
    })
    await expect(
      verifySpaceCredential(credential, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(ForeignSpaceCredentialError)
  })

  it('rejects a wrong typ header', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      { typ: 'JWT', alg: 'ES256K', kid: '#atproto' },
      {
        iss: SERVICE_DID,
        sub: SPACE_URI,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialTypError)
  })

  it('rejects a wrong alg header', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      { typ: 'atproto-space-credential+jwt', alg: 'HS256', kid: '#atproto' },
      {
        iss: SERVICE_DID,
        sub: SPACE_URI,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialAlgError)
  })

  it('rejects a wrong kid header', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      {
        typ: 'atproto-space-credential+jwt',
        alg: 'ES256K',
        kid: '#atproto_wrong',
      },
      {
        iss: SERVICE_DID,
        sub: SPACE_URI,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialKidError)
  })

  it('rejects a malformed (non-JWT) token', async () => {
    const signingKey = await Secp256k1Keypair.create()
    await expect(
      verifySpaceCredential('not.a', {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(MalformedSpaceCredentialError)
  })

  it('rejects a credential with a non-space-URI sub', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const jwt = await signJwt(
      { typ: 'atproto-space-credential+jwt', alg: 'ES256K', kid: '#atproto' },
      {
        iss: SERVICE_DID,
        sub: 'not-a-space-uri',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      signingKey,
    )
    await expect(
      verifySpaceCredential(jwt, {
        serviceKey: signingKey,
        serviceDid: SERVICE_DID,
      }),
    ).rejects.toBeInstanceOf(InvalidSpaceCredentialSubError)
  })
})
