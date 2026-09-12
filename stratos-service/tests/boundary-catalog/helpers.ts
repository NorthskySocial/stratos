import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createServiceDb,
  migrateServiceDb,
  closeServiceDb,
} from '../../src/db/index.js'
import { migrateSqliteBoundaries } from '../../src/features/boundary/migrate.js'
import { createSqliteBoundaryStore } from '../../src/features/boundary/store.js'
import {
  BoundaryConfiguration,
  initialBoundaryDefinitions,
} from '../../src/features/boundary/configuration.js'
import { BoundaryManager } from '../../src/features/boundary/manager.js'
import { ActiveBoundaryEnrollmentStore } from '../../src/features/boundary/enrollment-store.js'
import { SqliteEnrollmentStore } from '../../src/storage/sqlite/enrollment-store.js'
import { ReservedDomainEnrollmentStore } from '../../src/infra/storage/reserved-domain-enrollment-store.js'
import { createTestConfig } from '../utils/index.js'
import type { BoundarySettings } from '@northskysocial/stratos-core'

export const SERVICE = 'did:web:nerv.tokyo.jp'
export const GENERAL = `${SERVICE}/general`
export const ENGINEERING = `${SERVICE}/engineering`
export const settings: BoundarySettings = {
  displayName: 'Bebop',
  description: 'A place for the Bebop crew.',
  listed: true,
  joinable: true,
  autoEnroll: false,
  appAccess: 'open',
  clientIds: [],
}
export async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'stratos-boundaries-'))
  const db = createServiceDb(join(dir, 'service.sqlite'))
  await migrateServiceDb(db)
  await migrateSqliteBoundaries(db)
  const store = createSqliteBoundaryStore(db)
  const cfg = createTestConfig(dir)
  cfg.service.did = SERVICE
  cfg.stratos.serviceDid = SERVICE
  const seeds = initialBoundaryDefinitions(cfg)
  await store.initialize(seeds)
  const configuration = new BoundaryConfiguration(store, cfg)
  await configuration.refresh()
  const raw = new SqliteEnrollmentStore(db)
  const members = new ActiveBoundaryEnrollmentStore(
    new ReservedDomainEnrollmentStore(raw, GENERAL),
    store,
  )
  const removals: string[] = []
  const errors: unknown[] = []
  const manager = new BoundaryManager({
    store,
    configuration,
    serviceDid: SERVICE,
    reservedBoundary: GENERAL,
    removeMembership: async (did, boundary) => {
      await members.removeBoundary(did, boundary)
      removals.push(did)
    },
    onError: (err) => errors.push(err),
  })
  async function enroll(
    did = 'did:plc:spike',
    boundaries = [ENGINEERING],
    active = true,
    isService = false,
  ) {
    await members.enroll({
      did,
      boundaries,
      active,
      isService,
      enrolledAt: '2026-09-12T15:00:00.000Z',
      signingKeyDid: 'did:key:spike',
    })
  }
  return {
    dir,
    db,
    store,
    cfg,
    configuration,
    raw,
    members,
    manager,
    seeds,
    enroll,
    removals,
    errors,
    cleanup: async () => {
      await manager.stop()
      await closeServiceDb(db)
      await rm(dir, { recursive: true, force: true })
    },
  }
}
export type Harness = Awaited<ReturnType<typeof setup>>
