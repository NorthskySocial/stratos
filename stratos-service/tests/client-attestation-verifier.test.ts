/**
 * Unit tests for the client-attestation verifier.
 *
 * Covers each ordered check with a DISTINCT typed error, and proves the
 * critical ordering property: an invalid attestation must NOT consume its `jti`
 * (consumeOnce is performed LAST). All JWKS fetches are mocked — NO network.
 */
import { describe, expect, it, vi } from 'vitest'
import type { NxExStore } from '../src/infra/auth/replay-store.js'
import { ReplayStore } from '../src/infra/auth/replay-store.js'
import {
  AttestationKeyResolutionError,
  AttestationReplayError,
  AttestationTimingError,
  InvalidAttestationAudError,
  InvalidAttestationAlgError,
  InvalidAttestationIssuerError,
  InvalidAttestationKidError,
  InvalidAttestationSignatureError,
  InvalidAttestationTypError,
  MalformedAttestationError,
  NonHttpsClientError,
  verifyClientAttestation,
  type ClientAttestationVerifierDeps,
} from '../src/infra/auth/client-attestation-verifier.js'
import {
  makeClient,
  mintAttestation,
  resolverFor,
} from './helpers/attestation.js'

const SERVICE_DID = 'did:web:stratos.test'

/** In-memory NX-EX store (first set wins). */
class MemoryNxExStore implements NxExStore {
  keys = new Set<string>()
  async setNxEx(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    return true
  }
}

async function setup() {
  const client = await makeClient()
  const store = new MemoryNxExStore()
  const deps: ClientAttestationVerifierDeps = {
    serviceDid: SERVICE_DID,
    jwksResolver: resolverFor([client]),
    replayStore: new ReplayStore(store),
  }
  return { client, store, deps }
}

describe('verifyClientAttestation — happy path', () => {
  it('accepts a valid attestation and returns the attested client_id', async () => {
    const { client, deps } = await setup()
    const token = await mintAttestation({ client, serviceDid: SERVICE_DID })
    const res = await verifyClientAttestation(token, deps)
    expect(res.clientId).toBe(client.clientId)
  })

  it('rejects a replay of the same jti', async () => {
    const { client, deps } = await setup()
    const jti = 'fixed-jti'
    const t1 = await mintAttestation({ client, serviceDid: SERVICE_DID, jti })
    const t2 = await mintAttestation({ client, serviceDid: SERVICE_DID, jti })
    await verifyClientAttestation(t1, deps)
    await expect(verifyClientAttestation(t2, deps)).rejects.toBeInstanceOf(
      AttestationReplayError,
    )
  })
})

describe('verifyClientAttestation — distinct typed failures', () => {
  it('malformed (non-JWT) → MalformedAttestationError', async () => {
    const { deps } = await setup()
    await expect(
      verifyClientAttestation('garbage', deps),
    ).rejects.toBeInstanceOf(MalformedAttestationError)
  })

  it('bad typ → InvalidAttestationTypError', async () => {
    const { client, deps } = await setup()
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      typ: 'wrong+jwt',
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      InvalidAttestationTypError,
    )
  })

  it('missing alg → InvalidAttestationAlgError', async () => {
    const { client, deps } = await setup()
    // Build a header without alg by crafting the compact JWS manually.
    const header = { typ: 'atproto-client-attestation+jwt', kid: client.kid }
    const payload = {
      iss: client.clientId,
      sub: client.clientId,
      aud: `${SERVICE_DID}#atproto_space_host`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: 'no-alg',
    }
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString('base64url')
    const token = `${b64(header)}.${b64(payload)}.AAAA`
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      InvalidAttestationAlgError,
    )
  })

  it('missing kid → InvalidAttestationKidError', async () => {
    const { client, deps } = await setup()
    const header = { typ: 'atproto-client-attestation+jwt', alg: 'ES256' }
    const payload = { iss: client.clientId, sub: client.clientId }
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString('base64url')
    const token = `${b64(header)}.${b64(payload)}.AAAA`
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      InvalidAttestationKidError,
    )
  })

  it('iss !== sub → InvalidAttestationIssuerError', async () => {
    const { client, deps } = await setup()
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      sub: 'https://other.example/client-metadata.json',
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      InvalidAttestationIssuerError,
    )
  })

  it('non-HTTPS client_id (iss) → NonHttpsClientError', async () => {
    const { client, deps } = await setup()
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      iss: 'http://client.example/client-metadata.json',
      sub: 'http://client.example/client-metadata.json',
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      NonHttpsClientError,
    )
  })

  it('wrong aud → InvalidAttestationAudError', async () => {
    const { client, deps } = await setup()
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      aud: 'did:web:evil#atproto_space_host',
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      InvalidAttestationAudError,
    )
  })

  it('expired → AttestationTimingError', async () => {
    const { client, deps } = await setup()
    const now = Math.floor(Date.now() / 1000)
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      iat: now - 1000,
      exp: now - 900,
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      AttestationTimingError,
    )
  })

  it('lifetime > 300s → AttestationTimingError', async () => {
    const { client, deps } = await setup()
    const now = Math.floor(Date.now() / 1000)
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      iat: now,
      exp: now + 301,
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      AttestationTimingError,
    )
  })

  it('unknown kid → AttestationKeyResolutionError (fail closed)', async () => {
    const { client, deps } = await setup()
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      kid: 'no-such-kid',
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      AttestationKeyResolutionError,
    )
  })

  it('bad signature (signed with wrong key) → InvalidAttestationSignatureError', async () => {
    const { client, deps } = await setup()
    const impostor = await makeClient(client.kid)
    // Sign with the impostor key but present the honest client_id/kid, so the
    // resolver returns the honest published key and the signature fails.
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      wrongKey: impostor.privateKey,
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      InvalidAttestationSignatureError,
    )
  })

  it('JWKS fetch failure → AttestationKeyResolutionError (fail closed)', async () => {
    const client = await makeClient()
    const deps: ClientAttestationVerifierDeps = {
      serviceDid: SERVICE_DID,
      jwksResolver: resolverFor([client], { failFetch: [client.clientId] }),
      replayStore: new ReplayStore(new MemoryNxExStore()),
    }
    const token = await mintAttestation({ client, serviceDid: SERVICE_DID })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      AttestationKeyResolutionError,
    )
  })
})

describe('verifyClientAttestation — jti consumed LAST (ordering)', () => {
  it('an INVALID attestation does not burn its jti; a valid one with the same jti still succeeds', async () => {
    const { client, store, deps } = await setup()
    const jti = 'shared-jti'

    // A signature-invalid attestation bearing `jti`: must be rejected AND must
    // NOT consume `jti` (the replay check runs only after signature verifies).
    const impostor = await makeClient(client.kid)
    const bad = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      jti,
      wrongKey: impostor.privateKey,
    })
    await expect(verifyClientAttestation(bad, deps)).rejects.toBeInstanceOf(
      InvalidAttestationSignatureError,
    )
    // The replay store must not have recorded the jti.
    expect(store.keys.has(`replay:client-attestation:${jti}`)).toBe(false)

    // A genuinely valid attestation with the SAME jti must still succeed.
    const good = await mintAttestation({ client, serviceDid: SERVICE_DID, jti })
    const res = await verifyClientAttestation(good, deps)
    expect(res.clientId).toBe(client.clientId)
    // Now the jti is recorded, so a further replay is rejected.
    expect(store.keys.has(`replay:client-attestation:${jti}`)).toBe(true)
  })

  it('every pre-signature failure also spares the jti', async () => {
    const { client, store, deps } = await setup()
    const jti = 'untouched-jti'
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      jti,
      aud: 'did:web:evil#atproto_space_host',
    })
    await expect(verifyClientAttestation(token, deps)).rejects.toBeInstanceOf(
      InvalidAttestationAudError,
    )
    expect(store.keys.has(`replay:client-attestation:${jti}`)).toBe(false)
  })
})
