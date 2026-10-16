import { describe, expect, it, vi } from 'vitest'
import type {
  Commit,
  ContractApi,
  NotifyBody,
  NotifyOptions,
  WriterRow,
} from './writer-sync-contract.driver.mjs'
import {
  main,
  runScenario,
  assertPage,
  checked,
  futureRevision,
  requiredAssertions,
  verifyContract,
} from './writer-sync-contract.driver.mjs'

const hash = { $bytes: Buffer.alloc(32).toString('base64') }
const firstRev = '2222222222223'
const secondRev = '2222222222224'
function fixture(broken = '') {
  let current: Commit
  let sequence = 0
  let removed = false
  const api: ContractApi = {
    space: 'at://did:plc:faye/space/zone.stratos.space.feed/bebop',
    writer: 'did:plc:edward',
    otherWriter: 'did:plc:faye',
    async write() {
      sequence++
      current = { rev: sequence === 1 ? firstRev : secondRev, hash }
      return current
    },
    async list(cursor?: string) {
      if (cursor === 'zzzz-not-a-tid' || (cursor === 's1' && sequence === 1))
        return { repos: [] }
      const row: WriterRow = {
        did: api.writer,
        repoRev: current.rev,
        hash,
        spaceRev: sequence === 1 ? '2222222222225' : '2222222222226',
      }
      if (cursor === row.spaceRev) return { repos: [] }
      if (broken === 'wrong-writer') row.did = api.otherWriter
      if (broken === 'wrong-head') row.repoRev = firstRev
      if (broken === 'wrong-hash')
        row.hash = { $bytes: Buffer.alloc(32, 1).toString('base64') }
      return {
        repos: [row],
        ...(broken === 'short-without-cursor' ? {} : { cursor: row.spaceRev }),
      }
    },
    async notify(body: NotifyBody, options: NotifyOptions = {}) {
      const error =
        removed ||
        body.repo !== api.writer ||
        options.issuer === 'other-writer' ||
        options.audience === 'writer'
          ? 'Forbidden'
          : body.repoRev > secondRev
            ? 'FutureRev'
            : undefined
      if (broken === 'accept-invalid')
        return new Response(null, { status: 200 })
      return new Response(error ? JSON.stringify({ error }) : null, {
        status: error === 'FutureRev' ? 400 : error ? 403 : 200,
      })
    },
    async removeWriter() {
      removed = true
    },
    async unsupported() {
      return [
        new Response(JSON.stringify({ error: 'MethodNotImplemented' }), {
          status: 501,
        }),
        new Response(JSON.stringify({ error: 'MethodNotImplemented' }), {
          status: broken === 'unsupported-is-404' ? 404 : 501,
        }),
      ]
    },
  }
  return api
}

describe('writer-sync wire assertion unit tests (synthetic responses)', () => {
  it('executes every named assertion and rejects invalid contracts', async () => {
    expect(await verifyContract(fixture())).toEqual({
      suite: 'writer-sync-contract',
      assertions: requiredAssertions.map((id) => ({ id, status: 'passed' })),
    })
    expect(requiredAssertions).toHaveLength(10)
    for (const broken of [
      'wrong-writer',
      'wrong-head',
      'wrong-hash',
      'short-without-cursor',
      'accept-invalid',
      'unsupported-is-404',
    ])
      await expect(verifyContract(fixture(broken))).rejects.toThrow()
  })
  it('rejects legacy and malformed pages, not merely non-success statuses', async () => {
    const row: WriterRow = {
      did: 'did:plc:faye',
      repoRev: firstRev,
      spaceRev: secondRev,
      hash,
    }
    expect(() => assertPage({ repos: [row], cursor: secondRev })).not.toThrow()
    expect(() => assertPage({ repos: [] })).not.toThrow()
    for (const page of [
      { repos: [], spaceRev: firstRev },
      { repos: null },
      { repos: [row] },
      { repos: [], cursor: firstRev },
      ...[
        { did: 1 },
        { repoRev: 'invalid' },
        { repoRev: '!' + firstRev },
        { repoRev: firstRev + '!' },
        { spaceRev: 'invalid' },
        { spaceRev: '!' + secondRev },
        { spaceRev: secondRev + '!' },
        { rev: firstRev },
        { hash: { $bytes: 'AA==' } },
      ].map((change) => ({
        repos: [{ ...row, ...change }],
        cursor: change.spaceRev ?? secondRev,
      })),
    ])
      expect(() => assertPage(page)).toThrow()
    await expect(
      checked(new Response(null, { status: 200 })),
    ).resolves.toBeUndefined()
    await expect(
      checked(new Response('{}', { status: 201 }), 201),
    ).resolves.toEqual({})
    await expect(checked(new Response('{}', { status: 400 }))).rejects.toThrow()
    await expect(
      checked(new Response('{}', { status: 403 }), 403, 'Forbidden'),
    ).rejects.toThrow()
    await expect(checked(new Response('{', { status: 200 }))).rejects.toThrow()
  })
  it('encodes a TID over five minutes ahead without changing commit field names', () => {
    expect(futureRevision(0)).toBe('22222cz3te222')
    expect(futureRevision(1)).not.toBe(futureRevision(0))
    const alphabet = '234567abcdefghijklmnopqrstuvwxyz'
    const decoded = [...futureRevision(123456789)].reduce(
      (value, character) => value * 32n + BigInt(alphabet.indexOf(character)),
      0n,
    )
    expect(decoded >> 10n).toBe(123757789000n)
  })
})

it('checks exact upstream fixture requests with a synthetic transport, without calling it runtime acceptance', async () => {
  const host = 'https://october-pds-e2e.atmosbox.test'
  const space =
    'at://did:plc:faye/space/zone.stratos.space.feed/writer-contract'
  const backend = fixture()
  const audiences: string[] = []
  const notifications: {
    issuer: string
    audience: string
    body: NotifyBody
  }[] = []
  const serviceTokens = new Map<string, { issuer: string; audience: string }>()
  let unsupportedCalls = 0
  let writes = 0
  let removed = false
  let closed = 0
  const names: string[] = []
  const key = {}
  const dependencies = {
    domain: 'atmosbox.test',
    open: async () => ({
      close: async () => {
        closed++
      },
    }),
    prepare: async (_browser: unknown, name: string) => {
      names.push(name)
      return {
        account: {
          did: name === 'faye' ? 'did:plc:faye' : 'did:plc:edward',
          accessJwt: name,
        },
      }
    },
    keyFor: () => key,
    headersFor: (
      authorization: string,
      actualKey: unknown,
      audience?: string,
    ) => {
      expect(actualKey).toBe(key)
      return { authorization, ...(audience ? { audience } : {}) }
    },
    request: async (
      input: Parameters<typeof fetch>[0],
      options?: RequestInit,
    ) => {
      const url = new URL(String(input))
      const method = url.pathname.split('/').at(-1)
      expect(url.pathname).toBe('/xrpc/' + method)
      const headers = options?.headers as Record<string, string>
      const body = options?.body ? JSON.parse(String(options.body)) : undefined
      const result = (value: unknown) => new Response(JSON.stringify(value))
      if (url.origin === 'https://stratos-e2e.atmosbox.internal') {
        unsupportedCalls++
        expect([
          'com.atproto.space.listRepos',
          'com.atproto.space.notifyWrite',
        ]).toContain(method)
        if (body) {
          expect(options?.method).toBe('POST')
          expect(headers['content-type']).toBe('application/json')
          expect(body.space).toBe(space)
          expect(body.repo).toBe('did:plc:edward')
          expect(body.hash).toEqual(hash)
          expect(body.repoRev).toMatch(
            /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/,
          )
        } else expect(url.searchParams.get('space')).toBe(space)
        return new Response(JSON.stringify({ error: 'MethodNotImplemented' }), {
          status: 501,
        })
      }
      expect(url.origin).toBe(host)
      if (method !== 'com.atproto.space.listRepos')
        expect(headers['content-type']).toBe('application/json')
      if (method === 'com.atproto.simplespace.createSpace') {
        expect(options?.method).toBe('POST')
        expect(headers.authorization).toBe('Bearer faye')
        expect(body).toEqual({
          spaceType: 'zone.stratos.space.feed',
          skey: 'writer-contract',
          readPolicy: { $type: 'com.atproto.simplespace.defs#publicPolicy' },
          writePolicy: {
            $type: 'com.atproto.simplespace.defs#memberListPolicy',
          },
          appAccess: { $type: 'com.atproto.simplespace.defs#open' },
        })
        return result({ uri: space })
      }
      if (method === 'com.atproto.simplespace.putMember') {
        expect(body).toEqual({
          space,
          did: 'did:plc:edward',
          read: true,
          write: true,
        })
        expect(headers.authorization).toBe('Bearer faye')
        return new Response(null)
      }
      if (method === 'com.atproto.space.getDelegationToken') {
        expect(headers.authorization).toBe('Bearer faye')
        expect(url.searchParams.get('space')).toBe(space)
        expect(options?.method).toBe('GET')
        return result({ token: 'delegation' })
      }
      if (method === 'com.atproto.space.getSpaceCredential') {
        expect(headers.authorization).toBe('Bearer delegation')
        expect(body).toEqual({ space })
        expect(options?.method).toBe('POST')
        return result({ credential: 'credential' })
      }
      if (method === 'com.atproto.space.createRecord') {
        expect(headers.authorization).toBe('Bearer edward')
        expect(body.space).toBe(space)
        expect(body.repo).toBe('did:plc:edward')
        expect(body.collection).toBe('zone.stratos.feed.post')
        expect(body.record.$type).toBe('zone.stratos.feed.post')
        expect(body.record.text).toBe(writes++ === 0 ? 'first' : 'second')
        expect(Number.isFinite(Date.parse(body.record.createdAt))).toBe(true)
        await backend.write('ignored')
        return result({ uri: 'created' })
      }
      if (method === 'com.atproto.space.getLatestCommit') {
        expect(headers.authorization).toBe('Bearer edward')
        expect(Object.fromEntries(url.searchParams)).toEqual({
          space,
          repo: 'did:plc:edward',
        })
        return result({
          commit: { rev: writes === 1 ? firstRev : secondRev, hash },
        })
      }
      if (method === 'com.atproto.server.getServiceAuth') {
        audiences.push(url.searchParams.get('aud')!)
        expect([
          'did:plc:faye#atproto_space_host',
          'did:plc:faye',
          'did:plc:edward',
        ]).toContain(url.searchParams.get('aud'))
        expect(['Bearer edward', 'Bearer faye']).toContain(
          headers.authorization,
        )
        const issuer =
          headers.authorization === 'Bearer faye'
            ? 'did:plc:faye'
            : 'did:plc:edward'
        const audience = url.searchParams.get('aud')!
        const token = 'service-token-' + serviceTokens.size
        serviceTokens.set(token, { issuer, audience })
        expect(url.searchParams.get('lxm')).toBe(
          'com.atproto.space.notifyWrite',
        )
        return result({ token })
      }
      if (method === 'com.atproto.space.notifyWrite') {
        expect(body.space).toBe(space)
        expect(body.hash).toEqual(hash)
        const claims = serviceTokens.get(
          headers.authorization.slice('Bearer '.length),
        )!
        expect(claims).toBeDefined()
        notifications.push({ ...claims, body })
        return backend.notify(body, {
          issuer: claims.issuer === backend.writer ? 'writer' : 'other-writer',
          audience:
            claims.audience === backend.writer ? 'writer' : 'authority-host',
        })
      }
      if (method === 'com.atproto.space.listRepos') {
        expect(url.searchParams.get('cursor')).not.toBe('undefined')
        expect(headers).toEqual({
          authorization: 'Atproto-Space credential',
          audience: 'did:plc:faye',
        })
        expect(url.searchParams.get('limit')).toBe('100')
        expect(url.searchParams.get('space')).toBe(space)
        expect(url.searchParams.has('since')).toBe(false)
        return result(
          await backend.list(url.searchParams.get('cursor') ?? undefined),
        )
      }
      if (method === 'com.atproto.simplespace.removeMember') {
        expect(headers.authorization).toBe('Bearer faye')
        expect(body).toEqual({ space, did: 'did:plc:edward' })
        removed = true
        await backend.removeWriter()
        return new Response(null)
      }
      throw new Error('Unexpected method ' + method)
    },
  }
  expect(await runScenario(dependencies)).toEqual({
    suite: 'writer-sync-contract',
    assertions: requiredAssertions.map((id) => ({ id, status: 'passed' })),
  })
  const mismatched = notifications.filter(
    ({ issuer, body }) => issuer !== body.repo,
  )
  expect(mismatched).toEqual([
    {
      issuer: 'did:plc:faye',
      audience: 'did:plc:faye#atproto_space_host',
      body: { space, repo: 'did:plc:edward', repoRev: secondRev, hash },
    },
  ])
  expect(
    notifications.filter(({ issuer }) => issuer === 'did:plc:edward'),
  ).toHaveLength(7)
  expect(unsupportedCalls).toBe(2)
  expect(audiences).toContain('did:plc:faye')
  expect(audiences).toContain('did:plc:faye#atproto_space_host')
  expect(names).toEqual(['faye', 'edward'])
  expect(writes).toBe(2)
  expect(removed).toBe(true)
  expect(closed).toBe(1)
  await expect(
    runScenario({ ...dependencies, domain: 'bad/domain' }),
  ).rejects.toThrow()
  await expect(
    runScenario({
      ...dependencies,
      request: async () => {
        throw new Error('transport failed')
      },
    }),
  ).rejects.toThrow('transport failed')
  expect(closed).toBe(2)
})

it.each(['accepted', 'wrong-error', 'changed-listing'])(
  'rejects a wrong-issuer response with %s',
  async (failure) => {
    const api = fixture()
    const notify = api.notify.bind(api)
    let mismatches = 0
    api.notify = async (body, options) => {
      if (options?.issuer !== 'other-writer') return notify(body, options)
      mismatches++
      expect(body).toEqual({
        space: api.space,
        repo: api.writer,
        repoRev: secondRev,
        hash,
      })
      if (failure === 'accepted') return new Response(null)
      if (failure === 'changed-listing') api.list = async () => ({ repos: [] })
      return new Response(
        JSON.stringify({
          error: failure === 'wrong-error' ? 'WrongError' : 'Forbidden',
        }),
        { status: 403 },
      )
    }
    await expect(verifyContract(api)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    expect(mismatches).toBe(1)
  },
)

it('detects missing observations, not only wrong statuses', async () => {
  for (const invalid of [
    'commit-format',
    'commit-prefix',
    'commit-suffix',
    'commit-alias',
    'commit-hash',
    'empty-is-not-empty',
    'empty-has-cursor',
    'arbitrary-is-not-empty',
    'same-rev',
    'same-space-rev',
    'notification-mutates',
    'denial-error',
    'removal-error',
    'unsupported-error',
  ]) {
    const api = fixture()
    const write = api.write.bind(api)
    const list = api.list.bind(api)
    const notify = api.notify.bind(api)
    let writes = 0
    api.write = async (text) => {
      const commit = await write(text)
      writes++
      if (invalid === 'commit-format') return { ...commit, rev: 'bad' }
      if (invalid === 'commit-prefix')
        return { ...commit, rev: '!' + commit.rev }
      if (invalid === 'commit-suffix')
        return { ...commit, rev: commit.rev + '!' }
      if (invalid === 'commit-alias') return { ...commit, repoRev: commit.rev }
      if (invalid === 'commit-hash')
        return { ...commit, hash: { $bytes: 'AA==' } }
      if (invalid === 'same-rev') return { ...commit, rev: firstRev }
      return commit
    }
    api.list = async (cursor) => {
      const page = await list(cursor)
      if (invalid === 'empty-is-not-empty' && cursor && writes === 1)
        return await list()
      if (invalid === 'empty-has-cursor' && cursor && writes === 1)
        return { repos: [], cursor }
      if (invalid === 'arbitrary-is-not-empty' && cursor === 'zzzz-not-a-tid')
        return await list()
      if (invalid === 'same-space-rev' && writes === 2)
        return {
          ...page,
          cursor: '2222222222225',
          repos: page.repos.map((row) => ({
            ...row,
            spaceRev: '2222222222225',
          })),
        }
      return page
    }
    api.notify = async (body, options) => {
      if (invalid === 'notification-mutates') {
        api.list = async () => ({ repos: [] })
        return new Response(null)
      }
      const response = await notify(body, options)
      if (invalid === 'denial-error' && response.status !== 200)
        return new Response(JSON.stringify({ error: 'WrongError' }), {
          status: response.status,
        })
      return response
    }
    if (invalid === 'removal-error')
      api.removeWriter = async () => {
        api.notify = async () =>
          new Response(JSON.stringify({ error: 'WrongError' }), { status: 403 })
      }
    if (invalid === 'unsupported-error')
      api.unsupported = async () => [
        new Response(JSON.stringify({ error: 'WrongError' }), { status: 501 }),
        new Response(null),
      ]
    await expect(verifyContract(api), invalid).rejects.toThrow()
  }
})
it('executes CLI only for its own module and redacts failures', async () => {
  const own = new URL('./writer-sync-contract.driver.mjs', import.meta.url)
    .pathname
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const run = vi.fn(async () => ({ suite: 'writer-sync-contract' }))
  const prior = process.exitCode
  try {
    await main([], run)
    await main(['node', '/tmp/other.mjs'], run)
    expect(run).not.toHaveBeenCalled()
    await main(['node', own], run)
    expect(output).toHaveBeenCalledExactlyOnceWith(
      '{"suite":"writer-sync-contract"}',
    )
    await main(['node', own], async () => {
      throw new Error('private-value')
    })
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Writer sync contract probe failed',
    )
    expect(process.exitCode).toBe(1)
  } finally {
    process.exitCode = prior
    output.mockRestore()
    error.mockRestore()
  }
})

it('fails at the specific observation boundary and executes every negative call', async () => {
  for (const rev of ['!' + firstRev, firstRev + '!']) {
    const api = fixture()
    api.write = async () => ({ rev, hash })
    api.list = async () => {
      throw new Error('must not reach listing')
    }
    await expect(verifyContract(api)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  }
  const api = fixture()
  const notify = api.notify.bind(api)
  const calls: { body: NotifyBody; options?: NotifyOptions }[] = []
  let listCount = 0
  const list = api.list.bind(api)
  api.list = async (cursor) => {
    listCount++
    return list(cursor)
  }
  api.notify = async (body, options) => {
    calls.push({ body, options })
    return notify(body, options)
  }
  await verifyContract(api)
  expect(calls).toHaveLength(6)
  expect(calls[1]).toEqual({
    body: { space: api.space, repo: api.writer, repoRev: firstRev, hash },
    options: { audience: 'authority' },
  })
  expect(calls[2]).toEqual({
    body: { space: api.space, repo: api.writer, repoRev: secondRev, hash },
    options: { issuer: 'other-writer' },
  })
  expect(calls[3].options).toEqual({ audience: 'writer' })
  expect(calls[4].body.repoRev).toMatch(
    /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/,
  )
  expect(listCount).toBe(9)
  const same = fixture()
  let writes = 0
  same.write = async () => {
    writes++
    return { rev: firstRev, hash }
  }
  same.list = async (cursor) =>
    cursor
      ? { repos: [] }
      : {
          repos: [
            { did: same.writer, repoRev: firstRev, hash, spaceRev: secondRev },
          ],
          cursor: secondRev,
        }
  await expect(verifyContract(same)).rejects.toMatchObject({
    name: 'AssertionError',
  })
  expect(writes).toBe(2)
})

it('checks the default domain before opening a browser', async () => {
  const prior = process.env.SANDBOX_DOMAIN
  try {
    delete process.env.SANDBOX_DOMAIN
    await expect(runScenario()).rejects.toThrow()
    process.env.SANDBOX_DOMAIN = 'invalid/domain'
    await expect(runScenario()).rejects.toThrow()
  } finally {
    if (prior === undefined) delete process.env.SANDBOX_DOMAIN
    else process.env.SANDBOX_DOMAIN = prior
  }
})

it('requires strict repo revision increase before reading the next page', async () => {
  const api = fixture()
  let writes = 0
  const write = api.write.bind(api)
  const list = api.list.bind(api)
  api.write = async (text) => {
    writes++
    const commit = await write(text)
    return writes === 2 ? { ...commit, rev: firstRev } : commit
  }
  api.list = async (cursor) => {
    if (writes === 2) throw new Error('read before monotonic check')
    return list(cursor)
  }
  await expect(verifyContract(api)).rejects.toMatchObject({
    name: 'AssertionError',
  })
})
it('uses a valid default sandbox domain and supplies the expected browser API', async () => {
  const prior = process.env.SANDBOX_DOMAIN
  try {
    process.env.SANDBOX_DOMAIN = 'atmosbox.test'
    await expect(
      runScenario({
        open: async () => {
          throw new Error('browser reached')
        },
      }),
    ).rejects.toThrow('browser reached')
    const browser = { close: async () => {} }
    await expect(
      runScenario({
        domain: 'atmosbox.test',
        open: async () => browser,
        prepare: async (actual) => {
          expect(actual).toBe(browser)
          throw new Error('prepare reached')
        },
      }),
    ).rejects.toThrow('prepare reached')
  } finally {
    if (prior === undefined) delete process.env.SANDBOX_DOMAIN
    else process.env.SANDBOX_DOMAIN = prior
  }
})
