/**
 * Unit tests for the SpaceDpopProofChecker.
 *
 * The checker is a standalone RFC 9449 verifier (mirroring the upstream
 * space-surface rules) and enforces: a proof is REQUIRED (missing header
 * rejects), `ath` is REQUIRED and must match when a bound token is supplied,
 * `ath` is REJECTED on standalone (mint-time) proofs, and a `nonce` claim is
 * IGNORED (the space surface has no nonce round trip). All failures surface
 * as `SpaceDpopProofError`.
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
  async function buildProof(
    opts: {
      ath?: string
      nonce?: string
      htu?: string | number | string[]
    } = {},
  ): Promise<string> {
    return new SignJWT({
      htm: 'POST',
      htu: opts.htu ?? `${SERVICE_ENDPOINT}${PATH}`,
      jti: randomUUID(),
      ...(opts.ath ? { ath: opts.ath } : {}),
      ...(opts.nonce ? { nonce: opts.nonce } : {}),
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

  it('ignores a stray "nonce" claim (no OAuth nonce round trip on this surface)', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const proof = await checker.check(
      request(await key.buildProof({ nonce: 'server-issued-nonce' })),
    )
    expect(proof.jkt).toBe(key.jkt)
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
    // The failure must carry the verification reason, not the missing-header
    // message.
    expect(err.message).not.toBe('DPoP proof required')
  })

  it('names both htu values on a mismatch, but strips the proof query', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const err = await checker
      .check(
        request(
          await key.buildProof({
            htu: `https://wrong.test${PATH}?access_token=super-secret`,
          }),
        ),
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(SpaceDpopProofError)
    expect(err.message).toContain(`proof=https://wrong.test${PATH}`)
    expect(err.message).toContain(`expected=${SERVICE_ENDPOINT}${PATH}`)
    expect(err.message).not.toContain('super-secret')
  })

  it('reports a non-URL htu as malformed instead of echoing it', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const err = await checker
      .check(request(await key.buildProof({ htu: 'not a url\nfake log line' })))
      .catch((e) => e)
    expect(err).toBeInstanceOf(SpaceDpopProofError)
    expect(err.message).toContain('proof=<malformed>')
    expect(err.message).not.toContain('fake log line')
  })

  it('reports a non-string htu as malformed instead of stringifying it', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const err = await checker
      .check(request(await key.buildProof({ htu: 42 })))
      .catch((e) => e)
    expect(err).toBeInstanceOf(SpaceDpopProofError)
    expect(err.message).toContain('proof=<malformed>')
    expect(err.message).not.toContain('proof=42')
  })

  it('reports an array htu holding a valid URL as malformed, never its content', async () => {
    // Without the type guard, `new URL(['https://...'])` coerces the single
    // element to a parseable string and the caller's value reaches the
    // message.
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const err = await checker
      .check(request(await key.buildProof({ htu: ['https://mars.test/leak'] })))
      .catch((e) => e)
    expect(err).toBeInstanceOf(SpaceDpopProofError)
    expect(err.message).toContain('proof=<malformed>')
    expect(err.message).not.toContain('mars.test')
  })

  it('does not echo elements of an array htu (String() would join them verbatim)', async () => {
    const key = await makeProofKey()
    const checker = new SpaceDpopProofChecker(SERVICE_ENDPOINT)
    const err = await checker
      .check(
        request(
          await key.buildProof({
            htu: ['https://tokyo-3.test\nfake log line'],
          }),
        ),
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(SpaceDpopProofError)
    expect(err.message).toContain('proof=<malformed>')
    expect(err.message).not.toContain('fake log line')
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
