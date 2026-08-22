/**
 * E2E-shaped repro: full HTTP server (lexicon validation included), dev-mode
 * enrollment, post write, credential issuance, credential-authed listRepoOps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestServer } from './helpers/test-server.js'

const SPIKE = 'did:plc:spikespiegel0repro'
const SERVICE_DID = 'did:web:test.stratos.actor'
const DOMAIN = `${SERVICE_DID}/test.com`
const SPACE = `at://${SERVICE_DID}/space/zone.stratos.space.feed/test.com`

describe('HTTP repro: credential-authed pull sync', () => {
  let ts: TestServer
  let url: string

  beforeAll(async () => {
    ts = await TestServer.create()
    await ts.start()
    url = ts.url
    const ctx = ts.server.ctx
    await ctx.enrollmentStore.enroll({
      did: SPIKE,
      enrolledAt: new Date().toISOString(),
      active: true,
      signingKeyDid: 'did:key:zRepro',
    })
    await ctx.enrollmentStore.setBoundaries(SPIKE, [DOMAIN])
    await ctx.actorStore.create(SPIKE)
  }, 30_000)

  afterAll(async () => {
    await ts?.stop()
  })

  it('writes, mints a credential, and pull-syncs over HTTP', async () => {
    // 1. Write a post (dev-mode Bearer DID).
    const create = await fetch(`${url}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SPIKE}`,
      },
      body: JSON.stringify({
        repo: SPIKE,
        collection: 'zone.stratos.feed.post',
        record: {
          $type: 'zone.stratos.feed.post',
          text: 'repro',
          createdAt: new Date().toISOString(),
          boundary: { values: [{ value: DOMAIN }] },
        },
      }),
    })
    expect(create.status, await create.clone().text()).toBe(200)

    // 2. Mint a space credential.
    const cred = await fetch(
      `${url}/xrpc/zone.stratos.space.getSpaceCredential`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SPIKE}`,
        },
        body: JSON.stringify({ space: SPACE }),
      },
    )
    expect(cred.status, await cred.clone().text()).toBe(200)
    const { credential } = (await cred.json()) as { credential: string }

    // 3. Pull-sync with the credential — the failing e2e call.
    const sync = await fetch(
      `${url}/xrpc/zone.stratos.sync.listRepoOps?did=${SPIKE}`,
      { headers: { Authorization: `Bearer ${credential}` } },
    )
    const body = await sync.text()
    expect(sync.status, body).toBe(200)
    const parsed = JSON.parse(body) as {
      ops: { cid: string | null; prev: string | null }[]
      cursor?: string
      commit?: unknown
    }
    expect(parsed.ops.length).toBe(1)
    // Head of the oplog: no cursor, commit present. The op passed lexicon
    // output validation with required-nullable cid/prev on the wire.
    expect(parsed.cursor).toBeUndefined()
    expect(typeof parsed.ops[0].cid).toBe('string')
    expect(parsed.ops[0].prev).toBeNull()
    expect(parsed.commit).toBeDefined()
  }, 30_000)
})
