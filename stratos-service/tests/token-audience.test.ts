/**
 * Token audiences for space delegations and client attestations.
 *
 * Both token types must name `<authority did>#atproto_pds`. The retired
 * `#atproto_space_host`, any other fragment, a bare DID and another
 * authority's DID are refused, and the DID document offers a `#atproto_pds`
 * service entry at the service origin. Tokens made by the upstream package (stored in the shared
 * fixture) are judged by the real verifiers with the clock frozen to the
 * value the fixture records.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { CompactSign } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { P256Keypair } from '@atproto/crypto'
import type { Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import {
  DELEGATION_TYP,
  InvalidDelegationAudError,
  SPACE_HOST_FRAGMENT,
  verifyDelegationToken,
} from '../src/infra/auth/delegation-verifier.js'
import {
  CLIENT_ATTESTATION_TYP,
  InvalidAttestationAudError,
  verifyClientAttestation,
} from '../src/infra/auth/client-attestation-verifier.js'
import { JwksResolver } from '../src/infra/auth/jwks-resolver.js'
import { ReplayStore, type NxExStore } from '../src/infra/auth/replay-store.js'
import { StratosServer } from '../src/index.js'
import { makeClient, mintAttestation } from './helpers/attestation.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const NEW_AUDIENCE = `${SERVICE_DID}#atproto_pds`
const SPACE_URI = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'bebop')

const PORT_SERVICE_DID = 'did:web:tokyo-3.test%3A8443'
const PORT_SPACE_URI = makeSpaceUri(
  PORT_SERVICE_DID,
  'zone.stratos.space.feed',
  'nerv',
)

const REFUSED_AUDIENCES: Array<[string, string | undefined]> = [
  ['the retired fragment', `${SERVICE_DID}#atproto_space_host`],
  ['another fragment', `${SERVICE_DID}#atproto_space`],
  ['the stratos fragment', `${SERVICE_DID}#stratos`],
  ['a bare DID', SERVICE_DID],
  [
    'another authority with the right fragment',
    'did:web:other.test#atproto_pds',
  ],
  ['a missing aud', undefined],
]

class MemoryNxExStore implements NxExStore {
  keys = new Set<string>()
  async setNxEx(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    return true
  }
}

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

async function signDelegation(
  keypair: Keypair,
  aud: string | string[] | undefined,
  spaceUri: string = SPACE_URI,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000)
  const header = {
    typ: DELEGATION_TYP,
    alg: keypair.jwtAlg,
    kid: '#atproto',
  }
  const payload = {
    iss: keypair.did(),
    sub: spaceUri,
    ...(aud === undefined ? {} : { aud }),
    iat,
    exp: iat + 60,
    jti: `jti-${Math.random()}`,
  }
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const sig = await keypair.sign(new TextEncoder().encode(signingInput))
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`
}

function resolverForDocument(did: string, publicKeyMultibase: string) {
  return {
    did: {
      resolve: vi.fn(async (requested: string) =>
        requested === did
          ? {
              id: did,
              verificationMethod: [
                {
                  id: `${did}#atproto`,
                  type: 'Multikey',
                  controller: did,
                  publicKeyMultibase,
                },
              ],
            }
          : null,
      ),
    },
  } as unknown as IdResolver
}

describe('the shared audience fragment', () => {
  it('is #atproto_pds', () => {
    expect(SPACE_HOST_FRAGMENT).toBe('#atproto_pds')
  })
})

describe('delegation audience', () => {
  async function deps() {
    const keypair = await P256Keypair.create({ exportable: true })
    return {
      keypair,
      deps: {
        serviceDid: SERVICE_DID,
        idResolver: resolverForDocument(
          keypair.did(),
          keypair.did().slice('did:key:'.length),
        ),
      },
    }
  }

  it('accepts the authority host audience', async () => {
    const { keypair, deps: verifierDeps } = await deps()
    const token = await signDelegation(keypair, NEW_AUDIENCE)
    const result = await verifyDelegationToken(token, verifierDeps)
    expect(result.userDid).toBe(keypair.did())
  })

  it.each(REFUSED_AUDIENCES)('refuses %s', async (_name, aud) => {
    const { keypair, deps: verifierDeps } = await deps()
    const token = await signDelegation(keypair, aud)
    await expect(
      verifyDelegationToken(token, verifierDeps),
    ).rejects.toBeInstanceOf(InvalidDelegationAudError)
  })

  it('names the expected audience in its refusal', async () => {
    const { keypair, deps: verifierDeps } = await deps()
    const token = await signDelegation(
      keypair,
      `${SERVICE_DID}#atproto_space_host`,
    )
    await expect(verifyDelegationToken(token, verifierDeps)).rejects.toThrow(
      `expected "${NEW_AUDIENCE}"`,
    )
  })

  it.each([
    ['an array holding the right value', [NEW_AUDIENCE]],
    ['an array holding the right value and another', [NEW_AUDIENCE, 'x']],
    ['the fragment appended twice', `${NEW_AUDIENCE}#atproto_pds`],
    ['the right value with a trailing space', `${NEW_AUDIENCE} `],
  ])('refuses %s', async (_name, aud) => {
    const { keypair, deps: verifierDeps } = await deps()
    const token = await signDelegation(keypair, aud)
    await expect(
      verifyDelegationToken(token, verifierDeps),
    ).rejects.toBeInstanceOf(InvalidDelegationAudError)
  })

  it('compares a did:web with an encoded port exactly', async () => {
    const { keypair, deps: verifierDeps } = await deps()
    const portDeps = { ...verifierDeps, serviceDid: PORT_SERVICE_DID }
    const exact = await signDelegation(
      keypair,
      `${PORT_SERVICE_DID}#atproto_pds`,
      PORT_SPACE_URI,
    )
    const result = await verifyDelegationToken(exact, portDeps)
    expect(result.userDid).toBe(keypair.did())
    const unencoded = await signDelegation(
      keypair,
      'did:web:tokyo-3.test:8443#atproto_pds',
      PORT_SPACE_URI,
    )
    await expect(
      verifyDelegationToken(unencoded, portDeps),
    ).rejects.toBeInstanceOf(InvalidDelegationAudError)
  })
})

describe('client attestation audience', () => {
  async function setup() {
    const client = await makeClient()
    const resolver = new JwksResolver({
      fetch: (async () =>
        new Response(
          JSON.stringify({ jwks: { keys: [client.publicJwk] } }),
        )) as unknown as typeof globalThis.fetch,
    })
    const store = new MemoryNxExStore()
    return {
      client,
      store,
      deps: {
        serviceDid: SERVICE_DID,
        jwksResolver: resolver,
        replayStore: new ReplayStore(store),
      },
    }
  }

  async function signWithoutAud(
    client: Awaited<ReturnType<typeof makeClient>>,
  ): Promise<string> {
    const iat = Math.floor(Date.now() / 1000)
    return new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({
          iss: client.clientId,
          sub: client.clientId,
          iat,
          exp: iat + 60,
          jti: 'no-aud',
        }),
      ),
    )
      .setProtectedHeader({
        typ: CLIENT_ATTESTATION_TYP,
        alg: 'ES256',
        kid: client.kid,
      })
      .sign(client.privateKey)
  }

  it('accepts the authority host audience', async () => {
    const { client, deps: verifierDeps } = await setup()
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      aud: NEW_AUDIENCE,
    })
    const result = await verifyClientAttestation(token, verifierDeps)
    expect(result.clientId).toBe(client.clientId)
  })

  it.each(REFUSED_AUDIENCES)('refuses %s', async (_name, aud) => {
    const { client, store, deps: verifierDeps } = await setup()
    const token =
      aud === undefined
        ? await signWithoutAud(client)
        : await mintAttestation({
            client,
            serviceDid: SERVICE_DID,
            aud,
            jti: 'untouched',
          })
    await expect(
      verifyClientAttestation(token, verifierDeps),
    ).rejects.toBeInstanceOf(InvalidAttestationAudError)
    expect(store.keys.size).toBe(0)
  })

  it('names the expected audience in its refusal', async () => {
    const { client, deps: verifierDeps } = await setup()
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      aud: `${SERVICE_DID}#atproto_space_host`,
    })
    await expect(verifyClientAttestation(token, verifierDeps)).rejects.toThrow(
      `expected "${NEW_AUDIENCE}"`,
    )
  })

  async function signWithAud(
    client: Awaited<ReturnType<typeof makeClient>>,
    aud: unknown,
  ): Promise<string> {
    const iat = Math.floor(Date.now() / 1000)
    return new CompactSign(
      new TextEncoder().encode(
        JSON.stringify({
          iss: client.clientId,
          sub: client.clientId,
          aud,
          iat,
          exp: iat + 60,
          jti: `edge-${Math.random()}`,
        }),
      ),
    )
      .setProtectedHeader({
        typ: CLIENT_ATTESTATION_TYP,
        alg: 'ES256',
        kid: client.kid,
      })
      .sign(client.privateKey)
  }

  it.each([
    ['an array holding the right value', [NEW_AUDIENCE]],
    ['an array holding the right value and another', [NEW_AUDIENCE, 'x']],
    ['the fragment appended twice', `${NEW_AUDIENCE}#atproto_pds`],
    ['the right value with a trailing space', `${NEW_AUDIENCE} `],
  ])('refuses %s', async (_name, aud) => {
    const { client, store, deps: verifierDeps } = await setup()
    const token = await signWithAud(client, aud)
    await expect(
      verifyClientAttestation(token, verifierDeps),
    ).rejects.toBeInstanceOf(InvalidAttestationAudError)
    expect(store.keys.size).toBe(0)
  })

  it('compares a did:web with an encoded port exactly', async () => {
    const { client, deps: verifierDeps } = await setup()
    const portDeps = { ...verifierDeps, serviceDid: PORT_SERVICE_DID }
    const exact = await signWithAud(client, `${PORT_SERVICE_DID}#atproto_pds`)
    const result = await verifyClientAttestation(exact, portDeps)
    expect(result.clientId).toBe(client.clientId)
    const unencoded = await signWithAud(
      client,
      'did:web:tokyo-3.test:8443#atproto_pds',
    )
    await expect(
      verifyClientAttestation(unencoded, portDeps),
    ).rejects.toBeInstanceOf(InvalidAttestationAudError)
  })
})

describe('tokens made by the upstream package', () => {
  interface OracleToken {
    name: string
    token: string
    frozenClockSeconds: number
  }
  interface OracleFixture {
    authority: string
    testOnlyKeys: {
      memberDid: string
      clientJwk: Record<string, unknown>
    }
    tokens: OracleToken[]
  }
  const fixture: OracleFixture = JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../test/spaces-alignment/november/fixtures/token-audiences.json',
      ),
      'utf8',
    ),
  )
  const oracleToken = (name: string): OracleToken => {
    const found = fixture.tokens.find((entry) => entry.name === name)
    if (!found) throw new Error(`no fixture token named ${name}`)
    return found
  }
  const claims = (token: string): Record<string, string> =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts the oracle delegation under the frozen clock', async () => {
    const { token, frozenClockSeconds } = oracleToken('delegation')
    vi.setSystemTime(frozenClockSeconds * 1000)
    const { iss } = claims(token)
    const result = await verifyDelegationToken(token, {
      serviceDid: fixture.authority,
      idResolver: resolverForDocument(
        iss,
        fixture.testOnlyKeys.memberDid.slice('did:key:'.length),
      ),
    })
    expect(result.userDid).toBe(iss)
    expect(result.spaceUri).toBe(claims(token)['sub'])
  })

  it('refuses the oracle delegation that names the retired audience', async () => {
    const { token, frozenClockSeconds } = oracleToken(
      'delegation with the retired audience',
    )
    vi.setSystemTime(frozenClockSeconds * 1000)
    await expect(
      verifyDelegationToken(token, {
        serviceDid: fixture.authority,
        idResolver: resolverForDocument(
          claims(token)['iss'],
          fixture.testOnlyKeys.memberDid.slice('did:key:'.length),
        ),
      }),
    ).rejects.toBeInstanceOf(InvalidDelegationAudError)
  })

  it('accepts the oracle client attestation under the frozen clock', async () => {
    const { token, frozenClockSeconds } = oracleToken('client attestation')
    vi.setSystemTime(frozenClockSeconds * 1000)
    const resolver = new JwksResolver({
      fetch: (async () =>
        new Response(
          JSON.stringify({ jwks: { keys: [fixture.testOnlyKeys.clientJwk] } }),
        )) as unknown as typeof globalThis.fetch,
    })
    const result = await verifyClientAttestation(token, {
      serviceDid: fixture.authority,
      jwksResolver: resolver,
      replayStore: new ReplayStore(new MemoryNxExStore()),
    })
    expect(result.clientId).toBe(claims(token)['iss'])
  })
})

describe('the service DID document', () => {
  let listener: ReturnType<express.Application['listen']>

  afterEach(async () => {
    await new Promise((done) => listener.close(done))
  })

  it('offers #stratos, #atproto_pds at the same origin, and the #atproto key', async () => {
    const app = express()
    const signing = await P256Keypair.create()
    const ctx = { serviceDid: SERVICE_DID, signingDidKey: signing.did() }
    const cfg = {
      service: {
        publicUrl: 'https://stratos.test',
        serviceFragment: 'atproto_pns',
      },
    }
    StratosServer['registerWellKnownRoutes'](app, ctx as never, cfg as never)
    listener = app.listen(0)
    const { port } = listener.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/did.json`,
    )
    const document = (await response.json()) as {
      verificationMethod: Array<{ id: string }>
      service: Array<{ id: string; type: string; serviceEndpoint: string }>
    }
    expect(document.service).toEqual([
      {
        id: '#stratos',
        type: 'StratosService',
        serviceEndpoint: 'https://stratos.test',
      },
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://stratos.test',
      },
    ])
    expect(document.verificationMethod.map((method) => method.id)).toContain(
      `${SERVICE_DID}#atproto`,
    )
  })
})
