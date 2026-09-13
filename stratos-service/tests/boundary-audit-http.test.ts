import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestServer } from './helpers/test-server.js'
import { ADMIN_SESSION_COOKIE } from '../src/oauth/admin-routes.js'
import type {
  BoundaryHistoryPage,
  SignedBoundaryCheckpoint,
} from '../src/features/boundary-audit/index.js'
import { verifyBoundaryOperation } from '../src/features/boundary-audit/model.js'

const DID = 'did:plc:rei'
const ADMIN = 'did:plc:misato'

describe('boundary audit XRPC', () => {
  let server: TestServer
  let cookie: string

  beforeAll(async () => {
    server = await TestServer.create()
    const ctx = server.server.ctx
    ctx.cfg.adminDids.push(ADMIN)
    const session = await ctx.adminSessionStore.create(ADMIN, 60_000)
    cookie = `${ADMIN_SESSION_COOKIE}=${session}`
    await ctx.enrollmentStore.enroll({
      did: DID,
      active: true,
      enrolledAt: new Date().toISOString(),
      signingKeyDid: 'did:key:zRei',
      custody: 'pds',
      boundaries: ['did:web:test.stratos.actor/general'],
    })
    await server.start()
  }, 30_000)

  afterAll(async () => {
    await server?.stop()
  })

  it.each(['listBoundaryOps', 'getBoundaryAuditState'])(
    'denies anonymous and ordinary users at %s',
    async (method) => {
      const url = `${server.url}/xrpc/zone.stratos.admin.${method}?did=${DID}`
      expect((await fetch(url)).status).toBe(401)
      expect(
        (await fetch(url, { headers: { Authorization: `Bearer ${DID}` } }))
          .status,
      ).toBe(401)
    },
  )

  it('serves schema-valid signed history through the production central store', async () => {
    const response = await fetch(
      `${server.url}/xrpc/zone.stratos.admin.listBoundaryOps?did=${DID}&limit=1`,
      { headers: { cookie } },
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const page = (await response.json()) as BoundaryHistoryPage
    expect(page.operations).toHaveLength(1)
    expect(await verifyBoundaryOperation(page.operations[0])).toBe(true)
    expect(page.operations[0].operation.did).toBe(DID)
  })

  it('serves a schema-valid checkpoint and explicitly rejects bad replay cursors', async () => {
    const response = await fetch(
      `${server.url}/xrpc/zone.stratos.admin.getBoundaryAuditState?did=${DID}`,
      { headers: { cookie } },
    )
    expect(response.status, await response.clone().text()).toBe(200)
    const checkpoint = (await response.json()) as SignedBoundaryCheckpoint
    expect(checkpoint.checkpoint.state.enrolled).toBe(true)
    const invalid = await fetch(
      `${server.url}/xrpc/zone.stratos.admin.listBoundaryOps?did=${DID}&cursor=broken`,
      { headers: { cookie } },
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: 'BoundaryHistoryTruncated',
    })
    const oversized = await fetch(
      `${server.url}/xrpc/zone.stratos.admin.listBoundaryOps?did=${DID}&limit=101`,
      { headers: { cookie } },
    )
    expect(oversized.status).toBe(400)
  })
})
