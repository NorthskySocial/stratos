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
import {
  BoundaryConfiguration,
  initialBoundaryDefinitions,
} from '../../src/features/boundary/configuration.js'
import { createTestConfig } from '../utils/index.js'
import { ActiveBoundaryEnrollmentStore } from '../../src/features/boundary/enrollment-store.js'
import { reconcileServiceEnrollments } from '../../src/features/enrollment/service-reconciler.js'

describe('boundary configuration migration', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
  })
  afterEach(async () => {
    await h.cleanup()
  })
  it('imports public room metadata, IDs, app policy, and explicit auto-enrollment', () => {
    const cfg = createTestConfig(h.dir)
    cfg.service.did = SERVICE
    cfg.enrollment.autoEnrollDomains = [ENGINEERING]
    cfg.stratos.spaceAppAccess = {
      byBoundary: new Map([
        [
          ENGINEERING,
          { kind: 'allowList', clientIds: ['https://bebop.example'] },
        ],
      ]),
    }
    const room = {
      id: 'bebop',
      boundary: ENGINEERING,
      displayName: 'Bebop',
      description: 'Private crew room',
      available: false,
    }
    cfg.roomCatalog = { list: () => [room], get: () => room }
    expect(initialBoundaryDefinitions(cfg)).toEqual([
      expect.objectContaining({
        boundary: ENGINEERING,
        roomId: 'bebop',
        displayName: 'Bebop',
        description: 'Private crew room',
        listed: true,
        joinable: false,
        autoEnroll: true,
        appAccess: 'allowList',
        clientIds: ['https://bebop.example'],
      }),
      expect.objectContaining({
        boundary: `${SERVICE}/design`,
        roomId: 'design',
        listed: false,
        joinable: false,
        autoEnroll: false,
        appAccess: 'open',
        clientIds: [],
      }),
      expect.objectContaining({ boundary: GENERAL, autoEnroll: true }),
    ])
  })
  it('preserves legacy default enrollment when auto-enrollment was omitted or empty', () => {
    for (const autoEnrollDomains of [undefined, []]) {
      const cfg = createTestConfig(h.dir)
      cfg.service.did = SERVICE
      cfg.enrollment.autoEnrollDomains = autoEnrollDomains
      expect(initialBoundaryDefinitions(cfg).every((d) => d.autoEnroll)).toBe(
        true,
      )
    }
  })
  it('reserves explicit legacy room IDs before assigning collision-free hidden IDs', async () => {
    const cfg = createTestConfig(h.dir)
    cfg.stratos.allowedDomains = [GENERAL, ENGINEERING, `${SERVICE}/design`]
    const rooms = [
      {
        id: 'general',
        boundary: ENGINEERING,
        displayName: 'Bebop',
        description: '',
        available: true,
      },
      {
        id: 'general-2',
        boundary: `${SERVICE}/design`,
        displayName: 'Sailor Moon',
        description: '',
        available: true,
      },
    ]
    cfg.roomCatalog = {
      list: () => rooms,
      get: (id) => rooms.find((room) => room.id === id),
    }
    const definitions = initialBoundaryDefinitions(cfg)
    expect(definitions.map((d) => d.roomId)).toEqual([
      'general-3',
      'general',
      'general-2',
    ])
    expect(definitions[0]).toMatchObject({
      displayName: 'general',
      listed: false,
    })
    await h.db.run(sql`DELETE FROM boundary_catalog_state`)
    await h.db.run(sql`DELETE FROM boundary_definition`)
    await h.store.initialize(definitions)
    expect((await h.store.list()).map((d) => d.roomId).sort()).toEqual([
      'general',
      'general-2',
      'general-3',
    ])
  })
  it('updates shared array/map references and public rooms from persistent settings', async () => {
    const domains = h.cfg.stratos.allowedDomains
    const automatic = h.cfg.enrollment.autoEnrollDomains
    const policies = h.cfg.stratos.spaceAppAccess!.byBoundary
    const created = await h.manager.create('bebop', settings)
    expect(domains).toContain(created.boundary)
    expect(automatic).not.toContain(created.boundary)
    expect(h.configuration.rooms.list()).toEqual([
      {
        id: 'bebop',
        boundary: created.boundary,
        displayName: settings.displayName,
        description: settings.description,
        available: true,
      },
    ])
    expect(h.configuration.rooms.get('missing')).toBeUndefined()
    expect(h.cfg.roomCatalog).toBe(h.configuration.rooms)
    await h.manager.update(
      created.boundary,
      {
        ...settings,
        appAccess: 'allowList',
        clientIds: ['https://bebop.example'],
        autoEnroll: true,
      },
      1,
    )
    expect(automatic).toContain(created.boundary)
    expect(policies.get(created.boundary)).toEqual({
      kind: 'allowList',
      clientIds: ['https://bebop.example'],
    })
    await h.manager.deactivate(created.boundary, 2)
    expect(domains).not.toContain(created.boundary)
    expect(automatic).not.toContain(created.boundary)
    expect(policies.has(created.boundary)).toBe(false)
    expect(h.configuration.rooms.get('bebop')).toMatchObject({
      available: false,
    })
    expect(h.cfg.enrollment.autoEnrollDomains).toContain(GENERAL)
    expect(h.cfg.stratos.allowedDomains).toBe(domains)
    expect(h.cfg.enrollment.autoEnrollDomains).toBe(automatic)
    expect(h.cfg.stratos.spaceAppAccess!.byBoundary).toBe(policies)
  })
  it('restores persistent definitions even when legacy boundary config is removed', async () => {
    await h.manager.create('bebop', settings)
    const cfg = createTestConfig(h.dir)
    cfg.service.did = SERVICE
    cfg.stratos.allowedDomains = [GENERAL]
    Reflect.deleteProperty(cfg.stratos, 'spaceAppAccess')
    const restart = new BoundaryConfiguration(h.store, cfg)
    await h.store.initialize(initialBoundaryDefinitions(cfg))
    await restart.refresh()
    expect(cfg.stratos.allowedDomains).toContain(`${SERVICE}/bebop`)
    expect(
      cfg.stratos.spaceAppAccess?.byBoundary.get(`${SERVICE}/bebop`),
    ).toEqual({ kind: 'open' })
    expect(cfg.roomCatalog?.get('bebop')).toMatchObject({ available: true })
  })
  it('refuses startup if the configured reserved boundary changed or is inactive', async () => {
    const cfg = createTestConfig(h.dir)
    cfg.stratos.reservedDomain = `${SERVICE}/missing`
    await expect(
      new BoundaryConfiguration(h.store, cfg).refresh(),
    ).rejects.toThrow('reserved boundary must be active')
    await h.store.beginDeactivation(GENERAL, 1)
    await expect(h.configuration.refresh()).rejects.toThrow(
      'reserved boundary must be active',
    )
  })
  it('keeps admin-managed service membership across restart and reactivation', async () => {
    const entry = { did: 'did:web:bebop.example', boundaries: [ENGINEERING] }
    const reconcile = () =>
      reconcileServiceEnrollments([entry], {
        store: h.members,
        signingKeyDid: 'did:key:spike',
        resolveBoundaries: (e) =>
          h.configuration.serviceMemberships(e, h.members),
      })
    await reconcile()
    expect(await h.members.getBoundaries(entry.did)).toContain(ENGINEERING)
    await h.manager.deactivate(ENGINEERING, 1)
    await reconcile()
    expect(await h.members.getBoundaries(entry.did)).toEqual([GENERAL])
    await h.manager.reactivate(ENGINEERING, 3)
    await reconcile()
    expect(await h.members.getBoundaries(entry.did)).toEqual([GENERAL])
    await h.members.addBoundary(entry.did, `${SERVICE}/design`)
    await reconcile()
    expect(await h.members.getBoundaries(entry.did)).toEqual([
      `${SERVICE}/design`,
      GENERAL,
    ])
  })
  it('checks initial service grants against catalog existence and active status', async () => {
    await expect(
      h.configuration.serviceMemberships(
        { did: 'did:web:bebop.example', boundaries: [`${SERVICE}/missing`] },
        h.members,
      ),
    ).rejects.toThrow('unknown boundary')
    await h.manager.deactivate(ENGINEERING, 1)
    expect(
      await h.configuration.serviceMemberships(
        { did: 'did:web:bebop.example', boundaries: [ENGINEERING, GENERAL] },
        h.members,
      ),
    ).toEqual([GENERAL])
  })
  it('recovers from a failed refresh and serializes overlapping snapshots', async () => {
    const list = vi
      .spyOn(h.store, 'list')
      .mockRejectedValueOnce(new Error('database unavailable'))
    await expect(h.configuration.refresh()).rejects.toThrow(
      'database unavailable',
    )
    await h.configuration.refresh()
    let release!: (definitions: typeof h.seeds) => void
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const earlier = h.configuration.refresh()
    await Promise.resolve()
    await Promise.resolve()
    const callCount = list.mock.calls.length
    const later = h.configuration.refresh()
    await h.store.update(ENGINEERING, { ...settings, displayName: 'Faye' }, 1)
    expect(list).toHaveBeenCalledTimes(callCount)
    release(h.seeds)
    await Promise.all([earlier, later])
    expect(h.configuration.rooms.get('engineering')).toMatchObject({
      displayName: 'Faye',
    })
    list.mockRestore()
  })
})

describe('authoritative active-boundary enrollment reads and writes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
    await h.enroll()
  })
  afterEach(async () => {
    await h.cleanup()
  })
  it('hides inactive boundaries through every read surface even from a stale inner cache', async () => {
    const staleRecord = {
      did: 'did:plc:spike',
      boundaries: [ENGINEERING, GENERAL],
      active: true,
      enrolledAt: '2026-09-12T15:00:00.000Z',
      signingKeyDid: 'did:key:spike',
    }
    const cached = Object.create(h.members) as typeof h.members
    cached.getEnrollment = async () => staleRecord
    cached.getBoundaries = async () => [ENGINEERING, GENERAL]
    cached.listEnrollments = async () => [staleRecord]
    cached.listServiceEnrollments = async () => [staleRecord]
    cached.listEnrollmentsByBoundary = async () => [staleRecord]
    const guarded = new ActiveBoundaryEnrollmentStore(cached, h.store)
    await h.store.beginDeactivation(ENGINEERING, 1)
    expect(await guarded.getBoundaries('did:plc:spike')).toEqual([GENERAL])
    expect(await guarded.getEnrollment('did:plc:spike')).toMatchObject({
      boundaries: [GENERAL],
    })
    expect(await guarded.listEnrollments()).toEqual([
      { ...staleRecord, boundaries: [GENERAL] },
    ])
    expect(await guarded.listServiceEnrollments()).toEqual([
      { ...staleRecord, boundaries: [GENERAL] },
    ])
    expect(await guarded.listEnrollmentsByBoundary(ENGINEERING)).toEqual([])
    expect(await guarded.listEnrollmentsByBoundary(GENERAL)).toEqual([
      { ...staleRecord, boundaries: [GENERAL] },
    ])
    expect(await h.members.getEnrollment('missing')).toBeNull()
    expect(await h.members.listEnrollments()).toHaveLength(1)
    expect(await h.members.enrollmentCount()).toBe(1)
    expect(await h.members.isEnrolled('did:plc:spike')).toBe(true)
  })
  it('preserves optional boundary fields on metadata-only enrollment rows', async () => {
    const metadata = (await h.raw.getEnrollment('did:plc:spike'))!
    expect(metadata).not.toHaveProperty('boundaries')
    const reader = Object.create(h.members) as typeof h.members
    reader.getEnrollment = async () => metadata
    reader.listEnrollments = async () => [metadata]
    reader.listServiceEnrollments = async () => [metadata]
    reader.listEnrollmentsByBoundary = async () => [metadata]
    const guarded = new ActiveBoundaryEnrollmentStore(reader, h.store)
    expect(await guarded.getEnrollment(metadata.did)).toEqual(metadata)
    expect(await guarded.listEnrollments()).toEqual([metadata])
    expect(await guarded.listServiceEnrollments()).toEqual([metadata])
    expect(await guarded.listEnrollmentsByBoundary(GENERAL)).toEqual([metadata])
  })
  it('returns no members for an unknown boundary without consulting enrollment rows', async () => {
    const list = vi.spyOn(h.raw, 'listEnrollmentsByBoundary')
    expect(
      await h.members.listEnrollmentsByBoundary(`${SERVICE}/unknown`),
    ).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })
  it('allows enrollment without an explicit boundary list and retains the reserved membership', async () => {
    await h.members.enroll({
      did: 'did:plc:faye',
      active: true,
      enrolledAt: '2026-09-12T15:00:00.000Z',
      signingKeyDid: 'did:key:faye',
    })
    expect(await h.members.getBoundaries('did:plc:faye')).toEqual([GENERAL])
    expect(await h.raw.getBoundaries('did:plc:faye')).toEqual([GENERAL])
    expect(await h.members.isEnrolled('did:plc:faye')).toBe(true)
  })
  it('canonicalizes legacy memberships through the signed store before enabling admin lifecycle', async () => {
    await h.raw.enroll({
      did: 'did:plc:faye',
      active: true,
      boundaries: ['engineering', ENGINEERING, 'unknown'],
      enrolledAt: '2026-09-12T15:00:00.000Z',
      signingKeyDid: 'did:key:faye',
    })
    const queued: string[] = []
    expect(await h.store.listLegacyMembers(SERVICE, 1)).toEqual([
      'did:plc:faye',
    ])
    await h.members.normalizeLegacyMemberships(SERVICE, async (did) => {
      queued.push(did)
    })
    expect(queued).toEqual(['did:plc:faye', 'did:plc:faye'])
    expect(await h.raw.getBoundaries('did:plc:faye')).toEqual([
      ENGINEERING,
      GENERAL,
      'unknown',
    ])
    expect(await h.store.listLegacyMembers(SERVICE, 1)).toEqual([])
    const page = await h.audit.list('did:plc:faye')
    expect(page.operations.at(-1)?.operation.after.boundaries).toEqual([
      ENGINEERING,
      GENERAL,
      'unknown',
    ])
    await h.manager.deactivate(ENGINEERING, 1)
    await h.manager.reactivate(ENGINEERING, 3)
    expect(await h.members.getBoundaries('did:plc:faye')).toEqual([GENERAL])
  })

  it('guards every grant entry point while permitting revocation and metadata edits', async () => {
    await h.store.beginDeactivation(ENGINEERING, 1)
    const original = await h.raw.getEnrollment('did:plc:spike')
    await expect(
      h.members.enroll({ ...original!, boundaries: [ENGINEERING] }),
    ).rejects.toMatchObject({
      code: 'BoundaryUnavailable',
      message: 'The boundary is inactive or unavailable',
    })
    await expect(
      h.members.setBoundaries('did:plc:spike', [ENGINEERING]),
    ).rejects.toMatchObject({
      code: 'BoundaryUnavailable',
      message: 'The boundary is inactive or unavailable',
    })
    await expect(
      h.members.addBoundary('did:plc:spike', ENGINEERING),
    ).rejects.toMatchObject({
      code: 'BoundaryUnavailable',
      message: 'The boundary is inactive or unavailable',
    })
    await expect(
      h.members.updateEnrollment('did:plc:spike', {
        boundaries: [ENGINEERING],
      }),
    ).rejects.toMatchObject({
      code: 'BoundaryUnavailable',
      message: 'The boundary is inactive or unavailable',
    })
    await h.members.updateEnrollment('did:plc:spike', { active: false })
    expect(await h.members.isEnrolled('did:plc:spike')).toBe(false)
    await h.members.updateEnrollment('did:plc:spike', { boundaries: [GENERAL] })
    expect(await h.raw.getBoundaries('did:plc:spike')).toEqual([GENERAL])
    await h.members.unenroll('did:plc:spike')
    expect(await h.members.getEnrollment('did:plc:spike')).toBeNull()
    await h.enroll('did:plc:faye', [])
    expect(await h.members.getBoundaries('did:plc:faye')).toEqual([GENERAL])
  })
})
