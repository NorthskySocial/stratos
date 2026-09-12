import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import { makeSpaceUri } from '../helpers/space-uri.js'
import { TestServer } from '../helpers/test-server.js'
import { ADMIN_SESSION_COOKIE } from '../../src/oauth/admin-routes.js'
import { settings } from './helpers.js'
import type { BoundaryDetails } from '@northskysocial/stratos-core'
import type { AppContext } from '../../src/context-types.js'
import type { Server as XrpcServer } from '@atproto/xrpc-server'
import { registerBoundaryHandlers } from '../../src/features/boundary/handler.js'
import {
  makeClient,
  mintAttestation,
  resolverFor,
} from '../helpers/attestation.js'

const ADMIN = 'did:plc:misato'
const SERVICE = 'did:web:test.stratos.actor'
describe('boundary catalog XRPC over HTTP', () => {
  let server: TestServer
  let cookie: string
  beforeAll(async () => {
    server = await TestServer.create()
    const ctx = server.server.ctx
    ctx.cfg.adminDids.push(ADMIN)
    cookie = `${ADMIN_SESSION_COOKIE}=${await ctx.adminSessionStore.create(ADMIN, 60_000)}`
    await server.start()
  }, 30_000)
  afterAll(async () => {
    await server?.stop()
  })
  const url = (method: string) => `${server.url}/xrpc/zone.stratos.${method}`
  function post(
    method: string,
    body: unknown,
    headers: Record<string, string> = { cookie },
  ) {
    return fetch(url(`admin.${method}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }
  it('requires an admin session and rejects cross-origin mutations', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer did:plc:misato' },
    ] as Record<string, string>[]) {
      expect(
        (await fetch(url('admin.listBoundaries'), { headers })).status,
      ).toBe(401)
      expect(
        (await post('createBoundary', { name: 'denied', settings }, headers))
          .status,
      ).toBe(401)
    }
    expect(
      (
        await post(
          'createBoundary',
          { name: 'denied', settings },
          { cookie, origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(401)
    expect(
      await server.server.ctx.boundaryStore!.get(`${SERVICE}/denied`),
    ).toBeNull()
  })
  it('preserves handler registration in minimal contexts without boundary administration', () => {
    const method = vi.fn()
    registerBoundaryHandlers(
      { method } as unknown as XrpcServer,
      {} as AppContext,
    )
    expect(method).not.toHaveBeenCalled()
  })
  it('validates lexicon input before mutation and exposes no deletion method', async () => {
    for (const body of [
      { name: 'bad' },
      { name: 'bad', settings: { ...settings, appAccess: 'unknown' } },
      { name: 'bad', settings: { ...settings, listed: 'yes' } },
    ]) {
      const res = await post('createBoundary', body)
      expect(res.status, await res.clone().text()).toBe(400)
    }
    expect(
      (
        await post('deactivateBoundary', {
          boundary: `${SERVICE}/general`,
          revision: 0,
        })
      ).status,
    ).toBe(400)
    expect(
      (await post('deleteBoundary', { boundary: `${SERVICE}/general` })).status,
    ).toBe(501)
  })
  it('creates, edits, lists, deactivates and reactivates a boundary without restoring members', async () => {
    const createdResponse = await post('createBoundary', {
      name: 'bebop',
      settings,
    })
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(
      200,
    )
    const { boundary: created } = (await createdResponse.json()) as {
      boundary: BoundaryDetails
    }
    expect(created).toMatchObject({
      boundary: `${SERVICE}/bebop`,
      status: 'active',
      memberCount: 0,
      revision: 1,
    })
    const editedResponse = await post('updateBoundary', {
      boundary: created.boundary,
      revision: created.revision,
      settings: { ...settings, displayName: 'Bebop crew' },
    })
    expect(editedResponse.status, await editedResponse.clone().text()).toBe(200)
    const { boundary: edited } = (await editedResponse.json()) as {
      boundary: BoundaryDetails
    }
    const publicRooms = await fetch(url('server.listRooms'))
    expect(publicRooms.status).toBe(200)
    expect(await publicRooms.json()).toEqual({
      rooms: [
        {
          id: 'bebop',
          boundary: created.boundary,
          displayName: 'Bebop crew',
          description: settings.description,
          available: true,
        },
      ],
    })
    const member = 'did:web:jet.example'
    await server.server.ctx.enrollmentStore.enroll({
      did: member,
      active: true,
      isService: true,
      boundaries: [created.boundary],
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zJet',
    })
    const listed = await fetch(url('admin.listBoundaries'), {
      headers: { cookie },
    })
    expect(listed.status, await listed.clone().text()).toBe(200)
    expect(
      (
        (await listed.json()) as { boundaries: BoundaryDetails[] }
      ).boundaries.find((d) => d.boundary === created.boundary),
    ).toMatchObject({ memberCount: 1 })
    const stale = await post('deactivateBoundary', {
      boundary: created.boundary,
      revision: 1,
    })
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({ error: 'BoundaryConflict' })
    const deactivated = await post('deactivateBoundary', {
      boundary: created.boundary,
      revision: edited.revision,
    })
    expect(deactivated.status, await deactivated.clone().text()).toBe(200)
    const { boundary: inactive } = (await deactivated.json()) as {
      boundary: BoundaryDetails
    }
    expect(inactive).toMatchObject({ status: 'inactive', memberCount: 0 })
    expect(
      await server.server.ctx.enrollmentStore.getBoundaries(member),
    ).toEqual([`${SERVICE}/general`])
    expect(await (await fetch(url('server.listRooms'))).json()).toMatchObject({
      rooms: [{ available: false }],
    })
    expect(
      (
        await post('reactivateBoundary', {
          boundary: inactive.boundary,
          revision: inactive.revision,
        })
      ).status,
    ).toBe(200)
    expect(
      await server.server.ctx.enrollmentStore.getBoundaries(member),
    ).toEqual([`${SERVICE}/general`])
  })
  it('returns only active boundaries held by the authenticated service', async () => {
    const ctx = server.server.ctx
    const keypair = await Secp256k1Keypair.create()
    const did = 'did:web:ed.example'
    vi.spyOn(ctx.idResolver.did, 'resolve').mockResolvedValue({
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: keypair.did().slice('did:key:'.length),
        },
      ],
    })
    const method = 'zone.stratos.sync.listBoundaries'
    const token = await createServiceJwt({
      iss: did,
      aud: SERVICE,
      lxm: method,
      keypair,
    })
    const read = () =>
      fetch(`${server.url}/xrpc/${method}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    expect((await fetch(`${server.url}/xrpc/${method}`)).status).toBe(401)
    const missing = await read()
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({
      message: 'Service enrollment required',
    })
    await ctx.enrollmentStore.enroll({
      did,
      active: true,
      isService: false,
      boundaries: [`${SERVICE}/general`],
      enrolledAt: new Date().toISOString(),
      signingKeyDid: keypair.did(),
    })
    expect((await read()).status).toBe(401)
    await ctx.enrollmentStore.updateEnrollment(did, { isService: true })
    const response = await read()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      boundaries: [
        {
          boundary: `${SERVICE}/general`,
          roomId: 'general',
          displayName: 'general',
          description: '',
          listed: false,
          joinable: false,
          revision: 1,
        },
      ],
    })
    const definition = await ctx.boundaryManager!.create(
      'catalog-race',
      settings,
    )
    await ctx.enrollmentStore.addBoundary(did, definition.boundary)
    const getBoundaries = ctx.enrollmentStore.getBoundaries.bind(
      ctx.enrollmentStore,
    )
    const stale = vi
      .spyOn(ctx.enrollmentStore, 'getBoundaries')
      .mockImplementationOnce(async (caller) => {
        const boundaries = await getBoundaries(caller)
        await ctx.boundaryStore!.beginDeactivation(
          definition.boundary,
          definition.revision,
        )
        return boundaries
      })
    const duringDeactivation = await read()
    expect(duringDeactivation.status).toBe(200)
    expect(
      (
        (await duringDeactivation.json()) as {
          boundaries: { boundary: string }[]
        }
      ).boundaries.map((entry) => entry.boundary),
    ).toEqual([`${SERVICE}/general`])
    stale.mockRestore()
    await ctx.boundaryManager!.drain()
    await ctx.enrollmentStore.updateEnrollment(did, { active: false })
    expect((await read()).status).toBe(401)
    vi.restoreAllMocks()
  })
  it('mints and authenticates credentials using the current catalog revision', async () => {
    const ctx = server.server.ctx
    const created = await ctx.boundaryManager!.create('credential', settings)
    const did = 'did:plc:rei'
    await ctx.enrollmentStore.enroll({
      did,
      active: true,
      isService: true,
      boundaries: [created.boundary],
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zRei',
    })
    const space = makeSpaceUri(SERVICE, 'zone.stratos.space.feed', 'credential')
    const mint = () =>
      fetch(url('space.getSpaceCredential'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${did}`,
        },
        body: JSON.stringify({ space }),
      })
    const response = await mint()
    expect(response.status, await response.clone().text()).toBe(200)
    const { credential } = (await response.json()) as { credential: string }
    const authenticate = () =>
      ctx.authVerifier.spaceCredential({
        req: {
          headers: { authorization: `Bearer ${credential}` },
          method: 'GET',
          url: '/xrpc/zone.stratos.space.getRecord',
        },
        res: {},
      } as Parameters<typeof ctx.authVerifier.spaceCredential>[0])
    expect(await authenticate()).toEqual({
      credentials: { type: 'space-credential', spaceUri: space },
    })
    await ctx.boundaryManager!.update(
      created.boundary,
      { ...settings, joinable: false },
      1,
    )
    await expect(authenticate()).rejects.toThrow('Authorization failed')
    const refreshed = await mint()
    expect(refreshed.status).toBe(200)
    const { credential: newCredential } = (await refreshed.json()) as {
      credential: string
    }
    expect(
      JSON.parse(
        Buffer.from(newCredential.split('.')[1], 'base64url').toString(),
      ).stratosBoundaryRevision,
    ).toBe(2)
    await ctx.boundaryManager!.deactivate(created.boundary, 2)
    const unavailable = await mint()
    expect(unavailable.status).toBe(400)
    expect(await unavailable.json()).toMatchObject({
      error: 'UnknownSpace',
      message: 'Space is unavailable',
    })
  })
  it('cannot mint a new-revision credential using membership read before deactivation', async () => {
    const ctx = server.server.ctx
    const definition = await ctx.boundaryManager!.create('race', settings)
    const did = 'did:plc:asuka'
    await ctx.enrollmentStore.enroll({
      did,
      active: true,
      isService: true,
      boundaries: [definition.boundary],
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zAsuka',
    })
    const read = ctx.enrollmentStore.getBoundaries.bind(ctx.enrollmentStore)
    let changePending = true
    const spy = vi
      .spyOn(ctx.enrollmentStore, 'getBoundaries')
      .mockImplementation(async (requestedDid) => {
        const boundaries = await read(requestedDid)
        if (changePending && requestedDid === did) {
          changePending = false
          await ctx.boundaryManager!.deactivate(definition.boundary, 1)
          await ctx.boundaryManager!.reactivate(definition.boundary, 3)
        }
        return boundaries
      })
    const response = await fetch(url('space.getSpaceCredential'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${did}`,
      },
      body: JSON.stringify({
        space: makeSpaceUri(SERVICE, 'zone.stratos.space.feed', 'race'),
      }),
    })
    expect(response.status, await response.clone().text()).toBe(400)
    expect(await response.json()).toMatchObject({
      error: 'UnknownSpace',
      message: 'Space changed during authorization',
    })
    expect(await read(did)).not.toContain(definition.boundary)
    spy.mockRestore()
  })
  it('reads persisted application policy and rejects a missing or lost catalog definition', async () => {
    const ctx = server.server.ctx
    const definition = await ctx.boundaryManager!.create('policy', settings)
    const did = 'did:plc:kensuke'
    await ctx.enrollmentStore.enroll({
      did,
      active: true,
      isService: true,
      boundaries: [definition.boundary],
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zKensuke',
    })
    const mint = (name: string, clientAttestation?: string) =>
      fetch(url('space.getSpaceCredential'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${did}`,
        },
        body: JSON.stringify({
          space: makeSpaceUri(SERVICE, 'zone.stratos.space.feed', name),
          clientAttestation,
        }),
      })
    const missing = await mint('missing')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({
      error: 'UnknownSpace',
      message: 'Space is unavailable',
    })
    await ctx.boundaryStore!.update(
      definition.boundary,
      {
        ...settings,
        appAccess: 'allowList',
        clientIds: ['https://bebop.example'],
      },
      1,
    )
    const gated = await mint('policy')
    expect(gated.status).toBe(400)
    expect(await gated.json()).toMatchObject({ error: 'AttestationRequired' })
    const client = await makeClient()
    const originalCache = ctx.cache
    const originalResolver = ctx.jwksResolver
    const used = new Set<string>()
    ctx.cache = {
      setNxEx: async (key: string) => {
        if (used.has(key)) return false
        used.add(key)
        return true
      },
    } as unknown as AppContext['cache']
    ctx.jwksResolver = resolverFor([client])
    const denied = await mint(
      'policy',
      await mintAttestation({ client, serviceDid: SERVICE }),
    )
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: 'ClientNotAllowed' })
    await ctx.boundaryStore!.update(
      definition.boundary,
      { ...settings, appAccess: 'allowList', clientIds: [client.clientId] },
      2,
    )
    const permitted = await mint(
      'policy',
      await mintAttestation({ client, serviceDid: SERVICE }),
    )
    expect(permitted.status, await permitted.clone().text()).toBe(200)
    ctx.cache = originalCache
    ctx.jwksResolver = originalResolver
    await ctx.boundaryStore!.update(definition.boundary, settings, 3)
    const get = ctx.boundaryStore!.get.bind(ctx.boundaryStore)
    let reads = 0
    const spy = vi
      .spyOn(ctx.boundaryStore!, 'get')
      .mockImplementation((boundary) => {
        if (boundary === definition.boundary && ++reads === 2)
          return Promise.resolve(null)
        return get(boundary)
      })
    const lost = await mint('policy')
    expect(lost.status).toBe(400)
    expect(await lost.json()).toMatchObject({
      error: 'UnknownSpace',
      message: 'Space changed during authorization',
    })
    spy.mockRestore()
  })
  it('refreshes public discovery and admin grant validation after another process creates a boundary', async () => {
    const ctx = server.server.ctx
    const source = (await ctx.boundaryStore!.get(`${SERVICE}/general`))!
    const create = async (name: string) => {
      const definition = {
        ...source,
        ...settings,
        boundary: `${SERVICE}/${name}`,
        roomId: name,
      }
      await ctx.boundaryStore!.create(definition)
      expect(ctx.cfg.stratos.allowedDomains).not.toContain(definition.boundary)
      return definition
    }
    const listed = await create('discovered')
    const discovery = await fetch(url('server.listDomains'))
    expect(discovery.status).toBe(200)
    expect(await discovery.json()).toMatchObject({
      domains: expect.arrayContaining([listed.boundary]),
    })
    const room = await create('oauth-room')
    const rooms = await fetch(`${server.url}/oauth/boundaries`)
    expect(rooms.status).toBe(200)
    expect(await rooms.json()).toMatchObject({
      rooms: expect.arrayContaining([
        expect.objectContaining({ id: room.roomId }),
      ]),
    })
    const did = 'did:plc:toji'
    await ctx.enrollmentStore.enroll({
      did,
      active: true,
      boundaries: [],
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zToji',
    })
    const added = await create('added')
    const add = await post('addBoundary', { did, boundary: added.boundary })
    expect(add.status, await add.clone().text()).toBe(200)
    expect(await ctx.enrollmentStore.getBoundaries(did)).toContain(
      added.boundary,
    )
    const replaced = await create('replaced')
    const set = await post('setBoundaries', {
      did,
      boundaries: [replaced.boundary],
    })
    expect(set.status, await set.clone().text()).toBe(200)
    expect(await ctx.enrollmentStore.getBoundaries(did)).toEqual([
      `${SERVICE}/general`,
      replaced.boundary,
    ])
  })
})
