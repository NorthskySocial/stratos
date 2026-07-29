import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { envToConfig, parseEnv } from '../src/config.js'
import { createServiceDb, migrateServiceDb, type ServiceDb } from '../src/db'
import { reconcileServiceEnrollments } from '../src/features/enrollment/index.js'
import { SqliteEnrollmentStore } from '../src/context.js'
import { ReservedDomainEnrollmentStore } from '../src/infra/storage/reserved-domain-enrollment-store.js'

const RESERVED = 'did:web:host/general'

const BASE_ENV: Record<string, string> = {
  STRATOS_SERVICE_DID: 'did:web:host',
  STRATOS_PUBLIC_URL: 'https://host.example.com',
  // `general` is the default reserved domain; it must appear in allowed domains.
  STRATOS_ALLOWED_DOMAINS: 'eng,ops,general',
}

const SIGNING_KEY_DID = 'did:key:z6MkBootKey'

/**
 * Boot-level integration: parse a real config file the way the service does on
 * startup, then run the reconciler against a real migrated SQLite enrollment
 * store and assert the resulting rows + boundaries. This mirrors the wiring in
 * `StratosServer.create` without standing up the full Express stack.
 */
describe('service enrollment boot reconciliation', () => {
  let saved: NodeJS.ProcessEnv
  let tmp: string
  let db: ServiceDb
  // Wrap in the reserved-domain decorator to mirror production wiring in
  // storage-context.ts, so the reconciler path force-includes the reserved
  // domain exactly as it does on a live boot.
  let store: ReservedDomainEnrollmentStore

  beforeEach(async () => {
    saved = { ...process.env }
    tmp = mkdtempSync(join(tmpdir(), 'stratos-svc-boot-'))
    db = createServiceDb(join(tmp, 'service.sqlite'))
    await migrateServiceDb(db)
    store = new ReservedDomainEnrollmentStore(
      new SqliteEnrollmentStore(db),
      RESERVED,
    )
  })

  afterEach(() => {
    process.env = saved
    rmSync(tmp, { recursive: true, force: true })
  })

  it('boots with a config file and writes service rows with boundaries', async () => {
    const file = join(tmp, 'enrollments.json')
    writeFileSync(
      file,
      JSON.stringify([
        { did: 'did:web:spiegel.appview', boundaries: ['eng'] },
        { did: 'did:web:vash.appview', boundaries: ['eng', 'ops'] },
      ]),
    )
    process.env = {
      ...BASE_ENV,
      STRATOS_SERVICE_ENROLLMENTS_FILE: file,
    } as NodeJS.ProcessEnv

    const config = envToConfig(parseEnv())

    await reconcileServiceEnrollments(config.enrollment.serviceEnrollments, {
      store,
      signingKeyDid: SIGNING_KEY_DID,
    })

    const spiegel = await store.getEnrollment('did:web:spiegel.appview')
    expect(spiegel?.isService).toBe(true)
    expect(spiegel?.active).toBe(true)
    expect(spiegel?.signingKeyDid).toBe(SIGNING_KEY_DID)
    expect(spiegel?.pdsEndpoint).toBeUndefined()
    // The reserved domain is force-included in every service enrollment.
    // Boundary order is not semantically meaningful, so compare as sets.
    expect(
      (await store.getBoundaries('did:web:spiegel.appview')).sort(),
    ).toEqual(['did:web:host/eng', RESERVED].sort())

    const vash = await store.getEnrollment('did:web:vash.appview')
    expect(vash?.isService).toBe(true)
    expect((await store.getBoundaries('did:web:vash.appview')).sort()).toEqual(
      ['did:web:host/eng', 'did:web:host/ops', RESERVED].sort(),
    )

    const services = await store.listServiceEnrollments()
    expect(services.map((e) => e.did).sort()).toEqual([
      'did:web:spiegel.appview',
      'did:web:vash.appview',
    ])
  })

  it('prunes a previously-booted service row dropped from the config file', async () => {
    const file = join(tmp, 'enrollments.json')

    // First boot: two services declared.
    writeFileSync(
      file,
      JSON.stringify([
        { did: 'did:web:spiegel.appview', boundaries: ['eng'] },
        { did: 'did:web:vash.appview', boundaries: ['ops'] },
      ]),
    )
    process.env = {
      ...BASE_ENV,
      STRATOS_SERVICE_ENROLLMENTS_FILE: file,
    } as NodeJS.ProcessEnv
    await reconcileServiceEnrollments(
      envToConfig(parseEnv()).enrollment.serviceEnrollments,
      { store, signingKeyDid: SIGNING_KEY_DID },
    )

    // Second boot: one service dropped from the file.
    writeFileSync(
      file,
      JSON.stringify([{ did: 'did:web:spiegel.appview', boundaries: ['eng'] }]),
    )
    await reconcileServiceEnrollments(
      envToConfig(parseEnv()).enrollment.serviceEnrollments,
      { store, signingKeyDid: SIGNING_KEY_DID },
    )

    expect(await store.getEnrollment('did:web:vash.appview')).toBeNull()
    expect(await store.getEnrollment('did:web:spiegel.appview')).not.toBeNull()
  })
})
