/**
 * Contract tests for `zone.stratos.space.listRepos` — the spec-shaped mirror
 * of `com.atproto.space.listRepos` (atproto#5187), extended with `host` /
 * `hostSource`.
 *
 * Contract under test:
 *   - a membership oracle, never a member-facing read: callable with
 *     inter-service auth OR a space credential for that space, NEVER an
 *     anonymous/plain-user-session caller (fail closed);
 *   - membership is derived from active enrollment + boundary -- no second
 *     member list;
 *   - a deactivated enrollment is excluded even if the boundary row survives;
 *   - an other-boundary member is excluded;
 *   - `rev` is present only for a stratos-custody member Stratos itself
 *     stores a repo for; a pds-custody member never gets one;
 *   - repo-host resolution runs only for pds-custody members; Stratos-custody
 *     rows omit `host`/`hostSource` without touching DID resolution;
 *   - an unresolvable PDS host omits `host`/`hostSource` without failing the
 *     whole call;
 *   - malformed / foreign space URIs → UnknownSpace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { decode } from '@atcute/cbor'
import { spaceUriToBoundary } from '@northskysocial/stratos-core'

import type { Server as XrpcServer } from '@atproto/xrpc-server'
import { SqliteEnrollmentStore, StratosActorStore } from '../src/context.js'
import type { AppContext } from '../src/context-types.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  ServiceDb,
} from '../src/db/index.js'
import { registerSpaceReadHandlers } from '../src/features/space-read/handler.js'
import { createMockBlobStore, createTestConfig } from './utils/index.js'
import { createCid } from './helpers/test-env.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const SERVICE_DID = 'did:web:nerv.tokyo.jp'
const SPACE_S = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'alpha')
const SPACE_T = makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'beta')
const BOUNDARY_S = spaceUriToBoundary(SPACE_S, SERVICE_DID)
const BOUNDARY_T = spaceUriToBoundary(SPACE_T, SERVICE_DID)
if (!BOUNDARY_S.ok || !BOUNDARY_T.ok) throw new Error('bad test boundary')

const SERVICE_CALLER_DID = 'did:web:magi.nerv.jp'
const stratosMemberDid = 'did:plc:rei-ayanami'
const pdsMemberDid = 'did:plc:asuka-langley'
const unresolvableMemberDid = 'did:plc:kaworu-nagisa'
const deactivatedDid = 'did:plc:gendo-ikari'
const outsiderDid = 'did:plc:misato-katsuragi'
// Holds an actor store WITH a committed root, despite being pds-custody --
// proves the custody check (not just "no actor store") gates `rev`.
const pdsMemberWithStrayRepoDid = 'did:plc:shinji-ikeda'
// Stratos-custody but never wrote a commit -- proves `getRootDetailed()`
// returning null is handled without throwing.
const rootlessStratosMemberDid = 'did:plc:toji-suzuhara'
// DID document resolution returns a falsy value outright.
const nullDidDocMemberDid = 'did:plc:kensuke-aida'
// DID document has services, but none with a matching `#atproto_pds` id.
const wrongServiceIdMemberDid = 'did:plc:hikari-horaki'
// DID document has a matching service id, but a non-string endpoint.
const nonStringEndpointMemberDid = 'did:plc:mana-kirishima'
// DID document's service id matches the DID-qualified form
// (`${did}#atproto_pds`), not the bare `#atproto_pds` form.
const didQualifiedServiceIdMemberDid = 'did:plc:makoto-hyuga'
// Enrollment row carries its own `repoHost` -- the authority-override arm
// must answer from it and never reach DID resolution.
const overrideMemberDid = 'did:plc:ritsuko-akagi'
// Stratos-custody, but the actor store rejects (simulating a pool timeout) --
// `rev` lookup must degrade to absent, not fail the whole call.
const revLookupFailsMemberDid = 'did:plc:kaji-ryoji'

const PDS_ENDPOINT = 'https://pds.example.com'
const OVERRIDE_HOST = 'https://override.pds.example.com'

type ListReposEntry = {
  did: string
  custody: string
  rev?: string
  host?: string
  hostSource?: string
}

// The narrowed shape of the captured `listRepos` handler. The registration
// seam hands handlers back as `unknown`; this is the single point where the
// test asserts what it captured.
type ListReposHandler = (input: {
  params: Record<string, unknown>
  auth: { credentials: Record<string, unknown> } | undefined
  req: unknown
  res: unknown
}) => Promise<{ body: { repos: ListReposEntry[]; cursor?: string } }>

describe('zone.stratos.space.listRepos', () => {
  let dataDir: string
  let actorStore: StratosActorStore
  let enrollmentStore: SqliteEnrollmentStore
  let db: ServiceDb
  let handler: ListReposHandler
  let methods: Map<string, { type?: string; handler: unknown }>
  let warnSpy: ReturnType<typeof vi.fn>
  let resolveDid: ReturnType<typeof vi.fn>
  let ctx: AppContext
  let revFailDids: Set<string>

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-spacerepos-${randomBytes(8).toString('hex')}`,
    )
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

    // Resolves a DID document `#atproto_pds` endpoint for every member except
    // `unresolvableMemberDid`, which has no matching service entry.
    resolveDid = vi.fn(async (did: string) => {
      if (did === overrideMemberDid) {
        throw new Error(
          'DID resolution must not run once the override arm answers',
        )
      }
      if (did === unresolvableMemberDid) {
        return { service: [] }
      }
      if (did === nullDidDocMemberDid) {
        return null
      }
      if (did === wrongServiceIdMemberDid) {
        return {
          service: [{ id: '#other', serviceEndpoint: PDS_ENDPOINT }],
        }
      }
      if (did === nonStringEndpointMemberDid) {
        return {
          service: [
            { id: '#atproto_pds', serviceEndpoint: { not: 'a string' } },
          ],
        }
      }
      if (did === didQualifiedServiceIdMemberDid) {
        return {
          service: [
            { id: `${did}#atproto_pds`, serviceEndpoint: PDS_ENDPOINT },
          ],
        }
      }
      return {
        service: [{ id: '#atproto_pds', serviceEndpoint: PDS_ENDPOINT }],
      }
    })
    const idResolver = {
      did: {
        resolve: resolveDid,
      },
    }

    // Delegates to the real actor store, except `exists` rejects for every
    // DID in `revFailDids` -- simulates a pool-exhausted/unavailable actor
    // store without touching every other member's real lookups.
    revFailDids = new Set([revLookupFailsMemberDid])
    const actorStoreWithFailure = new Proxy(actorStore, {
      get(target, prop, receiver) {
        if (prop === 'exists') {
          return async (did: string) => {
            if (revFailDids.has(did)) {
              throw new Error('pool timeout')
            }
            return target.exists(did)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    // A partial mock: only the fields the space-read handlers touch. The one
    // cast to `AppContext` lives here, at the construction boundary.
    ctx = {
      cfg,
      actorStore: actorStoreWithFailure,
      enrollmentStore,
      serviceDid: SERVICE_DID,
      idResolver,
      authVerifier: { serviceOrSpaceCredential: vi.fn() },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        warn: (warnSpy = vi.fn()),
      },
    } as unknown as AppContext
    const capturedMethods = new Map<
      string,
      { type?: string; handler: unknown }
    >()
    const server = {
      method: (name: string, cfgArg: { type?: string; handler: unknown }) =>
        capturedMethods.set(name, cfgArg),
    }
    registerSpaceReadHandlers(server as unknown as XrpcServer, ctx)
    methods = capturedMethods
    handler = capturedMethods.get('zone.stratos.space.listRepos')!
      .handler as ListReposHandler

    // The calling service must itself be enrolled in the boundary it queries.
    await enrollmentStore.enroll({
      did: SERVICE_CALLER_DID,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      isService: true,
    })
    await enrollmentStore.setBoundaries(SERVICE_CALLER_DID, [BOUNDARY_S.value])

    await enrollmentStore.enroll({
      did: stratosMemberDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
    })
    await enrollmentStore.setBoundaries(stratosMemberDid, [BOUNDARY_S.value])
    await actorStore.create(stratosMemberDid)
    const rootCid = await createCid('rei root commit')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(stratosMemberDid, async (store: any) => {
      await store.repo.updateRoot(rootCid, 'rei-rev-1', stratosMemberDid)
    })

    await enrollmentStore.enroll({
      did: pdsMemberDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      custody: 'pds',
    })
    await enrollmentStore.setBoundaries(pdsMemberDid, [BOUNDARY_S.value])

    await enrollmentStore.enroll({
      did: unresolvableMemberDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      custody: 'pds',
    })
    await enrollmentStore.setBoundaries(unresolvableMemberDid, [
      BOUNDARY_S.value,
    ])

    await enrollmentStore.enroll({
      did: deactivatedDid,
      enrolledAt: new Date().toISOString(),
      active: false,
      signingKeyDid: 'did:key:zTest',
    })
    await enrollmentStore.setBoundaries(deactivatedDid, [BOUNDARY_S.value])

    await enrollmentStore.enroll({
      did: outsiderDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
    })
    await enrollmentStore.setBoundaries(outsiderDid, [BOUNDARY_T.value])

    // pds-custody, but a repo happens to exist in Stratos's own actor store
    // (e.g. left over from a custody switch). The rev must still be omitted:
    // custody, not actor-store presence, decides whether Stratos's copy counts.
    await enrollmentStore.enroll({
      did: pdsMemberWithStrayRepoDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      custody: 'pds',
    })
    await enrollmentStore.setBoundaries(pdsMemberWithStrayRepoDid, [
      BOUNDARY_S.value,
    ])
    await actorStore.create(pdsMemberWithStrayRepoDid)
    const strayRootCid = await createCid('stray root commit')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await actorStore.transact(pdsMemberWithStrayRepoDid, async (store: any) => {
      await store.repo.updateRoot(
        strayRootCid,
        'stray-rev',
        pdsMemberWithStrayRepoDid,
      )
    })

    // stratos-custody with an actor store but no commit yet.
    await enrollmentStore.enroll({
      did: rootlessStratosMemberDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
    })
    await enrollmentStore.setBoundaries(rootlessStratosMemberDid, [
      BOUNDARY_S.value,
    ])
    await actorStore.create(rootlessStratosMemberDid)

    for (const did of [
      nullDidDocMemberDid,
      wrongServiceIdMemberDid,
      nonStringEndpointMemberDid,
      didQualifiedServiceIdMemberDid,
    ]) {
      await enrollmentStore.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: 'did:key:zTest',
        custody: 'pds',
      })
      await enrollmentStore.setBoundaries(did, [BOUNDARY_S.value])
    }

    await enrollmentStore.enroll({
      did: overrideMemberDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
      custody: 'pds',
      repoHost: OVERRIDE_HOST,
    })
    await enrollmentStore.setBoundaries(overrideMemberDid, [BOUNDARY_S.value])

    await enrollmentStore.enroll({
      did: revLookupFailsMemberDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zTest',
    })
    await enrollmentStore.setBoundaries(revLookupFailsMemberDid, [
      BOUNDARY_S.value,
    ])
  })

  afterEach(async () => {
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  function call(
    params: Record<string, unknown>,
    auth: { credentials: Record<string, unknown> },
  ) {
    return handler({
      params: { space: SPACE_S, ...params },
      auth,
      req: {},
      res: {},
    })
  }

  const serviceAuth = {
    credentials: {
      type: 'service',
      iss: SERVICE_CALLER_DID,
      did: SERVICE_CALLER_DID,
    },
  }
  const credAuth = (spaceUri: string) => ({
    credentials: { type: 'space-credential', spaceUri },
  })

  it('registers as a query method', () => {
    expect(methods.get('zone.stratos.space.listRepos')!.type).toBe('query')
  })

  it('an anonymous caller is refused (critical: never a membership oracle for the public)', async () => {
    await expect(
      call({}, { credentials: {} as Record<string, unknown> }),
    ).rejects.toThrow(/Service auth required/)
  })

  it('a syncing service enumerates the space membership', async () => {
    const res = await call({}, serviceAuth)
    const dids = res.body.repos.map((r: { did: string }) => r.did)
    expect(dids).toEqual(
      expect.arrayContaining([
        stratosMemberDid,
        pdsMemberDid,
        unresolvableMemberDid,
      ]),
    )
    expect(dids).not.toContain(deactivatedDid)
    expect(dids).not.toContain(outsiderDid)
  })

  it('a space credential for S enumerates S membership', async () => {
    const res = await call({}, credAuth(SPACE_S))
    const dids = res.body.repos.map((r: { did: string }) => r.did)
    expect(dids).toEqual(
      expect.arrayContaining([
        stratosMemberDid,
        pdsMemberDid,
        unresolvableMemberDid,
      ]),
    )
  })

  it('a credential for a DIFFERENT space is refused (fail closed)', async () => {
    await expect(call({}, credAuth(SPACE_T))).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Not admitted/),
      customErrorName: 'AuthRequired',
    })
  })

  it('a stratos-custody member gets a rev; a pds-custody member never does', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    expect((byDid.get(stratosMemberDid) as { rev?: string }).rev).toBe(
      'rei-rev-1',
    )
    expect((byDid.get(pdsMemberDid) as { rev?: string }).rev).toBeUndefined()
  })

  it('a pds-custody member reports custody: pds', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(res.body.repos.map((r) => [r.did, r]))
    expect((byDid.get(pdsMemberDid) as { custody?: string }).custody).toBe(
      'pds',
    )
  })

  it('a pds-custody member never gets a rev, even when a repo exists in the Stratos actor store', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    expect(
      (byDid.get(pdsMemberWithStrayRepoDid) as { rev?: string }).rev,
    ).toBeUndefined()
  })

  it('a stratos-custody member with no commit yet gets no rev (not a throw)', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    expect(
      (byDid.get(rootlessStratosMemberDid) as { rev?: string }).rev,
    ).toBeUndefined()
  })

  it('resolves PDS hosts while Stratos custody skips DID resolution and host fields', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    const pds = byDid.get(pdsMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(pds.host).toBe(PDS_ENDPOINT)
    expect(pds.hostSource).toBe('did-document')

    const stratos = byDid.get(stratosMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(stratos.host).toBeUndefined()
    expect(stratos.hostSource).toBeUndefined()
    expect(resolveDid).not.toHaveBeenCalledWith(stratosMemberDid)
    expect(resolveDid).toHaveBeenCalledWith(pdsMemberDid)

    const unresolved = byDid.get(unresolvableMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(unresolved.host).toBeUndefined()
    expect(unresolved.hostSource).toBeUndefined()
    expect(resolveDid).toHaveBeenCalledWith(unresolvableMemberDid)
  })

  it('omits host fields when DID resolution returns no document', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    const entry = byDid.get(nullDidDocMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(entry.host).toBeUndefined()
    expect(entry.hostSource).toBeUndefined()
  })

  it('omits host fields when no service entry has a matching #atproto_pds id', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    const entry = byDid.get(wrongServiceIdMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(entry.host).toBeUndefined()
    expect(entry.hostSource).toBeUndefined()
  })

  it('omits host fields when the matching service entry has a non-string endpoint', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    const entry = byDid.get(nonStringEndpointMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(entry.host).toBeUndefined()
    expect(entry.hostSource).toBeUndefined()
  })

  it('resolves the host when the DID document uses the DID-qualified service id', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    const entry = byDid.get(didQualifiedServiceIdMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(entry.host).toBe(PDS_ENDPOINT)
    expect(entry.hostSource).toBe('did-document')
  })

  it('a member with a recorded repoHost resolves via the authority override, never the DID document', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    const entry = byDid.get(overrideMemberDid) as {
      host?: string
      hostSource?: string
    }
    expect(entry.host).toBe(OVERRIDE_HOST)
    expect(entry.hostSource).toBe('authority-override')
  })

  it('a rejecting actor store degrades that member to no rev, without failing the whole page', async () => {
    const res = await call({}, serviceAuth)
    const dids = res.body.repos.map((r: { did: string }) => r.did)
    expect(dids).toContain(revLookupFailsMemberDid)
    expect(dids).toContain(stratosMemberDid)

    const byDid = new Map(
      res.body.repos.map((r: { did: string }) => [r.did, r]),
    )
    expect(
      (byDid.get(revLookupFailsMemberDid) as { rev?: string }).rev,
    ).toBeUndefined()
  })

  it('a stratos-custody member whose rev lookup fails still reports custody: stratos', async () => {
    const res = await call({}, serviceAuth)
    const byDid = new Map(res.body.repos.map((r) => [r.did, r]))
    expect(
      (byDid.get(revLookupFailsMemberDid) as { custody?: string }).custody,
    ).toBe('stratos')
  })

  it('logs one aggregated warn per page for failed rev lookups, not one per member', async () => {
    await call({}, serviceAuth)
    const revWarns = warnSpy.mock.calls.filter(([, msg]) =>
      String(msg).includes('rev lookup failed'),
    )
    expect(revWarns).toHaveLength(1)
    const [payload] = revWarns[0] as [
      { failedCount: number; sample: Array<{ did: string; error: string }> },
    ]
    expect(payload.failedCount).toBe(1)
    expect(payload.sample).toEqual([
      { did: revLookupFailsMemberDid, error: 'pool timeout' },
    ])
  })

  it('logs no aggregated warn when every rev lookup succeeds', async () => {
    await enrollmentStore.setBoundaries(revLookupFailsMemberDid, [])
    await call({}, serviceAuth)
    const revWarns = warnSpy.mock.calls.filter(([, msg]) =>
      String(msg).includes('rev lookup failed'),
    )
    expect(revWarns).toHaveLength(0)
  })

  it('caps the warn sample at five failures while counting them all', async () => {
    const extraFailDids = [
      'did:plc:spike-spiegel',
      'did:plc:jet-black',
      'did:plc:faye-valentine',
      'did:plc:ed-wong',
      'did:plc:ein-corgi',
    ]
    for (const did of extraFailDids) {
      revFailDids.add(did)
      await enrollmentStore.enroll({
        did,
        enrolledAt: new Date().toISOString(),
        active: true,
        signingKeyDid: 'did:key:zTest',
      })
      await enrollmentStore.setBoundaries(did, [BOUNDARY_S.value])
    }

    await call({}, serviceAuth)
    const revWarns = warnSpy.mock.calls.filter(([, msg]) =>
      String(msg).includes('rev lookup failed'),
    )
    expect(revWarns).toHaveLength(1)
    const [payload] = revWarns[0] as [
      { failedCount: number; sample: Array<{ did: string }> },
    ]
    expect(payload.failedCount).toBe(6)
    expect(payload.sample).toHaveLength(5)
  })

  it('a failed rev lookup with no logger configured still returns the page', async () => {
    const capturedMethods = new Map<
      string,
      { type?: string; handler: unknown }
    >()
    const server = {
      method: (name: string, cfgArg: { type?: string; handler: unknown }) =>
        capturedMethods.set(name, cfgArg),
    }
    registerSpaceReadHandlers(server as unknown as XrpcServer, {
      ...ctx,
      logger: undefined,
    })
    const loggerless = capturedMethods.get('zone.stratos.space.listRepos')!
      .handler as ListReposHandler

    const res = await loggerless({
      params: { space: SPACE_S },
      auth: serviceAuth,
      req: {},
      res: {},
    })
    const dids = res.body.repos.map((r: { did: string }) => r.did)
    expect(dids).toContain(revLookupFailsMemberDid)
  })

  it('never invents a hash: the field is absent for every member', async () => {
    const res = await call({}, serviceAuth)
    for (const repo of res.body.repos as Array<Record<string, unknown>>) {
      expect(repo.hash).toBeUndefined()
    }
  })

  it('a foreign-DID space URI is rejected (UnknownSpace)', async () => {
    await expect(
      call(
        {
          space: makeSpaceUri(
            'did:web:elsewhere.example',
            'zone.stratos.space.feed',
            'alpha',
          ),
        },
        serviceAuth,
      ),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Unknown space/),
      customErrorName: 'UnknownSpace',
    })
  })

  it('a malformed space URI is rejected (UnknownSpace)', async () => {
    await expect(
      call({ space: `ats://${SERVICE_DID}/alpha` }, serviceAuth),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/Unknown space/),
      customErrorName: 'UnknownSpace',
    })
  })

  it('missing space is rejected', async () => {
    await expect(
      handler({ params: {}, auth: serviceAuth, req: {}, res: {} }),
    ).rejects.toMatchObject({
      errorMessage: expect.stringMatching(/required/),
      customErrorName: 'InvalidRequest',
    })
  })

  it('a full page yields a cursor, the next page drains', async () => {
    const fullList = await call({}, serviceAuth)
    const total = fullList.body.repos.length

    const firstPage = await call({ limit: 1 }, serviceAuth)
    expect(firstPage.body.repos).toHaveLength(1)
    expect(firstPage.body.cursor).toBe(firstPage.body.repos[0].did)

    const secondPage = await call(
      { limit: total, cursor: firstPage.body.cursor },
      serviceAuth,
    )
    expect(secondPage.body.repos).toHaveLength(total - 1)
    expect(secondPage.body.cursor).toBeUndefined()

    const allDids = [
      ...firstPage.body.repos.map((r: { did: string }) => r.did),
      ...secondPage.body.repos.map((r: { did: string }) => r.did),
    ]
    expect(allDids).toEqual(
      expect.arrayContaining([
        stratosMemberDid,
        pdsMemberDid,
        unresolvableMemberDid,
      ]),
    )
  })

  it('rejects a non-integer limit (InvalidRequest)', async () => {
    await expect(call({ limit: 'invalid' }, serviceAuth)).rejects.toMatchObject(
      {
        errorMessage: expect.stringMatching(/limit must be an integer/),
        customErrorName: 'InvalidRequest',
      },
    )
  })

  it('a non-service credential type is refused even with a matching did', async () => {
    await expect(
      call({}, { credentials: { type: 'user', did: SERVICE_CALLER_DID } }),
    ).rejects.toThrow(/Service auth required/)
  })

  it('auth entirely absent is refused', async () => {
    await expect(
      handler({
        params: { space: SPACE_S },
        auth: undefined,
        req: {},
        res: {},
      }),
    ).rejects.toThrow(/Service auth required/)
  })

  it('a service caller identified only by iss (no did) is admitted', async () => {
    const res = await call(
      {},
      { credentials: { type: 'service', iss: SERVICE_CALLER_DID } },
    )
    const dids = res.body.repos.map((r: { did: string }) => r.did)
    expect(dids).toEqual(expect.arrayContaining([stratosMemberDid]))
  })

  it('a service caller with neither iss nor did is refused', async () => {
    await expect(
      call({}, { credentials: { type: 'service' } }),
    ).rejects.toThrow(/Service auth required/)
  })

  it('revocation is honored on the next call (live membership)', async () => {
    await call({}, serviceAuth)
    await enrollmentStore.setBoundaries(SERVICE_CALLER_DID, [])
    await expect(call({}, serviceAuth)).rejects.toThrow(
      /Service is not enrolled in any boundary/,
    )
  })
})
