/**
 * Contract tests for the space-delegation token verifier and the jti replay
 * store.
 *
 * These modules are dormant (wired to nothing yet); the contract these tests
 * pin down IS the deliverable. We mint delegation JWTs with local keypairs and
 * a hand-built header/payload so we can exercise every distinct rejection path
 * — including the two-phase guarantee that verification never burns the jti;
 * only the explicit `consumeDelegationJti` step does.
 */
import { describe, expect, it, vi } from 'vitest'
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import type { Keypair } from '@atproto/crypto'
import {
  consumeDelegationJti,
  DelegationReplayError,
  DelegationTimingError,
  DELEGATION_REPLAY_KIND,
  DELEGATION_REPLAY_TTL,
  DELEGATION_TYP,
  ForeignSpaceDidError,
  InvalidDelegationAlgError,
  InvalidDelegationAudError,
  InvalidDelegationKidError,
  InvalidDelegationSignatureError,
  InvalidDelegationSubError,
  InvalidDelegationTypError,
  MalformedDelegationTokenError,
  verifyDelegationToken,
} from '../src/infra/auth/delegation-verifier.js'
import { ReplayStore, type NxExStore } from '../src/infra/auth/replay-store.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:stratos.test'
const SPACE_URI = makeSpaceUri(
  SERVICE_DID,
  'app.bsky.feed.generator',
  'myspace',
)
const AUD = `${SERVICE_DID}#atproto_space_host`

// ---------------------------------------------------------------------------
// In-memory NX-EX store + replay store helpers
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory `NxExStore` that mimics `SET NX EX` semantics: the first
 * set for a key succeeds, subsequent sets fail. TTL is recorded but not expired
 * (tests don't need wall-clock expiry).
 */
class MemoryNxExStore implements NxExStore {
  readonly keys = new Map<string, { value: string; ttl: number }>()
  async setNxEx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (this.keys.has(key)) return false
    this.keys.set(key, { value, ttl: ttlSeconds })
    return true
  }
}

/** An NX-EX store that always rejects, simulating an unavailable Redis. */
class DownNxExStore implements NxExStore {
  async setNxEx(): Promise<boolean> {
    throw new Error('ECONNREFUSED')
  }
}

// ---------------------------------------------------------------------------
// Token minting (hand-built compact JWT so we control typ/alg/kid/payload)
// ---------------------------------------------------------------------------

const b64url = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url')

interface MintOpts {
  keypair: Keypair
  typ?: string
  alg?: string
  kid?: string
  iss?: string
  sub?: string
  aud?: string
  iat?: number
  exp?: number
  jti?: string
  /** If set, corrupt the signature after signing. */
  tamperSignature?: boolean
}

let jtiCounter = 0
const freshJti = (): string => `jti-${Date.now()}-${jtiCounter++}`

/** Mint a delegation JWT signed by `keypair`, with per-field overrides. */
async function mintToken(opts: MintOpts): Promise<string> {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000)
  const header = {
    typ: opts.typ ?? DELEGATION_TYP,
    alg: opts.alg ?? opts.keypair.jwtAlg,
    kid: opts.kid ?? '#atproto',
  }
  const payload = {
    iss: opts.iss ?? opts.keypair.did(),
    sub: opts.sub ?? SPACE_URI,
    aud: opts.aud ?? AUD,
    iat,
    exp: opts.exp ?? iat + 60,
    jti: opts.jti ?? freshJti(),
  }
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const sig = await opts.keypair.sign(new TextEncoder().encode(signingInput))
  let sigStr = Buffer.from(sig).toString('base64url')
  if (opts.tamperSignature) {
    // Re-sign a different input so the signature is structurally valid but wrong.
    const badSig = await opts.keypair.sign(
      new TextEncoder().encode(`${signingInput}.tampered`),
    )
    sigStr = Buffer.from(badSig).toString('base64url')
  }
  return `${signingInput}.${sigStr}`
}

// ---------------------------------------------------------------------------
// Mock IdResolver returning a DID doc with a chosen set of verification methods
// ---------------------------------------------------------------------------

interface VmSpec {
  /** Fragment (e.g. '#atproto', '#atproto_pns'). */
  fragment: string
  keypair: Keypair
}

/**
 * Build a mock IdResolver whose resolved DID document for `did` contains a
 * verification method per `vms`. Uses the `Multikey` type + did:key multibase,
 * matching the existing service-auth test's approach so signature verification
 * routes through the real crypto path.
 */
function createMockIdResolver(did: string, vms: VmSpec[]): IdResolver {
  return {
    did: {
      resolve: vi.fn().mockResolvedValue({
        id: did,
        verificationMethod: vms.map((vm) => ({
          id: `${did}${vm.fragment}`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: vm.keypair.did().slice('did:key:'.length),
        })),
      }),
    },
  } as unknown as IdResolver
}

/** Standard single-#atproto-method resolver for the given keypair. */
function atprotoResolver(keypair: Keypair): IdResolver {
  return createMockIdResolver(keypair.did(), [
    { fragment: '#atproto', keypair },
  ])
}

function makeDeps(
  keypair: Keypair,
  overrides: Partial<Parameters<typeof verifyDelegationToken>[1]> = {},
) {
  return {
    serviceDid: SERVICE_DID,
    idResolver: atprotoResolver(keypair),
    ...overrides,
  }
}

// ===========================================================================
// ReplayStore
// ===========================================================================

describe('ReplayStore.consumeOnce', () => {
  it('returns true exactly once per (kind, jti), false thereafter', async () => {
    const store = new ReplayStore(new MemoryNxExStore())
    expect(await store.consumeOnce('space-delegation', 'n1', 120)).toBe(true)
    expect(await store.consumeOnce('space-delegation', 'n1', 120)).toBe(false)
    expect(await store.consumeOnce('space-delegation', 'n1', 120)).toBe(false)
  })

  it('namespaces by kind (same jti under a different kind is independent)', async () => {
    const store = new ReplayStore(new MemoryNxExStore())
    expect(await store.consumeOnce('space-delegation', 'shared', 120)).toBe(
      true,
    )
    expect(await store.consumeOnce('other-kind', 'shared', 120)).toBe(true)
  })

  it('passes the TTL through to the underlying NX-EX set', async () => {
    const mem = new MemoryNxExStore()
    const store = new ReplayStore(mem)
    await store.consumeOnce('space-delegation', 'n1', 120)
    expect(mem.keys.get('replay:space-delegation:n1')?.ttl).toBe(120)
  })

  it('fails closed (returns false + logs) when the store is unavailable', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const store = new ReplayStore(new DownNxExStore(), logger)
    expect(await store.consumeOnce('space-delegation', 'n1', 120)).toBe(false)
    expect(logger.error).toHaveBeenCalled()
  })
})

// ===========================================================================
// verifyDelegationToken — happy path & single-use
// ===========================================================================

describe('verifyDelegationToken (happy path & replay)', () => {
  it('accepts a valid delegation token and returns userDid + spaceUri', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({ keypair })

    const result = await verifyDelegationToken(token, makeDeps(keypair))

    expect(result.userDid).toBe(keypair.did())
    expect(result.spaceUri).toBe(SPACE_URI)
  })

  it('accepts an ES256 (P-256) signed token', async () => {
    const keypair = await P256Keypair.create({ exportable: true })
    const token = await mintToken({ keypair })

    const result = await verifyDelegationToken(token, makeDeps(keypair))
    expect(result.userDid).toBe(keypair.did())
  })

  it('returns the token jti without consuming it', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const jti = freshJti()
    const token = await mintToken({ keypair, jti })

    const result = await verifyDelegationToken(token, makeDeps(keypair))
    expect(result.jti).toBe(jti)
  })

  it('consumeDelegationJti accepts once, then rejects the second use as a replay', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const replayStore = new ReplayStore(new MemoryNxExStore())
    const token = await mintToken({ keypair })

    const { jti } = await verifyDelegationToken(token, makeDeps(keypair))
    await expect(
      consumeDelegationJti(replayStore, jti),
    ).resolves.toBeUndefined()
    await expect(consumeDelegationJti(replayStore, jti)).rejects.toBeInstanceOf(
      DelegationReplayError,
    )
  })
})

// ===========================================================================
// verifyDelegationToken — each violation → its distinct error
// ===========================================================================

describe('verifyDelegationToken (distinct rejection per violation)', () => {
  it('rejects a structurally malformed token', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    await expect(
      verifyDelegationToken('not.a.jwt.at.all', makeDeps(keypair)),
    ).rejects.toBeInstanceOf(MalformedDelegationTokenError)
  })

  it('rejects a wrong typ', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({ keypair, typ: 'JWT' })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(InvalidDelegationTypError)
  })

  it('rejects an alien alg', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({ keypair, alg: 'RS256' })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(InvalidDelegationAlgError)
  })

  it('rejects a wrong kid', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({ keypair, kid: '#atproto_pns' })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(InvalidDelegationKidError)
  })

  it('rejects a sub that is not a space URI', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({
      keypair,
      sub: 'https://example.com/not-a-space',
    })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(InvalidDelegationSubError)
  })

  it('rejects a sub for a foreign spaceDid', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({
      keypair,
      sub: makeSpaceUri(
        'did:web:other.authority',
        'app.bsky.feed.generator',
        'space',
      ),
    })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(ForeignSpaceDidError)
  })

  it('rejects a wrong aud', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({
      keypair,
      aud: `${SERVICE_DID}#wrong_fragment`,
    })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(InvalidDelegationAudError)
  })

  it('rejects an expired token (beyond skew)', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const past = Math.floor(Date.now() / 1000) - 1000
    const token = await mintToken({ keypair, iat: past, exp: past + 60 })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(DelegationTimingError)
  })

  it('rejects a future iat beyond skew', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const future = Math.floor(Date.now() / 1000) + 1000
    const token = await mintToken({ keypair, iat: future, exp: future + 60 })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(DelegationTimingError)
  })

  it('rejects a bad signature', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const token = await mintToken({ keypair, tamperSignature: true })
    await expect(
      verifyDelegationToken(token, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(InvalidDelegationSignatureError)
  })

  it('rejects a token signed by a different key than the DID doc #atproto method', async () => {
    const issuerKey = await Secp256k1Keypair.create({ exportable: true })
    const attackerKey = await Secp256k1Keypair.create({ exportable: true })
    // DID doc has issuerKey under #atproto; token is signed by attackerKey but
    // still claims iss = issuerKey.did().
    const token = await mintToken({
      keypair: attackerKey,
      iss: issuerKey.did(),
    })
    await expect(
      verifyDelegationToken(token, makeDeps(issuerKey)),
    ).rejects.toBeInstanceOf(InvalidDelegationSignatureError)
  })

  it('rejects a signature made by a NON-#atproto key present in the same DID doc', async () => {
    // The DID doc contains two methods: #atproto (atprotoKey) and #atproto_pns
    // (otherKey). The token is signed by otherKey. Even though otherKey is a
    // valid method in the document, only #atproto may be accepted.
    const iss = 'did:web:user.test'
    const atprotoKey = await Secp256k1Keypair.create({ exportable: true })
    const otherKey = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(iss, [
      { fragment: '#atproto', keypair: atprotoKey },
      { fragment: '#atproto_pns', keypair: otherKey },
    ])
    const token = await mintToken({ keypair: otherKey, iss })

    await expect(
      verifyDelegationToken(token, {
        serviceDid: SERVICE_DID,
        idResolver,
      }),
    ).rejects.toBeInstanceOf(InvalidDelegationSignatureError)
  })

  it('accepts a signature made by the #atproto key when other methods also exist', async () => {
    // Sanity mirror of the above: signing with #atproto succeeds even though a
    // second method is present.
    const iss = 'did:web:user2.test'
    const atprotoKey = await Secp256k1Keypair.create({ exportable: true })
    const otherKey = await Secp256k1Keypair.create({ exportable: true })
    const idResolver = createMockIdResolver(iss, [
      { fragment: '#atproto_pns', keypair: otherKey },
      { fragment: '#atproto', keypair: atprotoKey },
    ])
    const token = await mintToken({ keypair: atprotoKey, iss })

    await expect(
      verifyDelegationToken(token, {
        serviceDid: SERVICE_DID,
        idResolver,
      }),
    ).resolves.toMatchObject({ userDid: iss })
  })
})

// ===========================================================================
// Redis-down ⇒ reject
// ===========================================================================

describe('consumeDelegationJti (replay store unavailable)', () => {
  it('rejects when the replay store is down (fail closed)', async () => {
    const replayStore = new ReplayStore(new DownNxExStore())
    await expect(
      consumeDelegationJti(replayStore, freshJti()),
    ).rejects.toBeInstanceOf(DelegationReplayError)
  })
})

// ===========================================================================
// Two-phase proof: verification never consumes the jti; consume does
// ===========================================================================

describe('verifyDelegationToken / consumeDelegationJti (two-phase)', () => {
  it('verification (pass OR fail) leaves the jti unconsumed; consumeDelegationJti burns it with the correct TTL', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const mem = new MemoryNxExStore()
    const replayStore = new ReplayStore(mem)
    const sharedJti = freshJti()
    const replayKey = `replay:${DELEGATION_REPLAY_KIND}:${sharedJti}`

    // 1. An otherwise-valid token with a bad signature and the shared jti.
    const badToken = await mintToken({
      keypair,
      jti: sharedJti,
      tamperSignature: true,
    })
    await expect(
      verifyDelegationToken(badToken, makeDeps(keypair)),
    ).rejects.toBeInstanceOf(InvalidDelegationSignatureError)
    expect(mem.keys.has(replayKey)).toBe(false)

    // 2. A genuinely valid token bearing the SAME jti verifies — and still
    //    leaves the jti unconsumed.
    const goodToken = await mintToken({ keypair, jti: sharedJti })
    const result = await verifyDelegationToken(goodToken, makeDeps(keypair))
    expect(result.userDid).toBe(keypair.did())
    expect(mem.keys.has(replayKey)).toBe(false)

    // 3. Only the explicit consume step burns it, with the correct TTL.
    await consumeDelegationJti(replayStore, result.jti)
    expect(mem.keys.get(replayKey)?.ttl).toBe(DELEGATION_REPLAY_TTL)
  })
})
