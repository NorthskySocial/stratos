/**
 * Contract tests for app-axis (client attestation) gating in the
 * `zone.stratos.space.getSpaceCredential` handler.
 *
 * NO live network — the JWKS resolver runs over a mocked fetch. Covers:
 *   - open space without attestation → OK (byte-identical to the ungated path);
 *   - open space WITH an attestation supplied → attestation ignored, OK;
 *   - allowList space without attestation → AttestationRequired;
 *   - listed client with a valid attestation → OK exactly once (replay rejected);
 *   - unlisted client with a valid attestation → ClientNotAllowed;
 *   - a verification failure (bad signature) → AttestationRequired.
 * The credential is decoded and verified against the service key to prove the
 * open-space path is unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import type { Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { registerSpaceCredentialHandlers } from '../src/features/space-credential/index.js'
import { validateSpaceAppAccess } from '../src/features/space-credential/app-access.js'
import type { NxExStore } from '../src/infra/auth/replay-store.js'
import type { AppContext } from '../src/index.js'
import {
  makeClient,
  mintAttestation,
  resolverFor,
  type ClientIdentity,
} from './helpers/attestation.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const TTL_SECONDS = 7_200
const SPACE_SKEY = 'myspace'
const SPACE_URI = makeSpaceUri(
  SERVICE_DID,
  'app.bsky.feed.generator',
  SPACE_SKEY,
)
const SPACE_BOUNDARY = `${SERVICE_DID}/${SPACE_SKEY}`
const USER_DID = 'did:plc:abcabcabcabcabcabcabcabc'

// --- Mock XRPC server ------------------------------------------------------
interface MockXrpcServer {
  methods: Record<string, { type: string; auth?: unknown; handler: Function }>
  method: (
    nsid: string,
    config: { type: string; auth?: unknown; handler: Function },
  ) => void
}
function createMockXrpcServer(): MockXrpcServer {
  const methods: MockXrpcServer['methods'] = {}
  return { methods, method: (nsid, config) => void (methods[nsid] = config) }
}

interface InvokeResult {
  body?: { credential?: string; expiresAt?: string }
  error?: { name: string; message: string }
}
async function invoke(
  server: MockXrpcServer,
  input: Record<string, unknown>,
  authDid?: string,
): Promise<InvokeResult> {
  const method = server.methods['zone.stratos.space.getSpaceCredential']
  if (!method) throw new Error('method not registered')
  const auth = authDid
    ? { credentials: { type: 'user', did: authDid } }
    : { credentials: { type: 'anonymous' } }
  try {
    const result = await method.handler({
      input: { body: input, encoding: 'application/json' },
      params: {},
      auth,
      req: { headers: {} },
    })
    return { body: result.body }
  } catch (err) {
    const e = err as {
      constructor: { name: string }
      message: string
      customErrorName?: string
    }
    const name =
      (err as { error?: string }).error ??
      e.customErrorName ??
      e.constructor.name
    return { error: { name, message: e.message } }
  }
}

// --- In-memory replay cache (RedisCache-shaped: exposes setNxEx) ------------
class MemoryCache implements NxExStore {
  keys = new Set<string>()
  async setNxEx(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    return true
  }
}

interface MockCtxOptions {
  signingKey: Keypair
  clients: ClientIdentity[]
  appAccessEntries?: Array<Record<string, unknown>>
  failFetch?: string[]
}
function createMockCtx(opts: MockCtxOptions): AppContext {
  const optionalStandard = vi.fn(
    async (authCtx: any) => authCtx.auth ?? authCtx,
  )
  return {
    serviceDid: SERVICE_DID,
    signingKey: opts.signingKey,
    idResolver: { did: { resolve: vi.fn() } } as unknown as IdResolver,
    cache: new MemoryCache(),
    jwksResolver: resolverFor(opts.clients, { failFetch: opts.failFetch }),
    cfg: {
      stratos: {
        spaceCredentialTtlSeconds: TTL_SECONDS,
        spaceAppAccess: validateSpaceAppAccess(
          opts.appAccessEntries ?? [],
          SERVICE_DID,
        ),
      },
    },
    enrollmentStore: {
      getEnrollment: vi.fn(async (did: string) => ({
        did,
        enrolledAt: '1995-10-04T00:00:00.000Z',
        signingKeyDid: 'did:key:zDnaeUsagi',
        active: true,
      })),
      getBoundaries: vi.fn(async () => [SPACE_BOUNDARY]),
    },
    authVerifier: { optionalStandard },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AppContext
}

function decodeCredential(jwt: string) {
  const parts = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
    payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
    signingInput: `${parts[0]}.${parts[1]}`,
    signatureBytes: new Uint8Array(Buffer.from(parts[2], 'base64url')),
  }
}
async function verifyCredentialAgainst(keyDid: string, jwt: string) {
  const d = decodeCredential(jwt)
  return verifySignature(
    keyDid,
    new TextEncoder().encode(d.signingInput),
    d.signatureBytes,
  )
}

// ===========================================================================
describe('getSpaceCredential — app-axis gating', () => {
  it('open space (no config) issues without attestation — identical to the ungated path', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({ signingKey, clients: [] })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error).toBeUndefined()
    const { header, payload } = decodeCredential(res.body!.credential!)
    expect(header).toEqual({
      typ: 'atproto-space-credential+jwt',
      alg: 'ES256K',
      kid: '#atproto',
    })
    expect(payload.iss).toBe(SERVICE_DID)
    expect(payload.sub).toBe(SPACE_URI)
    expect('aud' in payload).toBe(false)
    expect(payload.exp - payload.iat).toBe(TTL_SECONDS)
    expect(
      await verifyCredentialAgainst(signingKey.did(), res.body!.credential!),
    ).toBe(true)
  })

  it('open space IGNORES a supplied attestation and still issues', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const client = await makeClient()
    // Space is explicitly `open`; a (here, even bogus) attestation is ignored.
    const ctx = createMockCtx({
      signingKey,
      clients: [client],
      appAccessEntries: [{ space: SPACE_SKEY, access: 'open' }],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(
      server,
      { space: SPACE_URI, clientAttestation: 'totally-bogus' },
      USER_DID,
    )
    expect(res.error).toBeUndefined()
    expect(res.body?.credential).toBeTruthy()
  })

  it('allowList space without attestation → AttestationRequired', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const client = await makeClient()
    const ctx = createMockCtx({
      signingKey,
      clients: [client],
      appAccessEntries: [
        {
          space: SPACE_SKEY,
          access: 'allowList',
          clientIds: [client.clientId],
        },
      ],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error?.name).toBe('AttestationRequired')
  })

  it('listed client with valid attestation → OK exactly once (replay rejected)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const client = await makeClient()
    const ctx = createMockCtx({
      signingKey,
      clients: [client],
      appAccessEntries: [
        {
          space: SPACE_SKEY,
          access: 'allowList',
          clientIds: [client.clientId],
        },
      ],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const jti = 'gate-jti'
    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      jti,
    })
    const ok = await invoke(
      server,
      { space: SPACE_URI, clientAttestation: token },
      USER_DID,
    )
    expect(ok.error).toBeUndefined()
    expect(ok.body?.credential).toBeTruthy()

    // Replaying the SAME attestation is rejected (single-use jti).
    const replay = await invoke(
      server,
      { space: SPACE_URI, clientAttestation: token },
      USER_DID,
    )
    expect(replay.error?.name).toBe('AttestationRequired')
  })

  it('unlisted client with a valid attestation → ClientNotAllowed', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const listed = await makeClient()
    const other = await makeClient()
    const ctx = createMockCtx({
      signingKey,
      clients: [listed, other],
      appAccessEntries: [
        {
          space: SPACE_SKEY,
          access: 'allowList',
          clientIds: [listed.clientId],
        },
      ],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const token = await mintAttestation({
      client: other,
      serviceDid: SERVICE_DID,
    })
    const res = await invoke(
      server,
      { space: SPACE_URI, clientAttestation: token },
      USER_DID,
    )
    expect(res.error?.name).toBe('ClientNotAllowed')
  })

  it('allowList space with an invalid (bad-signature) attestation → AttestationRequired', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const client = await makeClient()
    const impostor = await makeClient(client.kid)
    const ctx = createMockCtx({
      signingKey,
      clients: [client],
      appAccessEntries: [
        {
          space: SPACE_SKEY,
          access: 'allowList',
          clientIds: [client.clientId],
        },
      ],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const token = await mintAttestation({
      client,
      serviceDid: SERVICE_DID,
      wrongKey: impostor.privateKey,
    })
    const res = await invoke(
      server,
      { space: SPACE_URI, clientAttestation: token },
      USER_DID,
    )
    expect(res.error?.name).toBe('AttestationRequired')
  })

  it('allowList space, JWKS fetch failure → AttestationRequired (fail closed)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const client = await makeClient()
    const ctx = createMockCtx({
      signingKey,
      clients: [client],
      failFetch: [client.clientId],
      appAccessEntries: [
        {
          space: SPACE_SKEY,
          access: 'allowList',
          clientIds: [client.clientId],
        },
      ],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const token = await mintAttestation({ client, serviceDid: SERVICE_DID })
    const res = await invoke(
      server,
      { space: SPACE_URI, clientAttestation: token },
      USER_DID,
    )
    expect(res.error?.name).toBe('AttestationRequired')
  })

  it('gating runs AFTER membership: a non-enrolled user is NotEnrolled even on a gated space', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const client = await makeClient()
    const ctx = createMockCtx({
      signingKey,
      clients: [client],
      appAccessEntries: [
        {
          space: SPACE_SKEY,
          access: 'allowList',
          clientIds: [client.clientId],
        },
      ],
    })
    // Override enrollment to empty so the membership check fails first.
    ;(ctx.enrollmentStore.getBoundaries as any) = vi.fn(async () => [])
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error?.name).toBe('NotEnrolled')
  })
})
