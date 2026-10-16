import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const authorityDid = 'did:web:stratos-e2e.sandbox.test'
const did = 'did:plc:motoko'
const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
const payload = {
  iss: did,
  sub: space,
  aud: `${authorityDid}#atproto_space_host`,
}
const token = (claims: object) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const response = (status: number, body: object = {}) =>
  new Response(JSON.stringify(body), { status })

async function driver(
  name: string,
  replies: Response[],
  claims = payload,
  options: {
    domain?: string | null
    removed?: number
    entry?: string
    delegation?: string
  } = {},
) {
  const source = await readFile(
    new URL(`./${name}.driver.mjs`, import.meta.url),
    'utf8',
  )
  const logs: string[] = []
  let requests = 0
  const code = source
    .replace(/import\s+[\s\S]*?from\s*['"][^'"]+['"];?/g, '')
    .replace(
      "const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')",
      '',
    )
    .replace("const { chromium } = require('playwright')", '')
    .replace(/main\(\)\.catch\([\s\S]*$/, '')
  const context = {
    createRequire: () => () => ({ chromium: context.chromium }),
    assert,
    readFile: async () => 'synthetic-password',
    Buffer,
    URL,
    Response,
    globalThis,
    Math,
    process: {
      env: {
        SANDBOX_DOMAIN:
          options.domain === null
            ? undefined
            : (options.domain ?? 'sandbox.test'),
      },
    },
    console: { log: (value: string) => logs.push(value) },
    chromium: {
      launch: async () => ({
        newPage: async () => ({ evaluate: async () => options.removed ?? 200 }),
        close: async () => {},
      }),
    },
    proofKey: () => ({}),
    signedHeaders: () => ({}),
    fetch: async () => {
      const reply = replies[requests++]
      if (!reply) throw new Error('Unexpected request')
      return reply
    },
    delegation: options.delegation ?? token(claims),
  }
  let outcome: string | undefined
  try {
    outcome = await (runInNewContext(
      `${code}
    const originalOauthSession = oauthSession
    trustSandboxCa = async () => {}
    oauthSession = async () => '${did}'
    getDelegation = async () => delegation
    async function execute() {
      try { await main(); return undefined }
      catch (error) { return failureOutcome(error) }
    }
    ${options.entry ?? 'execute()'}
  `,
      context,
    ) as Promise<string | undefined>)
  } catch (error) {
    outcome = JSON.stringify({
      label: (error as Error).message,
      status: 'failed',
    })
  }
  return { outcome, logs, requests }
}

function delegationReplies() {
  return [
    response(200, { credential: 'private-credential' }),
    response(200, { records: [{}] }),
    response(400, { error: 'InvalidToken' }),
    response(401, { error: 'BadSpaceSignature' }),
    response(400, { error: 'InvalidToken' }),
    response(400, { error: 'ProofRequired' }),
    response(200),
    response(400, { error: 'InvalidRequest' }),
    response(200),
  ]
}
function lifetimeReplies() {
  return [
    response(200, { credential: 'private-credential' }),
    response(200),
    response(200, { records: [{}] }),
    response(200, { repos: [] }),
    response(200, { records: [{}] }),
    response(401, { error: 'BadSpaceSignature' }),
  ]
}

describe('executable delegation and lifetime driver contracts', () => {
  it.each(['delegation-transport', 'credential-lifetime'])(
    'rejects malformed inputs with exact labels in %s',
    async (name) => {
      for (const domain of ['!sandbox.test', 'sandbox.test!', '', null]) {
        expect((await driver(name, [], payload, { domain })).outcome).toBe(
          JSON.stringify({ label: 'sandbox-domain', status: 'failed' }),
        )
      }
      const replies =
        name === 'delegation-transport'
          ? delegationReplies()
          : lifetimeReplies()
      replies[0] = response(200, { credential: 42 })
      expect((await driver(name, replies)).outcome).toBe(
        JSON.stringify({ label: 'credential-string', status: 'failed' }),
      )
      for (const account of ['not-a-did', 'private:did:']) {
        const entry = `async function probe() {
          loadAuth = async () => {}
          completeOAuth = async () => {}
          readFile = async () => 'synthetic-password'
          const page = {
            route: async () => {}, goto: async () => {},
            evaluate: async () => '${account}',
          }
          try { await oauthSession(page) } catch (error) { return failureOutcome(error) }
        }
        probe()`
        expect(
          (
            await driver(name, [], payload, {
              entry: entry.replace(
                'try {',
                'oauthSession = originalOauthSession; try {',
              ),
            })
          ).outcome,
        ).toBe(JSON.stringify({ label: 'oauth-account-did', status: 'failed' }))
      }
    },
  )
  it.each(['delegation-transport', 'credential-lifetime'])(
    'prints only the sanitized failure and fails the process in %s',
    async (name) => {
      const source = await readFile(
        new URL(`./${name}.driver.mjs`, import.meta.url),
        'utf8',
      )
      const errors: string[] = []
      const process = { exitCode: 0 }
      await runInNewContext(
        source.slice(0, source.indexOf('import assert')) +
          source.slice(source.lastIndexOf('main().catch(')),
        {
          main: async () => {
            throw new Error('private-response-body')
          },
          failureOutcome: () => '{"label":"wrong-key-denied","status":401}',
          console: { error: (value: string) => errors.push(value) },
          process,
          globalThis,
        },
      )
      expect(errors).toEqual([
        `${name === 'delegation-transport' ? 'Delegation transport' : 'Credential lifetime'} scenario failed: {"label":"wrong-key-denied","status":401}`,
      ])
      expect(process.exitCode).toBe(1)
    },
  )
  it('rejects failed removal and permits only unrelated remaining members', async () => {
    expect(
      (
        await driver('credential-lifetime', lifetimeReplies(), payload, {
          removed: 500,
        })
      ).outcome,
    ).toBe(JSON.stringify({ label: 'member-removal-status', status: 'failed' }))
    const replies = lifetimeReplies()
    replies[3] = response(200, { repos: [{ did: 'did:plc:rei' }] })
    expect(
      (await driver('credential-lifetime', replies)).outcome,
    ).toBeUndefined()
  })
  it.each([[], { length: 1 }])(
    'rejects invalid foreign record lists %j',
    async (records) => {
      const replies = delegationReplies()
      replies[1] = response(200, { records })
      expect((await driver('delegation-transport', replies)).outcome).toBe(
        JSON.stringify({ label: 'foreign-records-present', status: 'failed' }),
      )
    },
  )
  it.each(['header', '.payload.signature'])(
    'rejects malformed delegation shape %s',
    async (delegation) => {
      const entry = `async function probe() {
      try { await assertTamperedDelegationDenied({}, proofKey()) }
      catch (error) { return failureOutcome(error) }
    }; probe()`
      expect(
        await driver('delegation-transport', [], payload, {
          delegation,
          entry,
        }),
      ).toEqual({
        outcome: JSON.stringify({
          label: 'delegation-jwt-shape',
          status: 'failed',
        }),
        logs: [],
        requests: 0,
      })
    },
  )
  it.each(['delegation-transport', 'credential-lifetime'])(
    'rejects stale audience in %s without printing claims',
    async (name) => {
      const result = await driver(name, [], { ...payload, aud: authorityDid })
      expect(result).toEqual({
        outcome: JSON.stringify({ label: 'delegation-aud', status: 'failed' }),
        logs: [],
        requests: 0,
      })
    },
  )
  it.each(['iss', 'sub'])(
    'labels wrong delegation %s without printing claims',
    async (field) => {
      for (const name of ['delegation-transport', 'credential-lifetime']) {
        const result = await driver(name, [], {
          ...payload,
          [field]: 'private-claim',
        })
        expect(result.outcome).toBe(
          JSON.stringify({ label: `delegation-${field}`, status: 'failed' }),
        )
        expect(result.requests).toBe(0)
      }
    },
  )
  it.each(['delegation-transport', 'credential-lifetime'])(
    'executes all successful checks in %s',
    async (name) => {
      const replies =
        name === 'delegation-transport'
          ? delegationReplies()
          : lifetimeReplies()
      const result = await driver(name, replies)
      expect(result.outcome).toBeUndefined()
      expect(result.requests).toBe(replies.length)
      expect(result.logs).toHaveLength(1)
      const receipt = JSON.parse(result.logs[0]) as {
        suite: string
        assertions: { id: string; status: string }[]
      }
      expect(receipt.suite).toBe(name)
      expect(receipt.assertions.at(-1)?.status).toBe('passed')
      expect(result.logs.join('')).not.toContain('private-credential')
    },
  )
  it.each([2, 3, 4, 5, 7])(
    'rejects arbitrary denial at delegation request %i',
    async (index) => {
      const replies = delegationReplies()
      replies[index] = response(400, {
        error: 'private-token-and-record-content',
        message: 'private-body',
      })
      const result = await driver('delegation-transport', replies)
      expect(JSON.parse(result.outcome!)).toEqual({
        label: {
          2: 'tampered-delegation',
          3: 'wrong-key-denied',
          4: 'delegation-replay',
          5: 'missing-proof',
          7: 'ambiguous-transport',
        }[index],
        status: 400,
        expectedStatus: index === 3 ? 401 : 400,
        errorCode: 'UnexpectedErrorCode',
      })
      expect(result.outcome).not.toContain('private')
      expect(result.requests).toBe(index + 1)
      expect(result.logs).toEqual([])
    },
  )
  it.each([0, 1, 6, 8])(
    'labels unsuccessful delegation request %i',
    async (index) => {
      const replies = delegationReplies()
      replies[index] = response(500, { message: 'private-body' })
      const result = await driver('delegation-transport', replies)
      expect(JSON.parse(result.outcome!)).toEqual({
        label: {
          0: 'credential-mint',
          1: 'foreign-repo-read',
          6: 'retry-after-missing-proof',
          8: 'retry-after-ambiguous',
        }[index],
        status: 500,
        expectedStatus: 200,
      })
      expect(result.outcome).not.toContain('private')
      expect(result.requests).toBe(index + 1)
    },
  )
  it.each([0, 1, 2, 3, 4, 5])(
    'labels unsuccessful lifetime request %i',
    async (index) => {
      const replies = lifetimeReplies()
      replies[index] = response(500, { error: 'private-body' })
      const result = await driver('credential-lifetime', replies)
      expect(JSON.parse(result.outcome!)).toEqual({
        label: [
          'credential-mint',
          'local-read-before-removal',
          'foreign-read-before-removal',
          'local-read-after-removal',
          'foreign-read-after-removal',
          'wrong-key-denied',
        ][index],
        status: 500,
        expectedStatus: index === 5 ? 401 : 200,
        ...(index === 5 ? { errorCode: 'UnexpectedErrorCode' } : {}),
      })
      expect(result.outcome).not.toContain('private')
      expect(result.requests).toBe(index + 1)
    },
  )
  it.each(['delegation-transport', 'credential-lifetime'])(
    'checks exact diagnostic fields in %s',
    async (name) => {
      const replies =
        name === 'delegation-transport'
          ? delegationReplies()
          : lifetimeReplies()
      const index = name === 'delegation-transport' ? 3 : 5
      replies[index] = response(401, { error: 'private-error' })
      expect((await driver(name, replies)).outcome).toBe(
        JSON.stringify({
          label: 'wrong-key-denied',
          status: 401,
          expectedStatus: 401,
          errorCode: 'UnexpectedErrorCode',
        }),
      )
      const mismatch =
        name === 'delegation-transport'
          ? delegationReplies()
          : lifetimeReplies()
      mismatch[index] = response(403, { error: 'BadSpaceSignature' })
      expect((await driver(name, mismatch)).outcome).toBe(
        JSON.stringify({
          label: 'wrong-key-denied',
          status: 403,
          expectedStatus: 401,
          errorCode: 'BadSpaceSignature',
        }),
      )
    },
  )
  it('rejects empty foreign records and retained membership', async () => {
    const replies = lifetimeReplies()
    replies[2] = response(200, { records: [] })
    expect((await driver('credential-lifetime', replies)).outcome).toContain(
      'foreign-records-before-removal',
    )
    const retained = lifetimeReplies()
    retained[3] = response(200, { repos: [{ did }] })
    expect((await driver('credential-lifetime', retained)).outcome).toContain(
      'removed-member-not-listed',
    )
    const after = lifetimeReplies()
    after[4] = response(200, { records: [] })
    expect((await driver('credential-lifetime', after)).outcome).toContain(
      'foreign-records-after-removal',
    )
  })
})
