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
 *   - Key binding: the DPoP path binds the session key's `jkt` into `cnf.jkt`;
 *     the delegation path requires a REAL standalone DPoP proof (jose-built,
 *     ES256, embedded JWK) and binds the proof key. An unbound mint is refused
 *     outside dev mode (`ProofRequired`).
 * The issued credential is decoded and verified against the service key (and
 * asserted to FAIL against another key), with the full spec claim set checked
 * including the absence of `aud`, and `exp - iat` equal to the configured TTL.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose'
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
const PUBLIC_URL = 'https://stratos.test'
const MINT_PATH = '/xrpc/zone.stratos.space.getSpaceCredential'
const TTL_SECONDS = 7_200
const SPACE_URI = makeSpaceUri(
  SERVICE_DID,
  'app.bsky.feed.generator',
  'myspace',
)
// boundaryToSpaceUri: boundary "{serviceDid}/{skey}" ⇄ space skey == domainName.
const SPACE_BOUNDARY = `${SERVICE_DID}/myspace`
const USER_DID = 'did:plc:abcabcabcabcabcabcabcabc'

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

interface InvokeOptions {
  /** DPoP session key thumbprint carried on the caller's auth credentials. */
  jkt?: string
  /** Request shape (method/url/headers) for mint-time DPoP proof checks. */
  req?: {
    method?: string
    url?: string
    headers?: Record<string, string | string[] | undefined>
  }
}

async function invoke(
  server: MockXrpcServer,
  input: Record<string, unknown>,
  authDid?: string,
  opts?: InvokeOptions,
): Promise<InvokeResult> {
  const method = server.methods['zone.stratos.space.getSpaceCredential']
  if (!method) throw new Error('method not registered')
  const auth = authDid
    ? { credentials: { type: 'user', did: authDid, jkt: opts?.jkt } }
    : { credentials: { type: 'anonymous' } }
  try {
    const result = await method.handler({
      input: { body: input, encoding: 'application/json' },
      params: {},
      auth,
      req: opts?.req ?? { headers: {} },
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
  /** Dev-mode flag; only dev mode may mint UNBOUND (no cnf) credentials. */
  devMode?: boolean
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
    // Default to a working store: a production mint requires one. Pass an
    // explicit `cache: undefined` to exercise the no-store rejection paths.
    cache: 'cache' in opts ? opts.cache : new MemoryNxExStore(),
    cfg: {
      service: { publicUrl: PUBLIC_URL },
      stratos: {
        spaceCredentialTtlSeconds: TTL_SECONDS,
        ...(opts.devMode === undefined ? {} : { devMode: opts.devMode }),
      },
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

async function makeMintProof(
  htu: string,
): Promise<{ proof: string; jkt: string }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const jwk = await exportJWK(publicKey)
  const jkt = await calculateJwkThumbprint(jwk)
  const proof = await new SignJWT({ htm: 'POST', htu, jti: randomUUID() })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
    .setIssuedAt()
    .sign(privateKey)
  return { proof, jkt }
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

describe('getSpaceCredential — DPoP path', () => {
  it('issues a credential BOUND to the session DPoP key (verifies; no aud; TTL)', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID, {
      jkt: 'thumb-misato',
    })
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
    expect(payload.cnf).toEqual({ jkt: 'thumb-misato' })
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

  it('rejects a jkt-less session outside dev mode with ProofRequired', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error?.name).toBe('ProofRequired')
    expect(res.body).toBeUndefined()
  })

  it('dev mode: mints an UNBOUND credential (no cnf) for a jkt-less session', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
      devMode: true,
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)

    const res = await invoke(server, { space: SPACE_URI }, USER_DID)
    expect(res.error).toBeUndefined()
    const { payload } = decodeCredential(res.body!.credential!)
    expect('cnf' in payload).toBe(false)
  })
})

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
      const before = await invoke(server, { space: SPACE_URI }, USER_DID, {
        jkt: 'thumb-shinji',
      })
      expect(before.error).toBeUndefined()
      expect(before.body?.credential).toBeTruthy()

      await store.updateEnrollment(USER_DID, { active: false })

      const after = await invoke(server, { space: SPACE_URI }, USER_DID, {
        jkt: 'thumb-shinji',
      })
      expect(after.error?.name).toBe('NotEnrolled')
      expect(after.body).toBeUndefined()
    } finally {
      await closeServiceDb(db)
    }
  })
})

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

  it('happy path: valid token + mint proof issues a credential bound to the proof key', async () => {
    const { signingKey, userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const { proof, jkt } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)

    const res = await invoke(
      server,
      { space: SPACE_URI, delegationToken: token },
      undefined,
      { req: { method: 'POST', url: MINT_PATH, headers: { dpop: proof } } },
    )
    expect(res.error).toBeUndefined()
    expect(res.body?.credential).toBeTruthy()
    const { payload } = decodeCredential(res.body!.credential!)
    expect(payload.iss).toBe(SERVICE_DID)
    expect(payload.sub).toBe(SPACE_URI)
    expect('aud' in payload).toBe(false)
    expect(payload.cnf).toEqual({ jkt })
    expect(
      await verifyCredentialAgainst(signingKey.did(), res.body!.credential!),
    ).toBe(true)
  })

  it('rejects a valid token WITHOUT a mint-time DPoP proof → ProofRequired', async () => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(res.error?.name).toBe('ProofRequired')
  })

  it('a request that fails a later gate does NOT burn the token: a retry with the proof succeeds', async () => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, iss: userKey.did() })

    // First presentation fails the mint-proof gate AFTER identity resolution.
    const first = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(first.error?.name).toBe('ProofRequired')

    // The single-use jti was not consumed: the SAME token still mints.
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const second = await invoke(
      server,
      { space: SPACE_URI, delegationToken: token },
      undefined,
      { req: { method: 'POST', url: MINT_PATH, headers: { dpop: proof } } },
    )
    expect(second.error).toBeUndefined()
    expect(second.body?.credential).toBeTruthy()
  })

  it('a successful mint burns the token: replaying it → InvalidToken', async () => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const present = async () => {
      const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
      return invoke(
        server,
        { space: SPACE_URI, delegationToken: token },
        undefined,
        { req: { method: 'POST', url: MINT_PATH, headers: { dpop: proof } } },
      )
    }

    const first = await present()
    expect(first.error).toBeUndefined()

    const second = await present()
    expect(second.error?.name).toBe('InvalidToken')
  })

  it('dev mode: the delegation path STILL requires the mint proof', async () => {
    // Dev mode relaxes only the DPoP-session path (unbound mint). A delegated
    // mint proves key possession with the mint proof, so its absence must
    // reject — never fall back to an unbound credential.
    const signingKey = await Secp256k1Keypair.create()
    const userKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
      idResolver: atprotoResolver(userKey.did(), userKey),
      cache: new MemoryNxExStore(),
      devMode: true,
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as any, ctx)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(res.error?.name).toBe('ProofRequired')
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

  it('production with no replay store → mint refused (InternalServerError)', async () => {
    // A presented credential is replay-checked; with no store the presentation
    // verifier fail-closes, so the mint itself must refuse.
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
    expect(res.error?.name).toBe('InternalServerError')
  })

  it('dev mode with no replay store: delegation path still rejects → InvalidToken', async () => {
    // Dev mode skips the mint guard (unbound Bearer presentation works), but
    // the single-use delegation check still needs a store and fails closed.
    const signingKey = await Secp256k1Keypair.create()
    const userKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
      idResolver: atprotoResolver(userKey.did(), userKey),
      cache: undefined,
      devMode: true,
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
