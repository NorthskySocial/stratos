import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import type { IdResolver } from '@atproto/identity'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'
import { resolveEffectiveBoundaries } from '../src/infra/auth/credential-scope.js'
import { createServicePgDb, migrateServicePgDb } from '../src/db/pg.js'
import { PgEnrollmentStoreWriter } from '../src/infra/storage/postgres/index.js'
import type { AppContext } from '../src/context-types.js'
import {
  createCid,
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { TestServer } from './helpers/test-server.js'

const AUTHORITY = 'did:web:test.stratos.actor'
const RESERVED = `${AUTHORITY}/general`
const SECOND = `${AUTHORITY}/test.com`
const UNASSIGNED = `${AUTHORITY}/example.com`
const ACTOR = 'did:plc:rei-ayanami'
const SPACE = `at://${AUTHORITY}/space/zone.stratos.space.feed/general`
const SECOND_SPACE = `at://${AUTHORITY}/space/zone.stratos.space.feed/test.com`
const UNASSIGNED_SPACE = `at://${AUTHORITY}/space/zone.stratos.space.feed/example.com`
const METHODS = [
  'zone.stratos.sync.listRepoOps',
  'zone.stratos.sync.listRecordPaths',
  'zone.stratos.space.listRepos',
] as const

describe('service boundary admission over HTTP', () => {
  let server: TestServer
  let issuer: Secp256k1Keypair
  let callerDid: string

  beforeAll(async () => {
    server = await TestServer.create()
    issuer = await Secp256k1Keypair.create({ exportable: true })
    callerDid = issuer.did()
    const publicKeyMultibase = callerDid.slice('did:key:'.length)
    vi.spyOn(server.server.ctx.idResolver.did, 'resolve').mockImplementation(
      async (did) =>
        did === callerDid
          ? {
              id: callerDid,
              verificationMethod: [
                {
                  id: `${callerDid}#key`,
                  type: 'Multikey',
                  controller: callerDid,
                  publicKeyMultibase,
                },
              ],
            }
          : null,
    )
    await server.start()

    const store = server.server.ctx.enrollmentStore
    await store.setBoundaries(callerDid, [SECOND])
    await store.enroll({
      did: ACTOR,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zRei',
      boundaries: [SECOND, UNASSIGNED],
    })
    await server.server.ctx.actorStore.create(ACTOR)
    for (const [text, boundary] of [
      ['Rei joins the room', SECOND],
      ['Rei keeps another room private', UNASSIGNED],
    ]) {
      const write = await fetch(
        `${server.url}/xrpc/com.atproto.repo.createRecord`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ACTOR}`,
          },
          body: JSON.stringify({
            repo: ACTOR,
            collection: 'zone.stratos.feed.post',
            record: {
              $type: 'zone.stratos.feed.post',
              text,
              createdAt: new Date().toISOString(),
              boundary: { values: [{ value: boundary }] },
            },
          }),
        },
      )
      expect(write.status, await write.clone().text()).toBe(200)
    }

    // The test server's decoder expects JSON bytes. Seed recovery records in
    // that format so listRecordPaths exercises its real boundary filter.
    await server.server.ctx.actorStore.transact(ACTOR, async (store) => {
      for (const [rkey, boundary] of [
        ['visible', SECOND],
        ['private', UNASSIGNED],
      ]) {
        const value = {
          $type: 'zone.stratos.graph.follow',
          subject: 'did:plc:shinji-ikari',
          boundary: { values: [{ value: boundary }] },
        }
        const content = new TextEncoder().encode(JSON.stringify(value))
        await store.record.putRecord({
          uri: `at://${ACTOR}/zone.stratos.graph.follow/${rkey}`,
          cid: await createCid(content),
          value,
          content,
        })
      }
    })
  }, 30_000)

  afterAll(async () => {
    await server?.stop()
    vi.restoreAllMocks()
  })

  async function request(method: (typeof METHODS)[number], space = SPACE) {
    const token = await createServiceJwt({
      iss: callerDid,
      aud: AUTHORITY,
      lxm: method,
      keypair: issuer,
    })
    const params =
      method === 'zone.stratos.space.listRepos'
        ? `space=${encodeURIComponent(space)}`
        : method === 'zone.stratos.sync.listRecordPaths'
          ? `did=${encodeURIComponent(ACTOR)}&collection=zone.stratos.graph.follow`
          : `did=${encodeURIComponent(ACTOR)}`
    const response = await fetch(`${server.url}/xrpc/${method}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return { response, body: await response.json() }
  }

  it('denies a signed issuer with boundary rows but no enrollment on all three routes', async () => {
    for (const method of METHODS) {
      const { response, body } = await request(method)
      expect([401, 403]).toContain(response.status)
      expect(body).not.toHaveProperty('ops')
      expect(body).not.toHaveProperty('records')
      expect(body).not.toHaveProperty('repos')
    }
  })

  it('admits active enrollment, denies deactivation, and admits reactivation', async () => {
    const store = server.server.ctx.enrollmentStore
    await store.enroll({
      did: callerDid,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: callerDid,
      isService: true,
      boundaries: [SECOND],
    })
    const ops = await request('zone.stratos.sync.listRepoOps')
    expect(ops.response.status).toBe(200)
    expect(ops.body.ops).toHaveLength(1)
    expect(ops.body.ops[0].value.text).toBe('Rei joins the room')

    const paths = await request('zone.stratos.sync.listRecordPaths')
    expect(paths.response.status).toBe(200)
    expect(
      paths.body.records.map((record: { rkey: string }) => record.rkey),
    ).toEqual(['visible'])

    const all = await request('zone.stratos.space.listRepos')
    expect(all.response.status).toBe(200)
    expect(all.body.repos).toEqual(
      expect.arrayContaining([expect.objectContaining({ did: ACTOR })]),
    )
    const second = await request('zone.stratos.space.listRepos', SECOND_SPACE)
    expect(second.response.status).toBe(200)
    expect(second.body.repos).toEqual(
      expect.arrayContaining([expect.objectContaining({ did: ACTOR })]),
    )
    const unassigned = await request(
      'zone.stratos.space.listRepos',
      UNASSIGNED_SPACE,
    )
    expect([401, 403]).toContain(unassigned.response.status)
    expect(unassigned.body).not.toHaveProperty('repos')

    await store.updateEnrollment(callerDid, { active: false })
    expect(await store.getBoundaries(callerDid)).toContain(SECOND)
    for (const method of METHODS) {
      const { response, body } = await request(method)
      expect([401, 403]).toContain(response.status)
      expect(body).not.toHaveProperty('ops')
      expect(body).not.toHaveProperty('records')
      expect(body).not.toHaveProperty('repos')
    }

    await store.updateEnrollment(callerDid, { active: true })
    for (const method of METHODS) {
      const { response } = await request(method)
      expect(response.status).toBe(200)
    }
  })
})

describe('PostgreSQL reserved boundary admission', () => {
  let pgUrl: string
  let db: ReturnType<typeof createServicePgDb>
  const did = 'did:plc:misato-katsuragi'
  const auth = { credentials: { type: 'service', iss: did, did } }

  beforeAll(async () => {
    pgUrl = await startPostgresContainer()
    db = createServicePgDb(pgUrl)
    await migrateServicePgDb(db)
  }, 120_000)

  afterAll(async () => {
    await db?.$client.end()
    if (pgUrl) await stopPostgresContainer()
  })

  it('checks the enrollment before decorated PostgreSQL boundaries', async () => {
    const store = new ReservedDomainEnrollmentStore(
      new PgEnrollmentStoreWriter(db),
      RESERVED,
    )
    const ctx = {
      serviceDid: AUTHORITY,
      enrollmentStore: store,
      logger: { warn: vi.fn() },
    } as unknown as AppContext
    await store.setBoundaries(did, [SECOND])
    await expect(resolveEffectiveBoundaries(ctx, auth)).rejects.toThrow(
      'Enrollment is missing or deactivated',
    )
    await store.enroll({
      did,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: did,
      boundaries: [SECOND],
    })
    await expect(resolveEffectiveBoundaries(ctx, auth)).resolves.toEqual(
      new Set([SECOND, RESERVED]),
    )
    await store.updateEnrollment(did, { active: false })
    await expect(resolveEffectiveBoundaries(ctx, auth)).rejects.toThrow(
      'Enrollment is missing or deactivated',
    )
  }, 120_000)

  it('denies a store lookup failure and keeps credential scope independent', async () => {
    const store = new ReservedDomainEnrollmentStore(
      new PgEnrollmentStoreWriter(db),
      RESERVED,
    )
    const ctx = {
      serviceDid: AUTHORITY,
      enrollmentStore: store,
      logger: { warn: vi.fn() },
    } as unknown as AppContext
    const lookup = vi
      .spyOn(store, 'getEnrollment')
      .mockRejectedValueOnce(new Error('database unavailable'))
    await expect(resolveEffectiveBoundaries(ctx, auth)).rejects.toThrow(
      'Service is not enrolled in any boundary',
    )
    expect(ctx.logger?.warn).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledWith(did)
    await expect(
      resolveEffectiveBoundaries(ctx, {
        credentials: { type: 'space-credential', spaceUri: SPACE },
      }),
    ).resolves.toEqual(new Set([RESERVED]))
  }, 120_000)
})
