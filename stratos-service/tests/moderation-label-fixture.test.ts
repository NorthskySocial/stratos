import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import axios from 'axios'
import express from 'express'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  stratosLexicons,
  type LabelSubjectKind,
} from '@northskysocial/stratos-core'

import type { AppContext } from '../src/context-types.js'
import {
  closeServiceDb,
  createServiceDb,
  migrateServiceDb,
  type ServiceDb,
} from '../src/db'
import {
  QUERY_LABELS_METHOD,
  registerModerationHandlers,
  SqliteLabelStore,
} from '../src/features/moderation/index.js'
import { createAuthVerifiers } from '../src/infra/auth/verifiers.js'
import { SqliteAdminSessionStore } from '../src/oauth/admin-session-store.js'
import { SqliteAdminUserStore } from '../src/oauth/admin-user-store.js'
import { createTestConfig } from './utils'
import { makeSpaceUri } from './helpers/space-uri.js'
import { buildSqliteMembershipStores } from './helpers/enrollment-holds.js'

// The Rust feed generator parses the same file in its conformance tests, so
// the two sides cannot drift apart unnoticed.
const FIXTURE_URL = new URL(
  '../../stratos-feedgen/testdata/conformance/v1/moderation-labels.json',
  import.meta.url,
)

const SERVICE_DID = 'did:web:stratos.test'
const TOKYO3 = `${SERVICE_DID}/tokyo-3`
const GEOFRONT = `${SERVICE_DID}/geofront`
const RESERVED = `${SERVICE_DID}/general`
const POST_COLLECTION = 'zone.stratos.feed.post'
const ASUKA_DID = 'did:plc:asuka'
const REI_POST = `at://did:plc:rei-ayanami/${POST_COLLECTION}/eva-00`
const ASUKA_SPACE_POST = `${makeSpaceUri(SERVICE_DID, 'zone.stratos.space.feed', 'tokyo-3')}/${ASUKA_DID}/${POST_COLLECTION}/eva-02`
const SHINJI_GEOFRONT_POST = `at://did:plc:shinji-ikari/${POST_COLLECTION}/eva-01`

interface LabelFixture {
  version: number
  serviceInTokyo3: unknown
  moderationService: unknown
}

function didDocumentFor(keypair: Secp256k1Keypair) {
  return {
    id: keypair.did(),
    verificationMethod: [
      {
        id: `${keypair.did()}#key`,
        type: 'Multikey',
        controller: keypair.did(),
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
  }
}

describe('the shared moderation label fixture', () => {
  let dataDir: string
  let db: ServiceDb
  let labelStore: SqliteLabelStore
  let moderator: Secp256k1Keypair
  let nerv: Secp256k1Keypair
  let httpServer: http.Server
  let baseUrl: string

  async function append(
    subject: { subjectKey: string; kind: LabelSubjectKind },
    boundaries: string[],
    createdAt: string,
    ref?: string,
  ) {
    const latest = await labelStore.latestForSubject(subject.subjectKey)
    const result = await labelStore.appendIfLatest(latest?.seq ?? null, {
      subjectKey: subject.subjectKey,
      subjectKind: subject.kind,
      val: '!takedown',
      neg: false,
      boundaries,
      createdBy: moderator.did(),
      createdAt,
      ...(ref === undefined ? {} : { ref }),
    })
    if (result.kind !== 'appended') throw new Error('seed append lost')
  }

  async function query(caller: Secp256k1Keypair) {
    const token = await createServiceJwt({
      iss: caller.did(),
      aud: SERVICE_DID,
      lxm: QUERY_LABELS_METHOD,
      keypair: caller,
    })
    return axios.get(`${baseUrl}/xrpc/${QUERY_LABELS_METHOD}`, {
      headers: { authorization: `Bearer ${token}` },
      validateStatus: () => true,
    })
  }

  function fixture(): LabelFixture {
    return JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as LabelFixture
  }

  beforeEach(async () => {
    dataDir = join(
      tmpdir(),
      `stratos-label-fixture-${randomBytes(8).toString('hex')}`,
    )
    await mkdir(dataDir, { recursive: true })
    db = createServiceDb(join(dataDir, 'service.sqlite'))
    await migrateServiceDb(db)
    labelStore = new SqliteLabelStore(db, join(dataDir, 'service.sqlite'))
    const { members, catalog } = await buildSqliteMembershipStores(db, {
      serviceDid: SERVICE_DID,
      reservedBoundary: RESERVED,
      boundaries: [TOKYO3, GEOFRONT],
    })

    moderator = await Secp256k1Keypair.create({ exportable: true })
    nerv = await Secp256k1Keypair.create({ exportable: true })
    const documents = new Map(
      [moderator, nerv].map((keypair) => [
        keypair.did(),
        didDocumentFor(keypair),
      ]),
    )
    const idResolver = {
      did: { resolve: async (did: string) => documents.get(did) },
    } as unknown as IdResolver
    const cfg = createTestConfig(dataDir)
    cfg.moderationServiceDids = [moderator.did()]
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const ctx = {
      cfg,
      serviceDid: SERVICE_DID,
      labelStore,
      enrollmentStore: members,
      boundaryStore: catalog,
      logger,
      authVerifier: createAuthVerifiers(
        cfg.service.did,
        idResolver,
        cfg,
        members,
        new SqliteAdminSessionStore(db),
        new SqliteAdminUserStore(db),
        [],
        {} as never,
        undefined,
        true,
        await Secp256k1Keypair.create(),
        undefined,
        logger,
      ),
    } as unknown as AppContext

    await members.enroll({
      did: nerv.did(),
      enrolledAt: '1995-10-04T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:zNerv',
      boundaries: [TOKYO3],
      isService: true,
    })
    await members.enroll({
      did: ASUKA_DID,
      enrolledAt: '1995-10-04T00:00:00.000Z',
      active: true,
      signingKeyDid: 'did:key:zAsuka',
      boundaries: [TOKYO3],
      custody: 'pds',
    })
    await append(
      { subjectKey: REI_POST, kind: 'record' },
      [TOKYO3],
      '1995-10-04T00:00:01.000Z',
      'case-0401',
    )
    await append(
      { subjectKey: ASUKA_SPACE_POST, kind: 'record' },
      [TOKYO3],
      '1995-10-04T00:00:02.000Z',
    )
    await append(
      { subjectKey: SHINJI_GEOFRONT_POST, kind: 'record' },
      [GEOFRONT],
      '1995-10-04T00:00:03.000Z',
    )
    await append(
      { subjectKey: ASUKA_DID, kind: 'account' },
      [],
      '1995-10-04T00:00:04.000Z',
    )

    const server = new XrpcServer(stratosLexicons)
    registerModerationHandlers(server, ctx)
    const app = express()
    app.use(server.router)
    httpServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve))
    await closeServiceDb(db)
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a service enrolled in tokyo-3 gets exactly the scoped page in the fixture', async () => {
    const res = await query(nerv)

    expect(res.status).toBe(200)
    expect(fixture().version).toBe(1)
    expect(res.data).toEqual(fixture().serviceInTokyo3)
    expect(JSON.stringify(res.data)).not.toContain(SHINJI_GEOFRONT_POST)
  })

  it('the moderation service gets exactly the full page in the fixture', async () => {
    const res = await query(moderator)

    expect(res.status).toBe(200)
    expect(res.data).toEqual(fixture().moderationService)
    expect(JSON.stringify(res.data)).toContain(SHINJI_GEOFRONT_POST)
  })
})
