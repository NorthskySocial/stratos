import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  setup,
  type Harness,
  ENGINEERING,
  GENERAL,
  SERVICE,
  settings,
} from './helpers.js'
import { BoundaryManager } from '../../src/features/boundary/manager.js'
import { migrateSqliteBoundaries } from '../../src/features/boundary/migrate.js'
import { createSqliteBoundaryStore } from '../../src/features/boundary/store.js'

describe('persistent boundary lifecycle', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
  })
  afterEach(async () => {
    await h.cleanup()
  })
  it('imports settings once and preserves edits and identities across restart', async () => {
    const created = await h.manager.create('bebop', settings)
    expect(created).toMatchObject({
      ...settings,
      boundary: `${SERVICE}/bebop`,
      roomId: 'bebop',
      status: 'active',
      revision: 1,
      memberCount: 0,
      reserved: false,
    })
    expect(created.createdAt).toMatch(/^\d{4}-/)
    const edited = await h.manager.update(
      created.boundary,
      {
        ...settings,
        displayName: 'Faye',
        description: 'Night shift',
        appAccess: 'allowList',
        clientIds: ['https://bebop.example/client.json'],
        autoEnroll: true,
        listed: false,
        joinable: false,
      },
      1,
    )
    await migrateSqliteBoundaries(h.db)
    const reopened = createSqliteBoundaryStore(h.db)
    await reopened.initialize(h.seeds)
    const { memberCount: _count, reserved: _reserved, ...persisted } = edited
    expect(await reopened.get(created.boundary)).toEqual(persisted)
    expect(edited).toMatchObject({
      revision: 2,
      roomId: 'bebop',
      displayName: 'Faye',
      appAccess: 'allowList',
      listed: false,
      joinable: false,
      autoEnroll: true,
    })
    expect((await h.manager.list()).map((d) => d.boundary)).toEqual([
      `${SERVICE}/bebop`,
      `${SERVICE}/design`,
      ENGINEERING,
      GENERAL,
    ])
    expect(await reopened.get('missing')).toBeNull()
  })
  it('rolls back an incomplete import so retry imports the entire catalog', async () => {
    await h.db.run(sql`DELETE FROM boundary_catalog_state`)
    await h.db.run(sql`DELETE FROM boundary_definition`)
    await expect(
      h.store.initialize([
        h.seeds[0],
        { ...h.seeds[1], roomId: h.seeds[0].roomId },
      ]),
    ).rejects.toThrow()
    expect(await h.store.list()).toEqual([])
    await h.store.initialize(h.seeds)
    expect(await h.store.list()).toHaveLength(3)
  })
  it('removes active, inactive and service members while preserving other memberships', async () => {
    await h.enroll('did:plc:spike')
    await h.enroll('did:plc:faye', [ENGINEERING], false)
    await h.enroll('did:web:bebop.example', [ENGINEERING], true, true)
    expect(await h.store.countMembers(ENGINEERING)).toBe(3)
    const result = await h.manager.deactivate(ENGINEERING, 1)
    expect(result).toMatchObject({
      status: 'inactive',
      memberCount: 0,
      revision: 3,
    })
    expect(h.removals.sort()).toEqual([
      'did:plc:faye',
      'did:plc:spike',
      'did:web:bebop.example',
    ])
    expect(await h.raw.getBoundaries('did:plc:spike')).toEqual([GENERAL])
    expect(await h.raw.getEnrollment('did:plc:faye')).toMatchObject({
      active: false,
    })
    expect(await h.manager.deactivate(ENGINEERING, 1)).toMatchObject({
      status: 'inactive',
    })
    await expect(
      h.members.addBoundary('did:plc:spike', ENGINEERING),
    ).rejects.toMatchObject({ code: 'BoundaryUnavailable' })
    expect(await h.manager.reactivate(ENGINEERING, 3)).toMatchObject({
      status: 'active',
      memberCount: 0,
      revision: 4,
    })
    expect(await h.members.getBoundaries('did:plc:spike')).toEqual([GENERAL])
    await h.members.addBoundary('did:plc:spike', ENGINEERING)
    expect(await h.members.getBoundaries('did:plc:spike')).toContain(
      ENGINEERING,
    )
  })
  it('persists the grant fence and pending invalidation if a process dies after removal', async () => {
    await h.enroll()
    expect(await h.store.beginDeactivation(ENGINEERING, 1)).toBe(true)
    await h.members.removeBoundary('did:plc:spike', ENGINEERING)
    expect(await h.store.finishDeactivation(ENGINEERING)).toBe(false)
    expect(await h.store.listDeactivationMembers(ENGINEERING, 1)).toEqual([
      'did:plc:spike',
    ])
    await h.manager.drain()
    expect(h.removals).toEqual(['did:plc:spike'])
    expect(await h.store.listDeactivationMembers(ENGINEERING, 1)).toEqual([])
    expect(await h.store.get(ENGINEERING)).toMatchObject({ status: 'inactive' })
  })
  it('rejects direct database grants and updates once deactivation starts', async () => {
    await h.enroll()
    await h.store.beginDeactivation(ENGINEERING, 1)
    await expect(
      h.raw.addBoundary('did:plc:faye', ENGINEERING),
    ).rejects.toThrow()
    await expect(
      h.db.run(
        sql`UPDATE enrollment_boundary SET boundary = ${ENGINEERING} WHERE boundary = ${GENERAL}`,
      ),
    ).rejects.toThrow()
    expect(await h.store.finishDeactivation(ENGINEERING)).toBe(false)
    expect(await h.store.reactivate(ENGINEERING, 2)).toBe(false)
    expect(await h.store.update(ENGINEERING, settings, 2)).toBe(false)
    expect(await h.store.beginDeactivation(ENGINEERING, 2)).toBe(false)
  })
  it('processes at most 100 memberships per boundary in a pass and resumes', async () => {
    for (let n = 0; n < 101; n++)
      await h.enroll(`did:plc:spike${String(n).padStart(3, '0')}`)
    expect(await h.manager.deactivate(ENGINEERING, 1)).toMatchObject({
      status: 'deactivating',
      memberCount: 1,
    })
    expect(h.removals).toHaveLength(100)
    await h.manager.drain()
    expect(await h.store.get(ENGINEERING)).toMatchObject({ status: 'inactive' })
    expect(h.removals).toHaveLength(101)
  })
  it('retries failed invalidation without starving other boundaries', async () => {
    await h.enroll()
    await h.enroll('did:plc:faye', [`${SERVICE}/design`])
    await h.store.beginDeactivation(ENGINEERING, 1)
    await h.store.beginDeactivation(`${SERVICE}/design`, 1)
    const remove = vi.fn(async (did: string, boundary: string) => {
      if (did === 'did:plc:spike') throw new Error('PDS queue unavailable')
      await h.members.removeBoundary(did, boundary)
    })
    const errors = vi.fn()
    const worker = new BoundaryManager({
      store: h.store,
      configuration: h.configuration,
      serviceDid: SERVICE,
      reservedBoundary: GENERAL,
      removeMembership: remove,
      onError: errors,
    })
    await worker.drain()
    expect(errors).toHaveBeenCalledOnce()
    expect(await h.store.get(`${SERVICE}/design`)).toMatchObject({
      status: 'inactive',
    })
    expect(await h.store.get(ENGINEERING)).toMatchObject({
      status: 'deactivating',
    })
    expect(await h.store.listDeactivationMembers(ENGINEERING, 100)).toEqual([
      'did:plc:spike',
    ])
    await worker.stop()
    await h.manager.drain()
    expect(await h.store.get(ENGINEERING)).toMatchObject({ status: 'inactive' })
  })
  it('requires the current revision and retains reserved boundary invariants', async () => {
    await expect(
      h.manager.update(ENGINEERING, settings, 42),
    ).rejects.toMatchObject({ code: 'BoundaryConflict' })
    await expect(h.manager.deactivate(ENGINEERING, 42)).rejects.toMatchObject({
      code: 'BoundaryConflict',
    })
    await expect(h.manager.reactivate(ENGINEERING, 1)).rejects.toMatchObject({
      code: 'BoundaryConflict',
    })
    await expect(h.manager.update(GENERAL, settings, 1)).rejects.toMatchObject({
      code: 'ReservedBoundary',
    })
    await expect(h.manager.deactivate(GENERAL, 1)).rejects.toMatchObject({
      code: 'ReservedBoundary',
    })
    await expect(h.manager.reactivate(GENERAL, 1)).rejects.toMatchObject({
      code: 'ReservedBoundary',
    })
    await expect(
      h.manager.create('engineering', settings),
    ).rejects.toMatchObject({ code: 'BoundaryExists' })
    for (const work of [
      () => h.manager.update('missing', settings, 1),
      () => h.manager.deactivate('missing', 1),
      () => h.manager.reactivate('missing', 1),
    ])
      await expect(work()).rejects.toMatchObject({ code: 'BoundaryNotFound' })
    expect(
      await h.manager.update(GENERAL, { ...settings, autoEnroll: true }, 1),
    ).toMatchObject({ reserved: true, revision: 2 })
  })
  it.each(['', 'a/b', '.', '..', 'a b', 'a'.repeat(129)])(
    'rejects invalid immutable name %s',
    async (name) => {
      await expect(h.manager.create(name, settings)).rejects.toThrow()
    },
  )
  it.each([
    { displayName: '' },
    { displayName: ' ' },
    { displayName: 'a'.repeat(121) },
    { description: 'a'.repeat(2001) },
    { appAccess: 'allowList', clientIds: [] },
    { appAccess: 'invalid' },
    { clientIds: Array(101).fill('https://bebop.example') },
    ...[
      'garbage',
      'http://bebop.example',
      'https://spike:secret@bebop.example',
      'https://spike@bebop.example',
      'https://bebop.example/#fragment',
    ].map((url) => ({ clientIds: [url] })),
  ])('rejects invalid settings %j', async (change) => {
    await expect(
      h.manager.create('bebop', { ...settings, ...change } as typeof settings),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
  })
  it('accepts maximum lengths and portable HTTPS client identifiers', async () => {
    expect(
      await h.manager.create('a'.repeat(128), {
        ...settings,
        displayName: 'a'.repeat(120),
        description: 'a'.repeat(2000),
        appAccess: 'allowList',
        clientIds: Array(100).fill('https://bebop.example/client?version=1'),
      }),
    ).toMatchObject({ status: 'active' })
  })
})
