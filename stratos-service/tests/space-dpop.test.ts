/**
 * Unit tests for the SpaceDpopProofChecker.
 *
 * The checker wraps `DpopManager` with nonces disabled and enforces the
 * space-surface proof rules: a proof is REQUIRED (missing header rejects),
 * `ath` is REQUIRED and must match when a bound token is supplied, and `ath`
 * is REJECTED on standalone (mint-time) proofs. All failures surface as
 * `SpaceDpopProofError`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose'
import {
  SpaceDpopProofChecker,
  SpaceDpopProofError,
} from '../src/infra/auth/space-dpop.js'

const SERVICE_ENDPOINT = 'https://stratos.test'
const PATH = '/xrpc/zone.stratos.space.getSpaceCredential'

/** An ES256 proof key: its jkt plus a builder for htm/htu-bound proofs. */
async function makeProofKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const jwk = await exportJWK(publicKey)
  const jkt = await calculateJwkThumbprint(jwk)
  async function buildProof(opts: { ath?: string } = {}): Promise<string> {
    return new SignJWT({
      htm: 'POST',
      htu: `${SERVICE_ENDPOINT}${PATH}`,
      jti: randomUUID(),
      ...(opts.ath ? { ath: opts.ath } : {}),
    })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
      .setIssuedAt()
      .sign(privateKey)
  }
  return { jkt, buildProof }
}

const request = (proof?: string) => ({
  method: 'POST',
  url: PATH,
  headers: proof ? { dpop: proof } : {},
})

const athOf = (token: string) =>
  createHash('sha256').update(token).digest('base64url')

describe('SpaceDpopProofChecker', () => {
  it('accepts a valid standalone proof and returns its jkt and jti', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const proof = await checker.check(request(await key.buildProof()))
    expect(proof.jkt).toBe(key.jkt)
    expect(proof.jti).toBeTruthy()
  })

  it('rejects a missing DPoP header with "DPoP proof required"', async () => {
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const err = await checker.check(request()).catch((e) => e)
    expect(err).toBeInstanceOf(SpaceDpopProofError)
    expect(err.name).toBe('SpaceDpopProofError')
    expect(err.message).toBe('DPoP proof required')
  })

  it('rejects a malformed proof and surfaces the validation reason', async () => {
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const err = await checker.check(request('not-a-jwt')).catch((e) => e)
    expect(err).toBeInstanceOf(SpaceDpopProofError)
    // The catch path must carry the manager's reason, not the missing-header
    // message the fall-through `!proof` branch would produce.
    expect(err.message).not.toBe('DPoP proof required')
  })

  it('with a bound token: requires a matching ath', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const token = 'credential-token'
    await expect(
      checker.check(request(await key.buildProof()), token),
    ).rejects.toBeInstanceOf(SpaceDpopProofError)
    const bound = await checker.check(
      request(await key.buildProof({ ath: athOf(token) })),
      token,
    )
    expect(bound.jkt).toBe(key.jkt)
  })

  it('without a bound token: rejects a proof carrying ath', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    await expect(
      checker.check(request(await key.buildProof({ ath: athOf('anything') }))),
    ).rejects.toBeInstanceOf(SpaceDpopProofError)
  })
})
