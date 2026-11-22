/**
 * A member's PDS tells Stratos, the space host, that it wrote to a space repo
 * with `com.atproto.space.notifyRepoUpdate`. Stratos checks the notice and
 * acknowledges it; it stores and forwards nothing. The route runs in the
 * in-process service with its real handlers and stores. Each writing account
 * has a real key, its DID document is served through the service's resolver,
 * and every token is signed by the upstream package.
 */
import { readdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import express from 'express'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { TID } from '@atproto/common-web'
import { Secp256k1Keypair, type Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import { registerRepoUpdateNoticeHandler } from '../src/features/repo-update-notice/index.js'
import { WriteRateLimiter } from '../src/shared/rate-limiter.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_LEADERSHIP,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import { catalogDefinition } from './helpers/enrollment-holds.js'
import { makeSpaceUri } from './helpers/space-uri.js'

const METHOD = 'com.atproto.space.notifyRepoUpdate'
const HOST_AUDIENCE = `${HARNESS_SERVICE_DID}#atproto_pds`
const ENGINEERING_SPACE = makeSpaceUri(
  HARNESS_SERVICE_DID,
  HOSTED_SPACE_TYPE,
  'engineering',
)
const LEGACY_ENGINEERING_SPACE = `at://${HARNESS_SERVICE_DID}/space/${HOSTED_SPACE_TYPE}/engineering`
const FIVE_MINUTES_MS = 5 * 60 * 1000

interface Identity {
  did: string
  key: Keypair
}

interface Answer {
  status: number
  body: unknown
  text: string
  retryAfter: string | null
}

interface TokenClaims {
  aud?: string
  lxm?: string | null
  key?: Keypair
  exp?: number
}

function bytes(values: number[]): { $bytes: string } {
  return { $bytes: Buffer.from(values).toString('base64') }
}

describe('com.atproto.space.notifyRepoUpdate', () => {
  let harness: WriteHarness
  let resolveSpy: ReturnType<typeof vi.spyOn>
  const identities = new Map<string, Identity>()
  let faye: Identity
  let julia: Identity
  let jet: Identity
  let ed: Identity
  let spike: Identity
  let vicious: Identity
  let andy: Identity

  async function newIdentity(name: string): Promise<Identity> {
    const identity = {
      did: `did:plc:${name}`,
      key: await Secp256k1Keypair.create(),
    }
    identities.set(identity.did, identity)
    return identity
  }

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    for (const boundary of [HARNESS_ENGINEERING, HARNESS_DESIGN]) {
      await harness.ctx.boundaryStore!.create(catalogDefinition(boundary))
    }
    await harness.ctx.boundaryStore!.create(
      catalogDefinition(HARNESS_LEADERSHIP),
    )
    resolveSpy = vi
      .spyOn(harness.ctx.idResolver.did, 'resolve')
      .mockImplementation(async (did: string) => {
        const identity = identities.get(did)
        if (!identity) return null
        return {
          id: did,
          verificationMethod: [
            {
              id: `${did}#atproto`,
              type: 'Multikey',
              controller: did,
              publicKeyMultibase: identity.key.did().slice('did:key:'.length),
            },
          ],
        } as never
      })

    faye = await newIdentity('faye-valentine')
    julia = await newIdentity('julia')
    jet = await newIdentity('jet-black')
    ed = await newIdentity('radical-edward')
    spike = await newIdentity('spike-spiegel')
    vicious = await newIdentity('vicious')
    andy = await newIdentity('andy-von-de-oniyate')
    await harness.enrollPdsCustodyMember(faye.did, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(julia.did, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(jet.did, [HARNESS_DESIGN])
    await harness.enrollPdsCustodyMember(ed.did, [HARNESS_ENGINEERING])
    await harness.holdMember(ed.did)
    await harness.enrollMember(spike.did, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(andy.did, [HARNESS_LEADERSHIP])
    const leadership = await harness.ctx.boundaryStore!.get(HARNESS_LEADERSHIP)
    await harness.ctx.boundaryStore!.beginDeactivation(
      HARNESS_LEADERSHIP,
      leadership!.revision,
    )
  }, 60_000)

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    resolveSpy.mockRestore()
    await harness.close()
  })

  function token(issuer: Identity, claims: TokenClaims = {}): Promise<string> {
    const {
      aud = HARNESS_SERVICE_DID,
      lxm = METHOD,
      key = issuer.key,
      exp,
    } = claims
    return createServiceJwt({ iss: issuer.did, aud, lxm, keypair: key, exp })
  }

  function notice(
    repo: Identity,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      space: ENGINEERING_SPACE,
      repo: repo.did,
      repoRev: TID.nextStr(),
      data: bytes([0xbe, 0xb0, 0x9]),
      ...overrides,
    }
  }

  async function send(
    authorization: string | null,
    body: unknown,
    baseUrl = harness.baseUrl,
  ): Promise<Answer> {
    const response = await fetch(`${baseUrl}/xrpc/${METHOD}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    return {
      status: response.status,
      body: parsed,
      text,
      retryAfter: response.headers.get('retry-after'),
    }
  }

  async function notify(
    issuer: Identity,
    body: unknown,
    claims: TokenClaims = {},
  ): Promise<Answer> {
    return send(`Bearer ${await token(issuer, claims)}`, body)
  }

  function expectRefused(answer: Answer, status: number, error: string) {
    expect(answer.status).toBe(status)
    expect(answer.body).toMatchObject({ error })
  }

  describe('a notice from a member host', () => {
    it('is acknowledged with an empty 200 when addressed to the service DID', async () => {
      const answer = await notify(faye, notice(faye))
      expect(answer.status).toBe(200)
      expect(answer.text).toBe('')
    })

    it('is acknowledged when addressed to the #atproto_pds host role', async () => {
      const answer = await notify(faye, notice(faye), { aud: HOST_AUDIENCE })
      expect(answer.status).toBe(200)
      expect(answer.text).toBe('')
    })

    it('writes nothing to any store', async () => {
      const before = await storeSnapshot()
      const answer = await notify(faye, notice(faye))
      expect(answer.status).toBe(200)
      expect(await storeSnapshot()).toEqual(before)
      expect(await harness.ctx.actorStore.exists(faye.did)).toBe(false)
    })

    it('logs the space, repo and rev and nothing else', async () => {
      const debug = vi.fn()
      const app = express()
      const logger = { ...harness.ctx.logger!, debug }
      registerRepoUpdateNoticeHandler({ ...harness.ctx, app, logger })
      const baseUrl = await listen(app)
      const body = notice(faye)
      const answer = await send(`Bearer ${await token(faye)}`, body, baseUrl)
      expect(answer.status).toBe(200)
      expect(debug).toHaveBeenCalledTimes(1)
      expect(debug).toHaveBeenCalledWith(
        { space: ENGINEERING_SPACE, repo: faye.did, repoRev: body.repoRev },
        'repo update notice accepted',
      )
    })
  })

  describe('authentication', () => {
    it('answers a missing token as the other service-auth routes do', async () => {
      const answer = await send(null, notice(faye))
      const other = await harness.query('zone.stratos.space.listRepos', null, {
        space: ENGINEERING_SPACE,
      })
      expectRefused(answer, 401, 'AuthenticationRequired')
      expect({ status: answer.status, error: errorOf(answer.body) }).toEqual({
        status: other.status,
        error: errorOf(other.body),
      })
    })

    it.each([
      ['another method', { lxm: 'com.atproto.space.listWriters' }],
      ['no method', { lxm: null }],
      ['another authority', { aud: 'did:web:seele.example' }],
      [
        'another authority as host',
        { aud: 'did:web:seele.example#atproto_pds' },
      ],
      ['the #stratos fragment', { aud: `${HARNESS_SERVICE_DID}#stratos` }],
      [
        'the retired host fragment',
        { aud: `${HARNESS_SERVICE_DID}#atproto_space_host` },
      ],
      ['the fragment twice', { aud: `${HOST_AUDIENCE}#atproto_pds` }],
    ] as const)('refuses a token bound to %s', async (_name, claims) => {
      expectRefused(
        await notify(faye, notice(faye), claims),
        401,
        'AuthenticationRequired',
      )
    })

    it('refuses an expired token', async () => {
      const exp = Math.floor(Date.now() / 1000) - 1
      expectRefused(
        await notify(faye, notice(faye), { exp }),
        401,
        'AuthenticationRequired',
      )
    })

    it('refuses a token not signed with the issuer key', async () => {
      const stranger = await Secp256k1Keypair.create()
      expectRefused(
        await notify(faye, notice(faye), { key: stranger }),
        401,
        'AuthenticationRequired',
      )
    })

    it('refuses an issuer whose DID does not resolve', async () => {
      const ghost = {
        did: 'did:plc:gren',
        key: await Secp256k1Keypair.create(),
      }
      expectRefused(
        await notify(ghost, notice(ghost)),
        401,
        'AuthenticationRequired',
      )
    })

    it('refuses a notice signed by one account for another', async () => {
      expect((await notify(julia, notice(julia))).status).toBe(200)
      const answer = await notify(faye, notice(julia))
      expectRefused(answer, 403, 'Forbidden')
      expect(answer.body).toMatchObject({
        message: 'Notification iss does not match the repo',
      })
    })
  })

  describe('the space', () => {
    it.each([
      [
        'of another authority',
        makeSpaceUri('did:web:seele.example', HOSTED_SPACE_TYPE, 'engineering'),
      ],
      [
        'with a boundary this service does not host',
        makeSpaceUri(HARNESS_SERVICE_DID, HOSTED_SPACE_TYPE, 'bebop'),
      ],
      [
        'of another type',
        makeSpaceUri(
          HARNESS_SERVICE_DID,
          'zone.stratos.space.pottery',
          'engineering',
        ),
      ],
      ['in the legacy at:// spelling', LEGACY_ENGINEERING_SPACE],
      ['that is not a URI', 'engineering'],
    ])('answers SpaceNotFound for a space %s', async (_name, space) => {
      expectRefused(
        await notify(faye, notice(faye, { space })),
        400,
        'SpaceNotFound',
      )
    })
  })

  it('answers SpaceNotFound for a deactivating boundary its member still holds', async () => {
    const space = makeSpaceUri(
      HARNESS_SERVICE_DID,
      HOSTED_SPACE_TYPE,
      'leadership',
    )
    expectRefused(
      await notify(andy, notice(andy, { space })),
      400,
      'SpaceNotFound',
    )
  })

  describe('the writer', () => {
    it.each([
      ['an account that is not enrolled', () => vicious],
      ['a member without that boundary', () => jet],
      ['a member whose enrollment is inactive', () => ed],
      ['a member whose repo Stratos hosts', () => spike],
    ])('refuses %s with 403', async (_name, writer) => {
      const account = writer()
      expectRefused(await notify(account, notice(account)), 403, 'Forbidden')
    })
  })

  describe('the revision', () => {
    // In the past: TID.nextStr never goes back, so a frozen clock ahead of
    // the real one would push every later revision into the future.
    const NOW_MS = Date.UTC(2026, 0, 1, 9)

    function revAt(micros: number): string {
      return TID.fromTime(micros, 0).toString()
    }

    it('accepts a revision five minutes ahead', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW_MS })
      const repoRev = revAt((NOW_MS + FIVE_MINUTES_MS) * 1000)
      const answer = await notify(faye, notice(faye, { repoRev }))
      expect(answer.status).toBe(200)
    })

    it('answers FutureRev a microsecond past five minutes ahead', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW_MS })
      const repoRev = revAt((NOW_MS + FIVE_MINUTES_MS) * 1000 + 1)
      expectRefused(
        await notify(faye, notice(faye, { repoRev })),
        400,
        'FutureRev',
      )
    })

    it('refuses a revision that is not a TID', async () => {
      expectRefused(
        await notify(faye, notice(faye, { repoRev: 'swordfish-ii' })),
        400,
        'InvalidRequest',
      )
    })
  })

  describe('the body', () => {
    it.each([
      ['missing data', { data: undefined }],
      ['data as a string', { data: 'vqAJ' }],
      ['data as a list of numbers', { data: [190, 176, 9] }],
      ['data that is not base64', { data: { $bytes: 'not base64!' } }],
      ['a repo that is not a DID', { repo: 'faye-valentine' }],
      ['a missing space', { space: undefined }],
    ])('refuses %s with InvalidRequest', async (_name, overrides) => {
      expectRefused(
        await notify(faye, notice(faye, overrides)),
        400,
        'InvalidRequest',
      )
    })

    it('refuses a body that is not JSON', async () => {
      expectRefused(
        await send(`Bearer ${await token(faye)}`, '{"space":'),
        400,
        'InvalidRequest',
      )
    })
  })

  describe('rate limit', () => {
    it('refuses an issuer past its allowance and keeps serving others', async () => {
      const app = express()
      registerRepoUpdateNoticeHandler(
        { ...harness.ctx, app },
        new WriteRateLimiter({ maxWrites: 2, windowMs: 60_000 }),
      )
      const baseUrl = await listen(app)
      const sendAs = async (issuer: Identity) =>
        send(`Bearer ${await token(issuer)}`, notice(issuer), baseUrl)

      expect((await sendAs(faye)).status).toBe(200)
      expect((await sendAs(faye)).status).toBe(200)
      const limited = await sendAs(faye)
      expectRefused(limited, 429, 'RateLimitExceeded')
      expect(limited.retryAfter).toMatch(/^[1-9][0-9]*$/)
      expect((await sendAs(jet)).status).toBe(403)
    })
  })

  const listeners: Array<ReturnType<express.Application['listen']>> = []

  afterAll(async () => {
    await Promise.all(
      listeners.map((listener) => new Promise((done) => listener.close(done))),
    )
  })

  async function listen(app: express.Application): Promise<string> {
    const listener = await new Promise<
      ReturnType<express.Application['listen']>
    >((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started))
    })
    listeners.push(listener)
    return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  }

  async function storeSnapshot(): Promise<unknown> {
    const client = harness.ctx.db!._client
    const tables = await client.execute(
      "select name from sqlite_master where type = 'table' order by name",
    )
    const rows: Record<string, unknown> = {}
    for (const { name } of tables.rows) {
      rows[String(name)] = (
        await client.execute(`select * from "${String(name)}"`)
      ).rows
    }
    const files = (
      await readdir(harness.ctx.cfg.storage.dataDir, { recursive: true })
    )
      .filter((file) => !/-(wal|shm|journal)$/.test(file))
      .sort()
    return { rows, files }
  }
})

function errorOf(body: unknown): unknown {
  return (body as { error?: unknown } | null)?.error
}
