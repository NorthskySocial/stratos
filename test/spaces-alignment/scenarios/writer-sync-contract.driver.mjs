import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import {
  openBrowser,
  prepareAccount,
  proofKey,
  signedHeaders,
} from './standard-credential-transport.driver.mjs'

export const requiredAssertions = [
  'upstream-commit-rev-unchanged',
  'upstream-short-page-cursor',
  'upstream-exclusive-empty-preserves-checkpoint',
  'upstream-repeated-writer-new-state',
  'upstream-equal-older-idempotent',
  'upstream-wrong-issuer-denied',
  'upstream-wrong-audience-denied',
  'upstream-future-revision-denied',
  'upstream-current-write-policy-denied',
  'stratos-standard-writer-routes-unsupported',
]

const diagnostics = new WeakMap()
const responseOperations = new WeakMap()
const safeErrors = new Set([
  'Forbidden',
  'FutureRev',
  'MethodNotImplemented',
  'InvalidRequest',
  'InvalidToken',
  'AuthRequired',
  'InvalidScope',
])

async function operation(label, run) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error) {
      diagnostics.set(error, { operation: label, ...diagnostics.get(error) })
    }
    throw error
  }
}

export async function checked(response, status = 200, error) {
  let value
  try {
    const body = await response.text()
    value = body ? JSON.parse(body) : undefined
    assert.equal(response.status, status)
    if (error !== undefined) assert.equal(value.error, error)
    return value
  } catch (failure) {
    if (failure instanceof Error) {
      diagnostics.set(failure, {
        ...(responseOperations.has(response)
          ? { operation: responseOperations.get(response) }
          : {}),
        status: response.status,
        ...(safeErrors.has(value?.error) ? { error: value.error } : {}),
      })
    }
    throw failure
  }
}

export function assertPage(page) {
  assert.equal(page.spaceRev, undefined)
  assert.ok(Array.isArray(page.repos))
  for (const row of page.repos) {
    assert.equal(typeof row.did, 'string')
    assert.match(row.repoRev, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/)
    assert.match(row.spaceRev, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/)
    assert.equal(row.rev, undefined)
    assert.equal(Buffer.from(row.hash.$bytes, 'base64').length, 32)
  }
  assert.equal(page.cursor, page.repos.at(-1)?.spaceRev)
}

export function futureRevision(now) {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz'
  let number = (BigInt(now + 301_000) * 1000n) << 10n
  let result = ''
  for (let index = 0; index < 13; index++) {
    result = alphabet[Number(number & 31n)] + result
    number >>= 5n
  }
  return result
}

export async function verifyContract(api) {
  const passed = []
  const record = async (id, run) => {
    await operation(id, run)
    passed.push(id)
  }
  const first = await operation('write-first', () => api.write('first'))
  await record('upstream-commit-rev-unchanged', async () => {
    assert.match(first.rev, /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/)
    assert.equal(first.repoRev, undefined)
    assert.equal(Buffer.from(first.hash.$bytes, 'base64').length, 32)
  })
  let page
  await record('upstream-short-page-cursor', async () => {
    page = await api.list()
    assertPage(page)
    assert.equal(page.repos.length, 1)
    assert.equal(page.repos[0].did, api.writer)
    assert.equal(page.repos[0].repoRev, first.rev)
    assert.deepEqual(page.repos[0].hash, first.hash)
  })
  const checkpoint = page.cursor
  await record('upstream-exclusive-empty-preserves-checkpoint', async () => {
    const empty = await api.list(checkpoint)
    assertPage(empty)
    assert.deepEqual(empty.repos, [])
    assert.equal(empty.cursor ?? checkpoint, checkpoint)
    const arbitrary = await api.list('zzzz-not-a-tid')
    assertPage(arbitrary)
    assert.deepEqual(arbitrary.repos, [])
  })
  const second = await operation('write-second', () => api.write('second'))
  await record('upstream-repeated-writer-new-state', async () => {
    assert.ok(second.rev > first.rev)
    page = await api.list(checkpoint)
    assertPage(page)
    assert.equal(page.repos.length, 1)
    assert.equal(page.repos[0].did, api.writer)
    assert.equal(page.repos[0].repoRev, second.rev)
    assert.deepEqual(page.repos[0].hash, second.hash)
    assert.ok(page.cursor > checkpoint)
  })
  const accepted = structuredClone(page)
  const notifyBody = {
    space: api.space,
    repo: api.writer,
    repoRev: second.rev,
    hash: second.hash,
  }
  await record('upstream-equal-older-idempotent', async () => {
    await checked(await api.notify(notifyBody))
    await checked(
      await api.notify(
        { ...notifyBody, repoRev: first.rev, hash: first.hash },
        { audience: 'authority' },
      ),
    )
    assert.deepEqual(await api.list(checkpoint), accepted)
  })
  for (const [id, body, options, status, error] of [
    [
      'upstream-wrong-issuer-denied',
      notifyBody,
      { issuer: 'other-writer' },
      403,
      'Forbidden',
    ],
    [
      'upstream-wrong-audience-denied',
      notifyBody,
      { audience: 'writer' },
      403,
      'Forbidden',
    ],
    [
      'upstream-future-revision-denied',
      { ...notifyBody, repoRev: futureRevision(Date.now()) },
      {},
      400,
      'FutureRev',
    ],
  ]) {
    await record(id, async () => {
      await checked(await api.notify(body, options), status, error)
      assert.deepEqual(await api.list(checkpoint), accepted)
    })
  }
  await record('upstream-current-write-policy-denied', async () => {
    await api.removeWriter()
    await checked(await api.notify(notifyBody), 403, 'Forbidden')
    assert.deepEqual(await api.list(checkpoint), accepted)
  })
  await record('stratos-standard-writer-routes-unsupported', async () => {
    const responses = await api.unsupported()
    assert.equal(responses.length, 2)
    for (const response of responses)
      await checked(response, 501, 'MethodNotImplemented')
  })
  return {
    suite: 'writer-sync-contract',
    assertions: passed.map((id) => ({ id, status: 'passed' })),
  }
}

export async function runScenario({
  domain = process.env.SANDBOX_DOMAIN,
  open = openBrowser,
  prepare = prepareAccount,
  keyFor = proofKey,
  headersFor = signedHeaders,
  request = fetch,
} = {}) {
  assert.match(domain, /^[a-z0-9.-]+$/)
  const host = `https://october-pds-e2e.${domain}`
  const browser = await operation('open-browser', open)
  try {
    const { account: owner } = await operation('prepare-owner', () =>
      prepare(browser, 'faye'),
    )
    const { account: writer } = await operation('prepare-writer', () =>
      prepare(browser, 'edward'),
    )
    const send = async (label, ...args) =>
      operation(label, async () => {
        const response = await request(...args)
        responseOperations.set(response, label)
        return response
      })
    const rpc = (method, body, token, params) => {
      const url = new URL('/xrpc/' + method, host)
      for (const [key, value] of Object.entries(params ?? {}))
        url.searchParams.set(key, value)
      return send(method, url, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    }
    const { uri: space } = await checked(
      await rpc(
        'com.atproto.simplespace.createSpace',
        {
          spaceType: 'zone.stratos.space.feed',
          skey: 'writer-contract',
          readPolicy: { $type: 'com.atproto.simplespace.defs#publicPolicy' },
          writePolicy: {
            $type: 'com.atproto.simplespace.defs#memberListPolicy',
          },
          appAccess: { $type: 'com.atproto.simplespace.defs#open' },
        },
        owner.accessJwt,
      ),
    )
    await checked(
      await rpc(
        'com.atproto.simplespace.putMember',
        { space, did: writer.did, read: true, write: true },
        owner.accessJwt,
      ),
    )
    const key = keyFor()
    const { token } = await checked(
      await rpc(
        'com.atproto.space.getDelegationToken',
        undefined,
        owner.accessJwt,
        { space },
      ),
    )
    const exchange = await send(
      'get-space-credential',
      host + '/xrpc/com.atproto.space.getSpaceCredential',
      {
        method: 'POST',
        headers: {
          ...headersFor('Bearer ' + token, key),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ space }),
      },
    )
    const { credential } = await checked(exchange)
    return await verifyContract({
      space,
      writer: writer.did,
      otherWriter: owner.did,
      async write(text) {
        await checked(
          await rpc(
            'com.atproto.space.createRecord',
            {
              space,
              repo: writer.did,
              collection: 'zone.stratos.feed.post',
              record: {
                $type: 'zone.stratos.feed.post',
                text,
                createdAt: new Date().toISOString(),
              },
            },
            writer.accessJwt,
          ),
        )
        const { commit } = await checked(
          await rpc(
            'com.atproto.space.getLatestCommit',
            undefined,
            writer.accessJwt,
            { space, repo: writer.did },
          ),
        )
        await checked(
          await this.notify({
            space,
            repo: writer.did,
            repoRev: commit.rev,
            hash: commit.hash,
          }),
        )
        return commit
      },
      async list(cursor) {
        const url = new URL('/xrpc/com.atproto.space.listRepos', host)
        url.searchParams.set('space', space)
        url.searchParams.set('limit', '100')
        if (cursor !== undefined) url.searchParams.set('cursor', cursor)
        return checked(
          await send('list-repos', url, {
            headers: headersFor('Atproto-Space ' + credential, key, owner.did),
          }),
        )
      },
      async notify(
        body,
        { audience = 'authority-host', issuer = 'writer' } = {},
      ) {
        const aud = {
          'authority-host': owner.did + '#atproto_space_host',
          authority: owner.did,
          writer: writer.did,
        }[audience]
        const account = { writer, 'other-writer': owner }[issuer]
        const { token } = await checked(
          await rpc(
            'com.atproto.server.getServiceAuth',
            undefined,
            account.accessJwt,
            { aud, lxm: 'com.atproto.space.notifyWrite' },
          ),
        )
        return rpc('com.atproto.space.notifyWrite', body, token)
      },
      async removeWriter() {
        await checked(
          await rpc(
            'com.atproto.simplespace.removeMember',
            { space, did: writer.did },
            owner.accessJwt,
          ),
        )
      },
      async unsupported() {
        const authority = 'https://stratos-e2e.atmosbox.internal/xrpc/'
        return Promise.all([
          send(
            'stratos-list-repos',
            authority +
              'com.atproto.space.listRepos?space=' +
              encodeURIComponent(space),
          ),
          send(
            'stratos-notify-write',
            authority + 'com.atproto.space.notifyWrite',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                space,
                repo: writer.did,
                repoRev: futureRevision(Date.now()),
                hash: { $bytes: Buffer.alloc(32).toString('base64') },
              }),
            },
          ),
        ])
      },
    })
  } finally {
    await operation('close-browser', () => browser.close())
  }
}

export async function main(argv = process.argv, run = runScenario) {
  if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
    try {
      console.log(JSON.stringify(await run()))
    } catch (error) {
      console.error('Writer sync contract probe failed')
      const diagnostic = diagnostics.get(error)
      if (diagnostic) console.error(JSON.stringify(diagnostic))
      process.exitCode = 1
    }
  }
}
await main()
