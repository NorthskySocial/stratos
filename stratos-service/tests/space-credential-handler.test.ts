/**
 * Contract tests for the `zone.stratos.space.getSpaceCredential` endpoint.
 *
 * Exercises both identity paths against a mock XRPC server + mock AppContext:
 *   - Interim DPoP path (live): enrolled user gets a credential; non-enrolled
 *     is rejected `NotEnrolled`; a foreign-space URI is rejected `UnknownSpace`.
 *   - Deactivation gate: a deactivated member is rejected `NotEnrolled` even
 *     while holding the boundary, and the deny lands on the very next mint.
 *   - Delegation-token path (dormant, real delegation verifier): happy path
 *     issues a credential; every verification failure surfaces as `InvalidToken`.
 * The issued credential is decoded and verified against the service key (and
 * asserted to FAIL against another key), with the full spec claim set checked
 * including the absence of `aud`, and `exp - iat` equal to the configured TTL.
 */
import { describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import type { Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { SqliteEnrollmentStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
} from '../src/db/index.js'
import { registerSpaceCredentialHandlers } from '../src/features/space-credential/index.js'
import { DELEGATION_TYP } from '../src/infra/auth/delegation-verifier.js'
import type { NxExStore } from '../src/infra/auth/replay-store.js'
import type { AppContext } from '../src/index.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const TTL_SECONDS = 7_200
const SPACE_URI = makeSpaceUri(
  SERVICE_DID,
  'app.bsky.feed.generator',
  'myspace',
)
// boundaryToSpaceUri: boundary "{serviceDid}/{skey}" ⇄ space skey == domainName.
const SPACE_BOUNDARY = `${SERVICE_DID}/myspace`
const USER_DID = 'did:plc:abcabcabcabcabcabcabcabc'

// ---------------------------------------------------------------------------
// Mock XRPC server (records registered methods; invoked directly).
// ---------------------------------------------------------------------------
interface MockXrpcServer {
  methods: Record<string, { type: string; auth?: unknown; handler: Function }>
  method: (
    nsid: string,
    config: { type: string; auth?: unknown; handler: Function },
  ) => void
}

function createMockXrpcServer(): MockXrpcServer {
  const methods: MockXrpcServer['methods'] = {}
  return {
    methods,
    method: (nsid, config) => {
      methods[nsid] = config
    },
  }
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
    // xrpc-server InvalidRequestError carries the lexicon error name on `.error`.
    const name =
      (err as { error?: string }).error ??
      e.customErrorName ??
      e.constructor.name
    return { error: { name, message: e.message } }
  }
}

// ---------------------------------------------------------------------------
// Mock AppContext.
// ---------------------------------------------------------------------------

/** In-memory NX-EX store (first set wins) so the delegation replay check works. */
class MemoryNxExStore implements NxExStore {
  private keys = new Set<string>()
  async setNxEx(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    return true
  }
}

/** IdResolver that resolves `did` to a doc with a single `#atproto` method. */
function atprotoResolver(did: string, keypair: Keypair): IdResolver {
  return {
    did: {
      resolve: vi.fn().mockResolvedValue({
        id: did,
        verificationMethod: [
          {
            id: `${did}#atproto`,
            type: 'Multikey',
            controller: did,
            publicKeyMultibase: keypair.did().slice('did:key:'.length),
          },
        ],
      }),
    },
  } as unknown as IdResolver
}

interface MockCtxOptions {
  signingKey: Keypair
  enrolledBoundaries?: string[]
  /** Whether the caller's enrollment row is still active. Defaults to true. */
  enrollmentActive?: boolean
  idResolver?: IdResolver
  cache?: NxExStore
}

function createMockCtx(opts: MockCtxOptions): AppContext {
  const optionalStandard = vi.fn(
    async (authCtx: any) => authCtx.auth ?? authCtx,
  )
  return {
    serviceDid: SERVICE_DID,
    signingKey: opts.signingKey,
    idResolver:
      opts.idResolver ??
      ({ did: { resolve: vi.fn() } } as unknown as IdResolver),
    cache: opts.cache,
    cfg: {
      stratos: { spaceCredentialTtlSeconds: TTL_SECONDS },
    },
    enrollmentStore: {
      getEnrollment: vi.fn(async (did: string) => ({
        did,
        enrolledAt: '1995-10-04T00:00:00.000Z',
        signingKeyDid: 'did:key:zDnaeUsagi',
        active: opts.enrollmentActive ?? true,
      })),
      getBoundaries: vi.fn(async () => opts.enrolledBoundaries ?? []),
    },
    authVerifier: {
      optionalStandard,
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as AppContext
}

// ---------------------------------------------------------------------------
// Delegation-token minting (real delegation shape, signed by the user key).
// ---------------------------------------------------------------------------
const b64url = (v: unknown): string =>
  Buffer.from(JSON.stringify(v)).toString('base64url')

interface DelegationMintOpts {
  userKey: Keypair
  typ?: string
  alg?: string
  kid?: string
  iss?: string
  sub?: string
  aud?: string
  iat?: number
  exp?: number
  jti?: string
  tamper?: boolean
}

let jtiCounter = 0
async function mintDelegation(opts: DelegationMintOpts): Promise<string> {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000)
  const header = {
    typ: opts.typ ?? DELEGATION_TYP,
    alg: opts.alg ?? opts.userKey.jwtAlg,
    kid: opts.kid ?? '#atproto',
  }
  const payload = {
    iss: opts.iss ?? opts.userKey.did(),
    sub: opts.sub ?? SPACE_URI,
    aud: opts.aud ?? `${SERVICE_DID}#atproto_space_host`,
    iat,
    exp: opts.exp ?? iat + 60,
    jti: opts.jti ?? `jti-${Date.now()}-${jtiCounter++}`,
  }
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const bytes = new TextEncoder().encode(
    opts.tamper ? `${signingInput}.x` : signingInput,
  )
  const sig = await opts.userKey.sign(bytes)
  return `${signingInput}.${Buffer.from(sig).toString('base64url')}`
}

// ---------------------------------------------------------------------------
// Credential decode/verify helpers.
// ---------------------------------------------------------------------------
function decodeCredential(jwt: string) {
  const parts = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
    payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
    signingInput: `${parts[0]}.${parts[1]}`,
    signatureBytes: new Uint8Array(Buffer.from(parts[2], 'base64url')),
  }
}

async function verifyCredentialAgainst(
  keyDid: string,
  jwt: string,
): Promise<boolean> {
  const d = decodeCredential(jwt)
  return verifySignature(
    keyDid,
    new TextEncoder().encode(d.signingInput),
    d.signatureBytes,
  )
}

// ===========================================================================
// DPoP (interim, live) path
// ===========================================================================
describe('getSpaceCredential — DPoP path', () => {
  it('issues a credential to an enrolled DPoP-authed user (verifies; no aud; TTL)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error).toBeUndefined()
    expect(res.body?.credential).toBeTruthy()

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
    expect(res.body!.expiresAt).toBe(new Date(payload.exp * 1000).toISOString())

    // Verifies against the service key, fails against a different key.
    expect(
      await verifyCredentialAgainst(signingKey.did(), res.body!.credential!),
    ).toBe(true)
    const other = await Secp256k1Keypair.create()
    expect(
      await verifyCredentialAgainst(other.did(), res.body!.credential!),
    ).toBe(false)

    // The membership check was a live enrollment-store lookup for the user.
    expect(ctx.enrollmentStore.getBoundaries).toHaveBeenCalledWith(USER_DID)
  })

  it('rejects a non-enrolled user with NotEnrolled', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({ signingKey, enrolledBoundaries: [] })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error?.name).toBe('NotEnrolled')
  })

  it('rejects a foreign-space URI (spaceDid ≠ serviceDid) with UnknownSpace', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const foreign = makeSpaceUri(
      'did:web:other.example',
      'app.bsky.feed.generator',
      'myspace',
    )
    const res = await invoke(server, { space: foreign }, USER_DID)
    expect(res.error?.name).toBe('UnknownSpace')
  })

  it('rejects an anonymous caller (no DPoP, no delegation token)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI })
    expect(res.error?.name).toBe('AuthRequired')
  })

  it('rejects a malformed space URI with UnknownSpace', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: 'not-a-space-uri' }, USER_DID)
    expect(res.error?.name).toBe('UnknownSpace')
  })
})

// ===========================================================================
// Deactivation gate
// ===========================================================================

/**
 * Deactivation revokes credential issuance.
 *
 * Boundary rows survive a deactivation, so a boundaries-only membership check
 * would let a suspended member keep minting credentials. Both the never-enrolled
 * and the deactivated caller must get the same `NotEnrolled` shape — the surface
 * must not become a membership-status oracle.
 */
describe('getSpaceCredential — deactivation gate', () => {
  /** Register the handler against a fresh mock ctx and issue one request. */
  async function mint(opts: Omit<MockCtxOptions, 'signingKey'>) {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({ signingKey, ...opts })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)
    return invoke(server, { space: SPACE_URI }, USER_DID)
  }

  it('rejects a deactivated user holding a matching boundary with NotEnrolled', async () => {
    const res = await mint({
      enrolledBoundaries: [SPACE_BOUNDARY],
      enrollmentActive: false,
    })

    expect(res.error?.name).toBe('NotEnrolled')
    expect(res.body).toBeUndefined()
  })

  it('is indistinguishable from a never-enrolled rejection (no status oracle)', async () => {
    const deactivated = await mint({
      enrolledBoundaries: [SPACE_BOUNDARY],
      enrollmentActive: false,
    })
    const neverEnrolled = await mint({ enrolledBoundaries: [] })

    expect(deactivated.error).toEqual(neverEnrolled.error)
  })

  it('rejects a user with no enrollment row with NotEnrolled', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
    })
    ;(ctx.enrollmentStore.getEnrollment as any) = vi.fn(async () => null)
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error?.name).toBe('NotEnrolled')
    expect(res.body).toBeUndefined()
  })

  it('deactivation is immediate: the NEXT mint after it is rejected', async () => {
    // Real store, so the deny is driven by an actual deactivation write rather
    // than a re-stubbed mock — that is what "immediate" has to mean.
    const db = createServiceDb(':memory:')
    await migrateServiceDb(db)
    const store = new SqliteEnrollmentStore(db)
    await store.enroll({
      did: USER_DID,
      enrolledAt: new Date().toISOString(),
      boundaries: [SPACE_BOUNDARY],
      signingKeyDid: 'did:key:zDnaeUsagi',
      active: true,
    })

    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({ signingKey })
    ;(ctx as any).enrollmentStore = store
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    try {
      const before = await invoke(server, { space: SPACE_URI }, USER_DID)
      expect(before.error).toBeUndefined()
      expect(before.body?.credential).toBeTruthy()

      await store.updateEnrollment(USER_DID, { active: false })

      const after = await invoke(server, { space: SPACE_URI }, USER_DID)
      expect(after.error?.name).toBe('NotEnrolled')
      expect(after.body).toBeUndefined()
    } finally {
      await closeServiceDb(db)
    }
  })
})

// ===========================================================================
// Delegation-token (dormant) path
// ===========================================================================
describe('getSpaceCredential — delegation-token path', () => {
  async function setup(enrolled: boolean) {
    const signingKey = await Secp256k1Keypair.create()
    const userKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: enrolled ? [SPACE_BOUNDARY] : [],
      idResolver: atprotoResolver(userKey.did(), userKey),
      cache: new MemoryNxExStore(),
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)
    return { signingKey, userKey, ctx, server }
  }

  it('happy path: valid token for enrolled user issues a credential', async () => {
    const { signingKey, userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, iss: userKey.did() })

    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(res.error).toBeUndefined()
    expect(res.body?.credential).toBeTruthy()
    const { payload } = decodeCredential(res.body!.credential!)
    expect(payload.iss).toBe(SERVICE_DID)
    expect(payload.sub).toBe(SPACE_URI)
    expect('aud' in payload).toBe(false)
    expect(
      await verifyCredentialAgainst(signingKey.did(), res.body!.credential!),
    ).toBe(true)
  })

  it('valid token but user not enrolled → NotEnrolled', async () => {
    const { userKey, server } = await setup(false)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(res.error?.name).toBe('NotEnrolled')
  })

  it('token targeting a different space → InvalidToken', async () => {
    const { userKey, server } = await setup(true)
    const otherSpace = makeSpaceUri(
      SERVICE_DID,
      'app.bsky.feed.generator',
      'otherspace',
    )
    const token = await mintDelegation({
      userKey,
      iss: userKey.did(),
      sub: otherSpace,
    })
    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(res.error?.name).toBe('InvalidToken')
  })

  it.each([
    ['wrong typ', { typ: 'nope+jwt' }],
    ['wrong alg', { alg: 'HS256' }],
    ['wrong kid', { kid: '#atproto_pns' }],
    ['wrong aud', { aud: 'did:web:evil#atproto_space_host' }],
    [
      'expired',
      {
        iat: Math.floor(Date.now() / 1000) - 1000,
        exp: Math.floor(Date.now() / 1000) - 500,
      },
    ],
    ['tampered signature', { tamper: true }],
    [
      'foreign sub space did',
      {
        sub: makeSpaceUri(
          'did:web:evil.example',
          'app.bsky.feed.generator',
          'myspace',
        ),
      },
    ],
  ])(
    'delegation failure (%s) surfaces as InvalidToken',
    async (_label, overrides) => {
      const { userKey, server } = await setup(true)
      const token = await mintDelegation({
        userKey,
        iss: userKey.did(),
        ...overrides,
      })
      const res = await invoke(server, {
        space: SPACE_URI,
        delegationToken: token,
      })
      expect(res.error?.name).toBe('InvalidToken')
    },
  )

  it('malformed (non-JWT) delegation token → InvalidToken', async () => {
    const { server } = await setup(true)
    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: 'garbage',
    })
    expect(res.error?.name).toBe('InvalidToken')
  })

  it('delegation path unavailable when no replay store configured → InvalidToken', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const userKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
      idResolver: atprotoResolver(userKey.did(), userKey),
      cache: undefined,
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(res.error?.name).toBe('InvalidToken')
  })
})
