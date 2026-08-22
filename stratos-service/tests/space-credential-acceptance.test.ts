/**
 * Space-credential acceptance on read/sync endpoints.
 *
 * These tests exercise the COMPOSITION rule end-to-end at the handler layer: a
 * space credential for space S admits the caller to the API surface for S, but
 * the existing per-record boundary gate is UNCHANGED — a credential for S
 * yields records in S ONLY, and only those the gate would release to a member
 * of S. We assert this on the hydration and pull-sync endpoints, plus the
 * verifier-composition routing (DPoP / service paths unchanged; writes reject)
 * and DPoP sender-constrained presentation (cnf.jkt binding, proof replay,
 * Bearer-only-in-dev-mode, fail-closed without a replay store).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from 'jose'
import { Secp256k1Keypair } from '@atproto/crypto'
import { AuthRequiredError } from '@atproto/xrpc-server'
import { encodeRecord, spaceUriToBoundary } from '@northskysocial/stratos-core'

import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import {
  listRecordPathsHandler,
  listRepoOpsHandler,
} from '../src/features/pull-sync/handler.js'
import { registerHydrationHandlers } from '../src/features/index.js'
import { HydrationServiceImpl } from '../src/features/hydration/adapter.js'
import { mintSpaceCredential } from '../src/features/space-credential/minter.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import { ReplayStore, type NxExStore } from '../src/infra/auth/replay-store.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'
import { makeSpaceUri } from './helpers/space-uri.js'
import { decode } from '@atcute/cbor'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
// Space S and a DIFFERENT space T (adversarial), both on THIS service.
const SPACE_S = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'alpha')
const SPACE_T = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'beta')
// Boundaries are the qualified `{serviceDid}/{skey}` form — the production
// canonical form the record boundary gate compares against.
const BOUNDARY_S = spaceUriToBoundary(SPACE_S, SERVICE_DID)
const BOUNDARY_T = spaceUriToBoundary(SPACE_T, SERVICE_DID)
if (!BOUNDARY_S.ok || !BOUNDARY_T.ok) throw new Error('bad test boundary')

const repoDid = 'did:plc:shinji-ikari'

describe('space-credential acceptance', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let signingKey: Secp256k1Keypair
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ctx: any

  beforeEach(async () => {
    dataDir = join(tmpdir(), `stratos-swp07-${randomBytes(8).toString('hex')}`)
    await mkdir(dataDir, { recursive: true })
    const cfg = createTestConfig(dataDir)
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)

    enrollmentStore = new SqliteEnrollmentStore(db)
    actorStore = new StratosActorStore({
      dataDir,
      blobstore: () => createMockBlobStore(),
      cborToRecord: (content) => decode(content) as Record<string, unknown>,
    })
    signingKey = await Secp256k1Keypair.create()

    ctx = {
      cfg,
      actorStore,
      enrollmentStore,
      serviceDid: SERVICE_DID,
      signingKey,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    }
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  // ── helpers ────────────────────────────────────────────────────────────

  /** Mint a valid space credential for a space (signed by our service key). */
  async function credentialFor(
    spaceUri: string,
    jkt?: string,
  ): Promise<string> {
    const { credential } = await mintSpaceCredential({
      signingKey,
      issuerDid: SERVICE_DID,
      spaceUri,
      ttlSeconds: 7_200,
      ...(jkt ? { jkt } : {}),
    })
    return credential
  }

  /** In-memory SET-NX-EX store backing a real ReplayStore. First set wins. */
  class MemoryNxExStore implements NxExStore {
    private readonly seen = new Set<string>()
    async setNxEx(key: string): Promise<boolean> {
      if (this.seen.has(key)) return false
      this.seen.add(key)
      return true
    }
  }

  /**
   * A presentation keypair: its RFC 7638 thumbprint (jkt) plus a builder that
   * signs an ath-bound DPoP presentation proof for a given credential+request.
   */
  async function makePresentationKey() {
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    const jwk = await exportJWK(publicKey)
    const jkt = await calculateJwkThumbprint(jwk)
    async function buildProof(
      credential: string,
      url = '/x',
      method = 'GET',
    ): Promise<string> {
      return new SignJWT({
        htm: method,
        htu: new URL(url, 'https://stratos.test').toString(),
        ath: createHash('sha256').update(credential).digest('base64url'),
        jti: randomUUID(),
      })
        .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
        .setIssuedAt()
        .sign(privateKey)
    }
    return { jkt, buildProof }
  }

  /** A handler-shaped auth carrying a verified space credential. */
  function credentialAuth(spaceUri: string) {
    return { credentials: { type: 'space-credential', spaceUri } }
  }

  /** Append an event whose record carries `boundary`. */
  async function appendEvent(
    did: string,
    rev: string,
    path: string,
    cid: string,
    boundary: string,
  ) {
    const eventData = encodeRecord({
      rev,
      ops: [
        {
          action: 'create',
          path,
          cid,
          record: { text: 'hi', boundary: { values: [{ value: boundary }] } },
        },
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(did, async (store: any) => {
      await store.sequence.appendEvent({
        did,
        eventType: 'append',
        event: eventData,
        invalidated: 0,
        sequencedAt: new Date().toISOString(),
      })
    })
  }

  /** Seed an indexed record (for listRecordPaths). */
  async function seedRecord(
    did: string,
    collection: string,
    rkey: string,
    boundary: string,
  ) {
    const { computeCid, parseCid } =
      await import('@northskysocial/stratos-core')
    const record = {
      $type: collection,
      text: 'hello',
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [{ value: boundary }],
      },
    }
    const cid = parseCid((await computeCid(record)).toString())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(did, async (store: any) => {
      await store.record.putRecord({
        uri: `at://${did}/${collection}/${rkey}`,
        cid,
        value: record,
        content: encodeRecord(record),
      })
    })
  }

  // ── pull-sync: listRepoOps ───────────────────────────────────────────────

  describe('listRepoOps', () => {
    it('a credential for S returns S-records and hides other-space records', async () => {
      await actorStore.create(repoDid)
      await appendEvent(
        repoDid,
        '3aaaa000000t1',
        'zone.stratos.feed.post/inS',
        'cidS',
        BOUNDARY_S.value,
      )
      await appendEvent(
        repoDid,
        '3bbbb000000t2',
        'zone.stratos.feed.post/inT',
        'cidT',
        BOUNDARY_T.value,
      )

      const handler = listRepoOpsHandler(ctx)
      const res = await handler({
        params: { did: repoDid, limit: 100 },
        auth: credentialAuth(SPACE_S),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ops = (res.body as any).ops as Array<{ rkey: string }>
      expect(ops.map((o) => o.rkey)).toEqual(['inS'])
    })

    it('adversarial: a credential for S never returns a T-only record', async () => {
      await actorStore.create(repoDid)
      await appendEvent(
        repoDid,
        '3bbbb000000t2',
        'zone.stratos.feed.post/inT',
        'cidT',
        BOUNDARY_T.value,
      )
      const handler = listRepoOpsHandler(ctx)
      const res = await handler({
        params: { did: repoDid, limit: 100 },
        auth: credentialAuth(SPACE_S),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((res.body as any).ops).toHaveLength(0)
    })
  })

  // ── pull-sync: listRecordPaths ───────────────────────────────────────────

  describe('listRecordPaths', () => {
    it('a credential for S returns S-records and hides other-space records', async () => {
      await actorStore.create(repoDid)
      await seedRecord(repoDid, 'zone.stratos.feed.post', 'a', BOUNDARY_S.value)
      await seedRecord(repoDid, 'zone.stratos.feed.post', 'b', BOUNDARY_T.value)

      const handler = listRecordPathsHandler(ctx)
      const res = await handler({
        params: { did: repoDid, limit: 100 },
        auth: credentialAuth(SPACE_S),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const records = (res.body as any).records as Array<{ rkey: string }>
      expect(records.map((r) => r.rkey)).toEqual(['a'])
    })
  })

  // ── hydration ────────────────────────────────────────────────────────────

  describe('hydrateRecords / hydrateRecord', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handlers: Record<string, any>

    beforeEach(async () => {
      const { EnrollmentBoundaryResolver } =
        await import('../src/features/index.js')
      const boundaryResolver = new EnrollmentBoundaryResolver(enrollmentStore)
      ctx.boundaryResolver = boundaryResolver
      ctx.hydrationService = new HydrationServiceImpl(
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getRecord: async (ownerDid: string, uri: string) => {
            return recordFixtures.get(uri) ?? null
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getRecords: async (ownerDid: string, uris: string[]) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = new Map<any, any>()
            for (const uri of uris) {
              const rec = recordFixtures.get(uri)
              if (rec) m.set(uri, rec)
            }
            return m
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        boundaryResolver,
      )
      ctx.authVerifier = { optionalStandardOrSpaceCredential: vi.fn() }
      handlers = {}
      const server = {
        method: vi.fn((name: string, opts: { handler: unknown }) => {
          handlers[name] = opts.handler
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      registerHydrationHandlers(server, ctx)
    })

    // In-memory record fixtures keyed by uri.
    const uriS = `at://${repoDid}/zone.stratos.feed.post/inS`
    const uriT = `at://${repoDid}/zone.stratos.feed.post/inT`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recordFixtures = new Map<string, any>()

    beforeEach(() => {
      recordFixtures.clear()
      recordFixtures.set(uriS, {
        uri: uriS,
        cid: 'cidS',
        value: { text: 's' },
        boundaries: [BOUNDARY_S.value],
      })
      recordFixtures.set(uriT, {
        uri: uriT,
        cid: 'cidT',
        value: { text: 't' },
        boundaries: [BOUNDARY_T.value],
      })
    })

    it('hydrateRecords: a credential for S returns the S-record, blocks the T-record', async () => {
      const res = await handlers['zone.stratos.repo.hydrateRecords']({
        input: { body: { uris: [uriS, uriT] } },
        params: {},
        auth: credentialAuth(SPACE_S),
        req: {},
        res: {},
      })
      expect(res.body.records.map((r: { uri: string }) => r.uri)).toEqual([
        uriS,
      ])
      expect(res.body.blocked).toEqual([uriT])
    })

    it('hydrateRecord: a credential for S resolves an S-record', async () => {
      const res = await handlers['zone.stratos.repo.hydrateRecord']({
        params: { uri: uriS },
        input: null,
        auth: credentialAuth(SPACE_S),
        req: {},
        res: {},
      })
      expect(res.body.uri).toBe(uriS)
    })

    it('hydrateRecord: a credential for S is blocked from a T-record (fail closed)', async () => {
      await expect(
        handlers['zone.stratos.repo.hydrateRecord']({
          params: { uri: uriT },
          input: null,
          auth: credentialAuth(SPACE_S),
          req: {},
          res: {},
        }),
      ).rejects.toThrow('boundary')
    })
  })

  // ── verifier composition (routing + regression) ──────────────────────────

  describe('verifier composition', () => {
    function makeVerifiers(opts?: {
      devMode?: boolean
      withoutReplayStore?: boolean
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }): any {
      return createAuthVerifiers(
        SERVICE_DID,
        // idResolver — only used by service/standard paths we don't exercise
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
        ctx.cfg,
        enrollmentStore,
        // adminSessionStore / adminUserStore — the admin path is not exercised
        // here, so these return no session and no grant.
        {
          create: vi.fn(async () => ''),
          get: vi.fn(async () => undefined),
          del: vi.fn(async () => {}),
          deleteExpired: vi.fn(async () => 0),
        },
        {
          list: vi.fn(async () => []),
          has: vi.fn(async () => false),
          add: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
        [],
        // dpopVerifier stub: rejects everything (so the standard path fails
        // exactly as an unauthenticated DPoP request would).
        {
          verify: vi.fn(async () => {
            throw new Error('no dpop')
          }),
          nextNonce: vi.fn(() => undefined),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        undefined,
        opts?.devMode ?? false,
        signingKey,
        opts?.withoutReplayStore
          ? undefined
          : new ReplayStore(new MemoryNxExStore()),
        ctx.logger,
      )
    }

    function ctxWithHeader(
      authorization?: string,
      extraHeaders?: Record<string, string>,
    ) {
      return {
        req: {
          method: 'GET',
          headers: {
            ...(authorization ? { authorization } : {}),
            ...(extraHeaders ?? {}),
          },
          url: '/x',
        },
        res: { setHeader: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
    }

    it('spaceCredential accepts a BOUND credential presented under DPoP with a valid proof', async () => {
      const verifiers = makeVerifiers()
      const key = await makePresentationKey()
      const cred = await credentialFor(SPACE_S, key.jkt)
      const result = await verifiers.spaceCredential(
        ctxWithHeader(`DPoP ${cred}`, { dpop: await key.buildProof(cred) }),
      )
      expect(result.credentials).toEqual({
        type: 'space-credential',
        spaceUri: SPACE_S,
      })
    })

    it('spaceCredential accepts a lowercase "dpop" auth scheme (RFC 9110: schemes are case-insensitive)', async () => {
      const verifiers = makeVerifiers()
      const key = await makePresentationKey()
      const cred = await credentialFor(SPACE_S, key.jkt)
      const result = await verifiers.spaceCredential(
        ctxWithHeader(`dpop ${cred}`, { dpop: await key.buildProof(cred) }),
      )
      expect(result.credentials).toEqual({
        type: 'space-credential',
        spaceUri: SPACE_S,
      })
    })

    it('spaceCredential REJECTS a proof replay (same jti twice)', async () => {
      const verifiers = makeVerifiers()
      const key = await makePresentationKey()
      const cred = await credentialFor(SPACE_S, key.jkt)
      const proof = await key.buildProof(cred)
      await verifiers.spaceCredential(
        ctxWithHeader(`DPoP ${cred}`, { dpop: proof }),
      )
      // The same verifiers instance shares one replay store — the second
      // presentation of the SAME proof must fail.
      await expect(
        verifiers.spaceCredential(
          ctxWithHeader(`DPoP ${cred}`, { dpop: proof }),
        ),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('spaceCredential REJECTS a proof signed by a key other than cnf.jkt', async () => {
      const verifiers = makeVerifiers()
      const boundKey = await makePresentationKey()
      const attackerKey = await makePresentationKey()
      const cred = await credentialFor(SPACE_S, boundKey.jkt)
      await expect(
        verifiers.spaceCredential(
          ctxWithHeader(`DPoP ${cred}`, {
            dpop: await attackerKey.buildProof(cred),
          }),
        ),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('spaceCredential REJECTS a Bearer credential outside dev mode', async () => {
      const verifiers = makeVerifiers()
      const cred = await credentialFor(SPACE_S)
      await expect(
        verifiers.spaceCredential(ctxWithHeader(`Bearer ${cred}`)),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('dev mode: spaceCredential accepts an UNBOUND credential over Bearer', async () => {
      const verifiers = makeVerifiers({ devMode: true })
      const cred = await credentialFor(SPACE_S)
      const result = await verifiers.spaceCredential(
        ctxWithHeader(`Bearer ${cred}`),
      )
      expect(result.credentials).toEqual({
        type: 'space-credential',
        spaceUri: SPACE_S,
      })
    })

    it('dev mode: spaceCredential REJECTS a BOUND credential over Bearer (no downgrade)', async () => {
      const verifiers = makeVerifiers({ devMode: true })
      const key = await makePresentationKey()
      const cred = await credentialFor(SPACE_S, key.jkt)
      await expect(
        verifiers.spaceCredential(ctxWithHeader(`Bearer ${cred}`)),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('fails closed: DPoP presentation REJECTED when no replay store is configured', async () => {
      const verifiers = makeVerifiers({ withoutReplayStore: true })
      const key = await makePresentationKey()
      const cred = await credentialFor(SPACE_S, key.jkt)
      await expect(
        verifiers.spaceCredential(
          ctxWithHeader(`DPoP ${cred}`, { dpop: await key.buildProof(cred) }),
        ),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('standardOrSpaceCredential routes a credential Bearer to the credential path', async () => {
      const verifiers = makeVerifiers({ devMode: true })
      const cred = await credentialFor(SPACE_S)
      const result = await verifiers.standardOrSpaceCredential(
        ctxWithHeader(`Bearer ${cred}`),
      )
      expect(result.credentials.type).toBe('space-credential')
    })

    it('standardOrSpaceCredential routes a NON-credential request to the standard path (regression: unchanged)', async () => {
      const verifiers = makeVerifiers()
      // A DPoP request with a stubbed-failing verifier fails exactly as before.
      await expect(
        verifiers.standardOrSpaceCredential(ctxWithHeader('DPoP abc.def.ghi')),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('optionalStandardOrSpaceCredential stays anonymous when unauthenticated (regression)', async () => {
      const verifiers = makeVerifiers()
      const result =
        await verifiers.optionalStandardOrSpaceCredential(ctxWithHeader())
      expect(result.credentials).toEqual({ type: 'anonymous' })
    })

    // The three rejection tests below present over dev-mode Bearer so the
    // failure they observe is the CREDENTIAL check, not the scheme gate.
    it('rejects an expired credential through the composition', async () => {
      const verifiers = makeVerifiers({ devMode: true })
      const iat = Math.floor(Date.now() / 1000) - 10_000
      const { credential } = await mintSpaceCredential({
        signingKey,
        issuerDid: SERVICE_DID,
        spaceUri: SPACE_S,
        ttlSeconds: 60,
        iat,
      })
      await expect(
        verifiers.spaceCredential(ctxWithHeader(`Bearer ${credential}`)),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('rejects a bad-signature credential through the composition', async () => {
      const verifiers = makeVerifiers({ devMode: true })
      const attacker = await Secp256k1Keypair.create()
      const { credential } = await mintSpaceCredential({
        signingKey: attacker, // wrong signer
        issuerDid: SERVICE_DID,
        spaceUri: SPACE_S,
        ttlSeconds: 7_200,
      })
      await expect(
        verifiers.spaceCredential(ctxWithHeader(`Bearer ${credential}`)),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('rejects a foreign-space credential (spaceDid ≠ serviceDid)', async () => {
      const verifiers = makeVerifiers({ devMode: true })
      const { credential } = await mintSpaceCredential({
        signingKey,
        issuerDid: SERVICE_DID,
        spaceUri: makeSpaceUri(
          'did:web:other.example',
          'zone.stratos.space.feed',
          'x',
        ),
        ttlSeconds: 7_200,
      })
      await expect(
        verifiers.spaceCredential(ctxWithHeader(`Bearer ${credential}`)),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('WRITE auth (standard) REJECTS a space credential (writes are OAuth-only)', async () => {
      const verifiers = makeVerifiers()
      const cred = await credentialFor(SPACE_S)
      // The write surface binds `authVerifier.standard`. A space-credential
      // Bearer is not a DPoP proof, so `standard` rejects it — writes never
      // accept a credential.
      await expect(
        verifiers.standard(ctxWithHeader(`Bearer ${cred}`)),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('serviceOrSpaceCredential routes a NON-credential Bearer to the service path (regression)', async () => {
      const verifiers = makeVerifiers()
      // A random non-space-credential Bearer JWT must NOT be routed to the
      // credential path; it goes to the service verifier and fails there
      // exactly as an invalid service-auth token would (unchanged behaviour).
      const notACredential =
        Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256K' })).toString(
          'base64url',
        ) +
        '.' +
        Buffer.from(
          JSON.stringify({ iss: 'did:web:peer', aud: SERVICE_DID }),
        ).toString('base64url') +
        '.' +
        Buffer.from('sig').toString('base64url')
      await expect(
        verifiers.serviceOrSpaceCredential(
          ctxWithHeader(`Bearer ${notACredential}`),
        ),
      ).rejects.toBeInstanceOf(AuthRequiredError)
    })
  })
})
