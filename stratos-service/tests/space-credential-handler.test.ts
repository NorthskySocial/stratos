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
import { P256Keypair, Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import {
  createServiceJwt,
  type Server as XrpcServer,
} from '@atproto/xrpc-server'
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
  delegationToken?: string
  /** Request shape (method/url/headers) for mint-time DPoP proof checks. */
  req?: {
    rawHeaders?: string[]
    method?: string
    /** The full path, as Express keeps it when a router rewrites `url`. */
    originalUrl?: string
    url?: string
    headers?: Record<string, string | string[] | undefined>
  }
}

async function invoke(
  server: MockXrpcServer,
  input: Record<string, unknown> | undefined,
  authDid?: string,
  opts?: InvokeOptions,
): Promise<InvokeResult> {
  const auth = authDid
    ? { credentials: { type: 'user', did: authDid, jkt: opts?.jkt } }
    : opts?.delegationToken
      ? {
          credentials: {
            type: 'delegation',
            delegationToken: opts.delegationToken,
          },
        }
      : { credentials: { type: 'anonymous' } }
  return invokeHandler(server, input, auth, opts?.req)
}

async function invokeUnauthenticated(
  server: MockXrpcServer,
  input: Record<string, unknown> | undefined,
  req?: InvokeOptions['req'],
): Promise<InvokeResult> {
  return invokeHandler(server, input, undefined, req)
}

async function invokeHandler(
  server: MockXrpcServer,
  input: Record<string, unknown> | undefined,
  auth: unknown,
  req?: InvokeOptions['req'],
): Promise<InvokeResult> {
  const method = server.methods['zone.stratos.space.getSpaceCredential']
  if (!method) throw new Error('method not registered')
  try {
    const result = await method.handler({
      input: input && { body: input, encoding: 'application/json' },
      params: {},
      auth,
      req,
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
      resolve: vi.fn(async (requestedDid: string) =>
        requestedDid === did
          ? {
              id: did,
              verificationMethod: [
                {
                  id: `${did}#atproto`,
                  type: 'Multikey',
                  controller: did,
                  publicKeyMultibase: keypair.did().slice('did:key:'.length),
                },
              ],
            }
          : null,
      ),
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
      spaceCredentialMint: optionalStandard,
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
  claims: { nonce?: string; ath?: string } = {},
): Promise<{ proof: string; jkt: string }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const jwk = await exportJWK(publicKey)
  const jkt = await calculateJwkThumbprint(jwk)
  const proof = await new SignJWT({
    htm: 'POST',
    htu,
    jti: randomUUID(),
    ...claims,
  })
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
  it('rejects a missing body and missing authentication', async () => {
    const signingKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({ signingKey })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as unknown as XrpcServer, ctx)
    expect((await invokeUnauthenticated(server, undefined)).error?.name).toBe(
      'InvalidRequest',
    )
    expect(
      (await invokeUnauthenticated(server, { space: SPACE_URI })).error?.name,
    ).toBe('AuthRequired')
  })

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

  it('exchanges a Bearer delegation with a standalone DPoP proof', async () => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey })
    const { proof, jkt } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const res = await invoke(server, { space: SPACE_URI }, undefined, {
      delegationToken: token,
      req: {
        method: 'POST',
        originalUrl: MINT_PATH,
        headers: { authorization: `Bearer ${token}`, dpop: proof },
      },
    })
    expect(res.error).toBeUndefined()
    expect(decodeCredential(res.body!.credential!).payload.cnf).toEqual({ jkt })
  })

  it('rejects simultaneous header and body delegations before consuming either', async () => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey })
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const ambiguous = await invoke(
      server,
      { space: SPACE_URI, delegationToken: token },
      undefined,
      {
        delegationToken: token,
        req: {
          method: 'POST',
          originalUrl: MINT_PATH,
          headers: { authorization: `Bearer ${token}`, dpop: proof },
        },
      },
    )
    expect(ambiguous.error?.name).toBe('InvalidRequest')
    expect(ambiguous.error?.message).toBe(
      'Use one delegation transport per request',
    )

    const retry = await invoke(server, { space: SPACE_URI }, undefined, {
      delegationToken: token,
      req: { method: 'POST', originalUrl: MINT_PATH, headers: { dpop: proof } },
    })
    expect(retry.error).toBeUndefined()
  })

  it('rejects body delegation combined with DPoP session identity, then accepts body-only retry', async () => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey })
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const ambiguous = await invoke(
      server,
      { space: SPACE_URI, delegationToken: token },
      USER_DID,
      {
        jkt: 'thumb-rei',
        req: {
          method: 'POST',
          originalUrl: MINT_PATH,
          headers: { authorization: 'DPoP session-access-token', dpop: proof },
        },
      },
    )
    expect(ambiguous.error?.name).toBe('InvalidRequest')
    expect(ambiguous.error?.message).toBe(
      'Use one delegation transport per request',
    )

    const bodyOnly = await invoke(
      server,
      { space: SPACE_URI, delegationToken: token },
      undefined,
      {
        req: {
          method: 'POST',
          originalUrl: MINT_PATH,
          headers: { dpop: proof },
        },
      },
    )
    expect(bodyOnly.error).toBeUndefined()
    expect(bodyOnly.body?.credential).toBeTruthy()
  })

  it.each([
    {
      label: 'an empty Authorization header',
      input: { space: SPACE_URI, delegationToken: '' },
      req: { headers: { authorization: '' } },
    },
    {
      label: 'an empty body delegation',
      input: { space: SPACE_URI, delegationToken: '' },
      req: { headers: { authorization: 'DPoP session-access-token' } },
    },
  ])(
    'rejects $label as ambiguous delegation transport',
    async ({ input, req }) => {
      const { server } = await setup(true)
      const response = await invoke(server, input, undefined, { req })
      expect(response.error?.name).toBe('InvalidRequest')
      expect(response.error?.message).toBe(
        'Use one delegation transport per request',
      )
    },
  )

  it('rejects an invalid Bearer token without consuming a valid retry', async () => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, typ: 'at+jwt' })
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const res = await invoke(server, { space: SPACE_URI }, undefined, {
      delegationToken: token,
      req: { method: 'POST', originalUrl: MINT_PATH, headers: { dpop: proof } },
    })
    expect(res.error?.name).toBe('InvalidToken')
  })

  it('rejects a valid signed service-auth Bearer JWT as a delegation', async () => {
    const { server, ctx } = await setup(true)
    const serviceKey = await Secp256k1Keypair.create({ exportable: true })
    const token = await createServiceJwt({
      iss: serviceKey.did(),
      aud: SERVICE_DID,
      lxm: 'zone.stratos.space.getSpaceCredential',
      keypair: serviceKey,
    })
    const [header, payload, signature] = token.split('.')
    expect(
      await verifySignature(
        serviceKey.did(),
        new TextEncoder().encode(`${header}.${payload}`),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)

    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const response = await invoke(server, { space: SPACE_URI }, undefined, {
      delegationToken: token,
      req: {
        method: 'POST',
        originalUrl: MINT_PATH,
        headers: { authorization: `Bearer ${token}`, dpop: proof },
      },
    })
    expect(response.error?.name).toBe('InvalidToken')
    expect(ctx.logger?.info).toHaveBeenCalledWith(
      { err: expect.stringContaining('Invalid delegation token typ') },
      'space-credential delegation token rejected',
    )
  })

  it('does not consume a header delegation when app access rejects it', async () => {
    const { userKey, server, ctx } = await setup(true)
    ctx.cfg.stratos.spaceAppAccess = {
      byBoundary: new Map([
        [
          SPACE_BOUNDARY,
          { kind: 'allowList', clientIds: ['https://nerv.test'] },
        ],
      ]),
    }
    const token = await mintDelegation({ userKey })
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const present = () =>
      invoke(server, { space: SPACE_URI }, undefined, {
        delegationToken: token,
        req: {
          method: 'POST',
          originalUrl: MINT_PATH,
          headers: { authorization: `Bearer ${token}`, dpop: proof },
        },
      })
    expect((await present()).error?.name).toBe('AttestationRequired')
    ctx.cfg.stratos.spaceAppAccess.byBoundary.set(SPACE_BOUNDARY, {
      kind: 'open',
    })
    expect((await present()).error).toBeUndefined()
  })

  it.each([
    ['wrong type', { typ: 'at+jwt' }],
    ['wrong issuer', { iss: 'did:plc:rei' }],
    ['wrong audience', { aud: 'did:web:other.test#atproto_space_host' }],
    [
      'wrong space',
      { sub: makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'other') },
    ],
    [
      'expired',
      {
        iat: Math.floor(Date.now() / 1000) - 1000,
        exp: Math.floor(Date.now() / 1000) - 500,
      },
    ],
    ['bad signature', { tamper: true }],
  ])('rejects a header delegation with %s', async (_reason, overrides) => {
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, ...overrides })
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    const response = await invoke(server, { space: SPACE_URI }, undefined, {
      delegationToken: token,
      req: { method: 'POST', originalUrl: MINT_PATH, headers: { dpop: proof } },
    })
    expect(response.error?.name).toBe('InvalidToken')
  })

  it.each([{ nonce: 'old-nonce' }, { ath: 'unbound-token' }])(
    'rejects a mint proof carrying $nonce$ath without consuming the delegation',
    async (claims) => {
      const { userKey, server, ctx } = await setup(true)
      const token = await mintDelegation({ userKey })
      const bad = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`, claims)
      const rejected = await invoke(server, { space: SPACE_URI }, undefined, {
        delegationToken: token,
        req: {
          method: 'POST',
          originalUrl: MINT_PATH,
          headers: { dpop: bad.proof },
        },
      })
      expect(rejected.error?.name).toBe('ProofRequired')
      if ('nonce' in claims) {
        expect(ctx.logger?.info).toHaveBeenCalledWith(
          { err: 'Mint proof must omit nonce' },
          'space-credential mint proof rejected',
        )
      }
      const good = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
      const retry = await invoke(server, { space: SPACE_URI }, undefined, {
        delegationToken: token,
        req: {
          method: 'POST',
          originalUrl: MINT_PATH,
          headers: { dpop: good.proof },
        },
      })
      expect(retry.error).toBeUndefined()
    },
  )

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

  it('accepts a proof when Express has rewritten url behind the router', async () => {
    // Express sets `url` relative to the router's mount point and keeps the
    // full path on `originalUrl`. A proof covers the full path, so reading
    // `url` alone drops the `/xrpc` prefix and every mint fails.
    const { userKey, server } = await setup(true)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)

    const res = await invoke(
      server,
      { space: SPACE_URI, delegationToken: token },
      undefined,
      {
        req: {
          method: 'POST',
          url: '/zone.stratos.space.getSpaceCredential',
          originalUrl: MINT_PATH,
          headers: { dpop: proof },
        },
      },
    )

    expect(res.error).toBeUndefined()
    expect(res.body?.credential).toBeTruthy()
  })

  it('rejects a valid token WITHOUT a mint-time DPoP proof → ProofRequired', async () => {
    const { userKey, server, ctx } = await setup(true)
    const token = await mintDelegation({ userKey, iss: userKey.did() })
    const res = await invoke(server, {
      space: SPACE_URI,
      delegationToken: token,
    })
    expect(res.error?.name).toBe('ProofRequired')
    expect(ctx.logger?.info).toHaveBeenLastCalledWith(
      { err: 'DPoP proof required' },
      'space-credential mint proof rejected',
    )
  })

  it('rejects a body delegation with absent request headers without an ambiguity error', async () => {
    const { userKey, server, ctx } = await setup(true)
    const token = await mintDelegation({ userKey })
    const res = await invoke(
      server,
      { space: SPACE_URI, delegationToken: token },
      undefined,
      { req: { method: 'POST', url: MINT_PATH } },
    )
    expect(res.error?.name).toBe('ProofRequired')
    expect(ctx.logger?.info).toHaveBeenLastCalledWith(
      { err: 'DPoP proof required' },
      'space-credential mint proof rejected',
    )
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

async function makeExchangeRequest(
  token: string,
  key: Keypair,
): Promise<NonNullable<InvokeOptions['req']>> {
  const authorization = `Bearer ${token}`
  const params = `("authorization");keyid="${key.did()}"`
  const signature = await key.sign(
    new TextEncoder().encode(
      `"authorization": ${authorization}\n"@signature-params": ${params}`,
    ),
  )
  const headers = {
    authorization,
    'signature-input': `atproto-space=${params}`,
    signature: `atproto-space=:${Buffer.from(signature).toString('base64')}:`,
  }
  return {
    method: 'POST',
    originalUrl: MINT_PATH,
    headers,
    rawHeaders: Object.entries(headers).flat(),
  }
}

describe('getSpaceCredential — HTTP signature coexistence', () => {
  async function setup() {
    const signingKey = await Secp256k1Keypair.create()
    const userKey = await Secp256k1Keypair.create()
    const ctx = createMockCtx({
      signingKey,
      enrolledBoundaries: [SPACE_BOUNDARY],
      idResolver: atprotoResolver(userKey.did(), userKey),
    })
    const server = createMockXrpcServer()
    registerSpaceCredentialHandlers(server as unknown as XrpcServer, ctx)
    const token = await mintDelegation({ userKey })
    const key = await P256Keypair.create()
    const req = await makeExchangeRequest(token, key)
    const present = (request = req) =>
      invoke(server, { space: SPACE_URI }, undefined, {
        delegationToken: token,
        req: request,
      })
    return { ctx, server, token, key, req, present, signingKey }
  }

  it.each(['signature', 'signature-input'])(
    'dispatches a lone raw %s without legacy fallback',
    async (name) => {
      const { req, present } = await setup()
      const broken = {
        ...req,
        headers: { authorization: req.headers!.authorization },
        rawHeaders: [
          'Authorization',
          req.headers!.authorization as string,
          name,
          'invalid',
        ],
      }
      expect((await present(broken)).error).toEqual({
        name: 'ProofRequired',
        message: 'A valid HTTP signature is required',
      })
      expect((await present()).error).toBeUndefined()
    },
  )

  it.each(['Bearer invalid extra', 'prefix Bearer invalid', 'Bearer'])(
    'rejects malformed normalized authorization %s',
    async (authorization) => {
      const { req, present } = await setup()
      expect(
        (await present({ ...req, headers: { ...req.headers, authorization } }))
          .error,
      ).toEqual({
        name: 'InvalidRequest',
        message: 'Conflicting mint proof families',
      })
      expect((await present()).error).toBeUndefined()
    },
  )

  it.each(['prefix', 'suffix'])(
    'rejects a %s around the resolved normalized Bearer token',
    async (side) => {
      const { token, req, present } = await setup()
      const authorization =
        side === 'prefix' ? `rei Bearer ${token}` : `Bearer ${token} rei`
      expect(
        (await present({ ...req, headers: { ...req.headers, authorization } }))
          .error,
      ).toEqual({
        name: 'InvalidRequest',
        message: 'Conflicting mint proof families',
      })
      expect((await present()).error).toBeUndefined()
    },
  )

  it('rejects raw signature headers without normalized headers or credentials', async () => {
    const { server, req, present } = await setup()
    expect((await present({ ...req, headers: undefined })).error).toEqual({
      name: 'InvalidRequest',
      message: 'Conflicting mint proof families',
    })
    expect(
      (await invokeUnauthenticated(server, { space: SPACE_URI }, req)).error,
    ).toEqual({
      name: 'InvalidRequest',
      message: 'Conflicting mint proof families',
    })
  })

  it('rejects a body delegation with signed header identity even without normalized authorization', async () => {
    const { server, token, req } = await setup()
    const headers = { ...req.headers }
    delete headers.authorization
    expect(
      (
        await invokeHandler(
          server,
          { space: SPACE_URI, delegationToken: token },
          { credentials: { delegationToken: token } },
          { ...req, headers },
        )
      ).error,
    ).toEqual({
      name: 'InvalidRequest',
      message: 'Conflicting mint proof families',
    })
  })

  it.each(['signature', 'signature-input'])(
    'does not dispatch a legacy session when a raw value equals %s',
    async (value) => {
      const { server } = await setup()
      const result = await invoke(server, { space: SPACE_URI }, USER_DID, {
        jkt: 'thumb-rei',
        req: { rawHeaders: ['X-Rei', value] },
      })
      expect(result.error).toBeUndefined()
      expect(decodeCredential(result.body!.credential!).payload.cnf).toEqual({
        jkt: 'thumb-rei',
      })
    },
  )

  it('rejects a session thumbprint even when a delegation is also resolved', async () => {
    const { server, token, req } = await setup()
    const result = await invokeHandler(
      server,
      { space: SPACE_URI },
      { credentials: { delegationToken: token, jkt: 'rei' } },
      req,
    )
    expect(result.error).toEqual({
      name: 'InvalidRequest',
      message: 'Conflicting mint proof families',
    })
  })

  it('accepts raw header whitespace and unrelated headers before authorization', async () => {
    const { req, present } = await setup()
    const rawHeaders = ['X-Rei', 'authorization', ...req.rawHeaders!]
    rawHeaders[3] = ` \t${rawHeaders[3]}\t `
    expect((await present({ ...req, rawHeaders })).error).toBeUndefined()
  })

  it.each([undefined, 1, 3_600])(
    'mints kid without aud using only the new TTL %s',
    async (ttl) => {
      const { ctx, present, key, signingKey } = await setup()
      ctx.cfg.stratos.spaceHttpCredentialTtlSeconds = ttl
      ctx.cfg.stratos.spaceCredentialTtlSeconds = 86_400
      const res = await present()
      expect(res.error).toBeUndefined()
      const { payload } = decodeCredential(res.body!.credential!)
      expect(payload.cnf).toEqual({ kid: key.did() })
      expect(payload).not.toHaveProperty('aud')
      expect(payload.jti).toEqual(expect.any(String))
      expect(payload.jti.length).toBeGreaterThan(0)
      expect(payload.iat).toBeGreaterThan(0)
      expect(payload.exp - payload.iat).toBe(ttl ?? 600)
      expect(res.body!.expiresAt).toBe(
        new Date(payload.exp * 1000).toISOString(),
      )
      expect(
        await verifyCredentialAgainst(signingKey.did(), res.body!.credential!),
      ).toBe(true)
      expect((await present()).error?.name).toBe('InvalidToken')
    },
  )

  it.each([
    'signature',
    'signature-input',
    'rawHeaders',
    'changed token',
    'duplicate authorization',
  ])(
    'rejects %s without spending delegation or falling back',
    async (failure) => {
      const { req, present } = await setup()
      const broken = {
        ...req,
        headers: { ...req.headers },
        rawHeaders: [...req.rawHeaders!],
      }
      if (failure === 'rawHeaders') broken.rawHeaders = []
      else if (failure === 'changed token') {
        broken.rawHeaders[1] += 'tampered'
      } else if (failure === 'duplicate authorization') {
        broken.rawHeaders.push(
          'Authorization',
          broken.headers.authorization as string,
        )
      } else {
        broken.headers[failure] = 'invalid'
        const index = broken.rawHeaders.indexOf(failure)
        broken.rawHeaders[index + 1] = 'invalid'
      }
      expect((await present(broken)).error?.name).toBe('ProofRequired')
      expect((await present()).error).toBeUndefined()
    },
  )

  it('rejects mixed DPoP/signature then allows the same token with one profile', async () => {
    const { req, present } = await setup()
    const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
    expect(
      (await present({ ...req, headers: { ...req.headers, dpop: proof } }))
        .error?.name,
    ).toBe('InvalidRequest')
    expect((await present()).error).toBeUndefined()
  })

  it('rejects body and session signature combinations', async () => {
    const { server, token, req } = await setup()
    expect(
      (
        await invoke(
          server,
          { space: SPACE_URI, delegationToken: token },
          undefined,
          { req },
        )
      ).error?.name,
    ).toBe('InvalidRequest')
    expect(
      (
        await invoke(server, { space: SPACE_URI }, USER_DID, {
          req,
          jkt: 'rei',
        })
      ).error?.name,
    ).toBe('InvalidRequest')
  })

  it.each(['member', 'inactive', 'app'])(
    'does not spend delegation on a failed %s gate',
    async (gate) => {
      const { ctx, present } = await setup()
      if (gate === 'member')
        vi.mocked(ctx.enrollmentStore.getBoundaries).mockResolvedValueOnce([])
      if (gate === 'inactive')
        vi.mocked(ctx.enrollmentStore.getEnrollment).mockResolvedValueOnce(null)
      if (gate === 'app')
        ctx.cfg.stratos.spaceAppAccess = {
          byBoundary: new Map([
            [
              SPACE_BOUNDARY,
              { kind: 'allowList', clientIds: ['https://nerv.test'] },
            ],
          ]),
        }
      expect((await present()).error?.name).toBe(
        gate === 'app' ? 'AttestationRequired' : 'NotEnrolled',
      )
      ctx.cfg.stratos.spaceAppAccess = { byBoundary: new Map() }
      expect((await present()).error).toBeUndefined()
    },
  )

  it.each(['http first', 'legacy first'])(
    'shares one delegation replay store: %s',
    async (order) => {
      const { server, token, present } = await setup()
      const { proof } = await makeMintProof(`${PUBLIC_URL}${MINT_PATH}`)
      const legacy = () =>
        invoke(
          server,
          { space: SPACE_URI, delegationToken: token },
          undefined,
          {
            req: {
              method: 'POST',
              originalUrl: MINT_PATH,
              headers: { dpop: proof },
            },
          },
        )
      const first = order === 'http first' ? present : legacy
      const second = order === 'http first' ? legacy : present
      expect((await first()).error).toBeUndefined()
      expect((await second()).error?.name).toBe('InvalidToken')
    },
  )

  it('rejects a valid signature over a different delegation than the resolved identity', async () => {
    const { token, present, key } = await setup()
    const other = await makeExchangeRequest(`${token}changed`, key)
    other.headers!.authorization = `Bearer ${token}`
    expect((await present(other)).error?.name).toBe('ProofRequired')
    expect((await present()).error).toBeUndefined()
  })

  it('rejects raw-only DPoP conflicts and never treats a failed signature as dev auth', async () => {
    const { ctx, present, req } = await setup()
    ctx.cfg.stratos.devMode = true
    expect(
      (
        await present({
          ...req,
          rawHeaders: [...req.rawHeaders!, 'DPoP', 'rei'],
        })
      ).error?.name,
    ).toBe('InvalidRequest')
    expect((await present({ ...req, rawHeaders: [] })).error?.name).toBe(
      'ProofRequired',
    )
    expect((await present()).error).toBeUndefined()
  })

  it('admits exactly one concurrent exchange', async () => {
    const { present } = await setup()
    const results = await Promise.all([present(), present()])
    expect(results.filter((result) => result.body?.credential)).toHaveLength(1)
    expect(
      results.filter((result) => result.error?.name === 'InvalidToken'),
    ).toHaveLength(1)
  })
})
