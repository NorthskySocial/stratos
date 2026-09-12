import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('guards every grant entry point while permitting revocation and metadata edits', async () => {
    await h.store.beginDeactivation(ENGINEERING, 1)
    const original = await h.raw.getEnrollment('did:plc:spike')
    await expect(
      h.members.enroll({ ...original!, boundaries: [ENGINEERING] }),
    ).rejects.toMatchObject({ code: 'BoundaryUnavailable' })
    await expect(
      h.members.setBoundaries('did:plc:spike', [ENGINEERING]),
    ).rejects.toMatchObject({ code: 'BoundaryUnavailable' })
    await expect(
      h.members.addBoundary('did:plc:spike', ENGINEERING),
    ).rejects.toMatchObject({ code: 'BoundaryUnavailable' })
    await expect(
      h.members.updateEnrollment('did:plc:spike', {
        boundaries: [ENGINEERING],
      }),
    ).rejects.toMatchObject({ code: 'BoundaryUnavailable' })
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
