import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, createPublicKey, ECDH, verify } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  runScenario,
  credentialLifetime,
  deniedRenewal,
  denied,
} from './standard-credential-transport.driver.mjs'
const now = Math.floor(Date.now() / 1000)
let status = 200
let claims: Record<string, unknown>
let body: unknown
let url: string
let enrolled = true
let exchanges = 0
const server = createServer((request, response) => {
  if (request.url === '/remove') {
    enrolled = false
    response.writeHead(status).end()
    return
  }
  exchanges += 1
  response.writeHead(enrolled ? status : 403, {
    'content-type': 'application/json',
  })
  response.end(
    JSON.stringify(
      body ?? {
        credential: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
      },
    ),
  )
})
beforeAll(async () => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No HTTP address')
  url = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})
function reset() {
  claims = { iat: now, exp: now + 600 }
  status = 200
  body = undefined
  enrolled = true
  exchanges = 0
}
async function exchange() {
  return fetch(url, { method: 'POST' })
}
describe('executable standard driver HTTP checks', () => {
  it.each([600, 3600])(
    'accepts the exact %i-second HTTP lifetime',
    async (lifetime) => {
      reset()
      claims.exp = now + lifetime
      const result = await credentialLifetime(await exchange(), lifetime, now)
      expect(result.claims).toEqual(claims)
      expect(result.credential).toMatch(/^header\.[^.]+\.signature$/)
      expect(exchanges).toBe(1)
    },
  )
  it.each([
    { iat: now, exp: now + 3601 },
    { iat: now, exp: now },
    { iat: now, exp: now - 1 },
    { iat: now - 600, exp: now },
    { iat: now + 6, exp: now + 606 },
    { exp: now + 600 },
    { iat: now },
    { iat: '0', exp: now + 600 },
    { iat: null, exp: now + 600 },
    { iat: now, exp: null },
    { iat: now, exp: now + 601 },
  ])('rejects invalid HTTP credential dates case %#', async (invalid) => {
    reset()
    claims = invalid
    await expect(
      credentialLifetime(await exchange(), 600, now),
    ).rejects.toThrow()
  })
  it.each([
    [{ iat: now + 6, exp: now + 606 }, 600],
    [{ iat: now - 600, exp: now }, 600],
    [{ iat: now, exp: now + 3601 }, 3601],
    [{ iat: now + 1, exp: now + 1 }, 0],
    [{ iat: now + 2, exp: now + 1 }, -1],
  ] as const)(
    'enforces independent lifetime limits case %#',
    async (invalid, expected) => {
      reset()
      claims = invalid
      await expect(
        credentialLifetime(await exchange(), expected, now),
      ).rejects.toThrow()
    },
  )
  it('accepts exactly five seconds of issuer clock skew', async () => {
    reset()
    claims = { iat: now + 5, exp: now + 605 }
    await expect(
      credentialLifetime(await exchange(), 600, now),
    ).resolves.toBeDefined()
  })
  it.each([
    {},
    { credential: 42 },
    { credential: 'one.two' },
    { credential: 'one.!invalid.three' },
  ])('rejects malformed HTTP bodies %j', async (invalid) => {
    reset()
    body = invalid
    await expect(credentialLifetime(await exchange())).rejects.toThrow()
  })
  it.each([400, 401, 403, 404, 500])(
    'rejects HTTP %i as successful minting',
    async (code) => {
      reset()
      status = code
      await expect(credentialLifetime(await exchange())).rejects.toThrow()
    },
  )
  it('requires a successful mint before verified removal and denied renewal', async () => {
    reset()
    await deniedRenewal(
      exchange,
      async () => (await fetch(url + '/remove', { method: 'POST' })).status,
    )
    expect(exchanges).toBe(2)
    expect(enrolled).toBe(false)
  })
  it('rejects a renewal that remains authorized', async () => {
    reset()
    await expect(deniedRenewal(exchange, async () => 200)).rejects.toThrow(
      'Request was not denied',
    )
    expect(exchanges).toBe(2)
  })
  it('rejects failed removal rather than reporting denied renewal', async () => {
    reset()
    await expect(deniedRenewal(exchange, async () => 500)).rejects.toThrow(
      'Member removal failed',
    )
    expect(exchanges).toBe(1)
  })
  it('rejects invalid pre-removal setup', async () => {
    reset()
    status = 403
    let removed = false
    await expect(
      deniedRenewal(exchange, async () => {
        removed = true
        return 200
      }),
    ).rejects.toThrow('Credential exchange failed')
    expect(removed).toBe(false)
  })
  it.each([200, 204, 400, 404, 429, 500])(
    'does not count HTTP %i as an authorization denial',
    async (code) => {
      await expect(
        denied(new Response(null, { status: code })),
      ).rejects.toThrow()
    },
  )
  it.each([401, 403])(
    'accepts HTTP %i as an authorization denial',
    async (code) => {
      await expect(
        denied(new Response(null, { status: code })),
      ).resolves.toBeUndefined()
    },
  )
})

function publicKey(kid: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = 0n
  for (const character of kid.slice('did:key:z'.length)) {
    const digit = alphabet.indexOf(character)
    expect(digit).toBeGreaterThanOrEqual(0)
    number = number * 58n + BigInt(digit)
  }
  const bytes = Buffer.from(number.toString(16), 'hex')
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x80, 0x24]))
  const raw = ECDH.convertKey(
    bytes.subarray(2),
    'prime256v1',
    undefined,
    undefined,
    'uncompressed',
  ) as Buffer
  return createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33).toString('base64url'),
    },
  })
}
function checkSignature(headers: Headers, audience?: string) {
  const input = headers.get('signature-input')!
  const kid = /;keyid="([^"]+)"$/.exec(input)![1]
  const fields = audience
    ? ['authorization', 'atproto-space-audience']
    : ['authorization']
  const params = input.slice('atproto-space='.length)
  expect(params).toBe(
    `(${fields.map((field) => `"${field}"`).join(' ')});keyid="${kid}"`,
  )
  expect(headers.get('atproto-space-audience')).toBe(audience ?? null)
  const canonical =
    fields.map((field) => `"${field}": ${headers.get(field)}`).join('\n') +
    `\n"@signature-params": ${params}`
  const signature = headers.get('signature')!
  expect(signature).toMatch(/^atproto-space=:[A-Za-z0-9+/=]+:$/)
  expect(
    verify(
      'sha256',
      Buffer.from(canonical),
      { key: publicKey(kid), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature.slice(15, -1), 'base64'),
    ),
  ).toBe(true)
  return kid
}
function checkDpop(headers: Headers, target: string, token?: string) {
  const parts = headers.get('dpop')!.split('.')
  expect(parts).toHaveLength(3)
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  expect(header).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256' })
  expect(claims).toMatchObject({
    htu: target,
    htm: token ? 'GET' : 'POST',
    iat: expect.any(Number),
    jti: expect.any(String),
  })
  expect(Math.abs(claims.iat - Math.floor(Date.now() / 1000))).toBeLessThan(5)
  expect(claims.ath).toBe(
    token ? createHash('sha256').update(token).digest('base64url') : undefined,
  )
  expect(
    verify(
      'sha256',
      Buffer.from(parts.slice(0, 2).join('.')),
      {
        key: createPublicKey({ format: 'jwk', key: header.jwk }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(parts[2], 'base64url'),
    ),
  ).toBe(true)
}
function orchestrationFixture(fault = '') {
  const authorityDid = 'did:web:stratos-e2e.undefined'
  const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
  const events: string[] = []
  const requests: { url: URL; headers: Headers; options: RequestInit }[] = []
  let removed = false
  let serial = 0
  const issued = new Map<string, string>()
  const used = new Set<string>()
  const token = (claims: Record<string, unknown>) =>
    `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })
  vi.stubGlobal(
    'fetch',
    async (input: URL | string, options: RequestInit = {}) => {
      const url = new URL(input)
      const headers = new Headers(options.headers)
      requests.push({ url, headers, options })
      events.push(url.pathname)
      const index = requests.length
      if (fault === `http-${index}`) return json({}, 500)
      if (fault === `body-${index}`) return json({})
      if (url.pathname === '/xrpc/zone.stratos.space.getSpaceCredential') {
        expect(url.origin).toBe('https://stratos-e2e.atmosbox.internal')
        expect(options.method).toBe('POST')
        expect(headers.get('content-type')).toBe('application/json')
        expect(JSON.parse(options.body as string)).toEqual({ space })
        const authorization = headers.get('authorization')!
        expect(authorization).toMatch(/^Bearer delegation-[0-9]+$/)
        if (headers.has('dpop')) checkDpop(headers, url.href)
        if (headers.has('dpop') && headers.has('signature'))
          return json({}, 403)
        if (removed || used.has(authorization)) return json({}, 401)
        used.add(authorization)
        if (!headers.has('signature'))
          return json({
            credential: token({
              cnf: { jkt: fault === 'legacy-key' ? 42 : 'thumbprint' },
            }),
          })
        const kid = checkSignature(headers)
        const claims: Record<string, unknown> = {
          iat: now,
          exp: now + 600,
          iss: authorityDid,
          sub: space,
          cnf: { kid },
          jti: 'rei',
        }
        if (fault === 'issuer') claims.iss = 'did:web:other'
        if (fault === 'subject') claims.sub = 'other-space'
        if (fault === 'binding') claims.cnf = { kid: 'wrong' }
        if (fault === 'audience') claims.aud = authorityDid
        if (fault === 'jti') delete claims.jti
        if (fault === 'lifetime') claims.exp = now + 601
        const credential = token(claims)
        issued.set(credential, kid)
        return json({ credential })
      }
      expect(options.method).toBeUndefined()
      const authorization = headers.get('authorization')!
      if (authorization.startsWith('DPoP ')) {
        checkDpop(headers, url.origin + url.pathname, authorization.slice(5))
        return json({})
      }
      expect(authorization).toMatch(/^Atproto-Space /)
      const credential = authorization.slice('Atproto-Space '.length)
      const audience = headers.get('atproto-space-audience')!
      const kid = checkSignature(headers, audience)
      if (index === 7) {
        const changed = JSON.parse(
          Buffer.from(credential.split('.')[1], 'base64url').toString(),
        )
        const originalToken = [...issued.keys()][0]
        const original = JSON.parse(
          Buffer.from(originalToken.split('.')[1], 'base64url').toString(),
        )
        expect(changed).toEqual({ ...original, exp: original.exp + 1 })
        expect(credential.split('.')[2]).toBe(originalToken.split('.')[2])
      }
      if (index === 8)
        expect(url.searchParams.get('space')).toBe(
          space.replace('/general', '/other'),
        )
      if (issued.get(credential) !== kid) return json({}, 403)
      if (url.pathname === '/xrpc/zone.stratos.space.listRepos') {
        expect(url.origin).toBe('https://stratos-e2e.atmosbox.internal')
        expect(audience).toBe(authorityDid)
        expect([...url.searchParams]).toEqual([['space', space]])
        return json({})
      }
      expect(url.origin).toBe('https://october-pds-e2e.undefined')
      expect(url.pathname).toBe('/xrpc/com.atproto.space.listRecords')
      expect(url.searchParams.get('collection')).toBe('zone.stratos.feed.post')
      if (
        url.searchParams.get('repo') !== audience ||
        url.searchParams.get('space') !== space
      )
        return json({}, fault === 'denial' ? 200 : 403)
      const owner = audience === 'did:plc:faye' ? 'faye' : 'edward'
      return json({
        records:
          fault === `seed-${owner}`
            ? [{ value: { text: 'unrelated' } }]
            : [
                {},
                { value: { text: 'unrelated' } },
                { value: { text: `seed-${owner}` } },
              ],
      })
    },
  )
  const browser = {
    close: async () => {
      events.push('close')
      if (fault === 'close') throw new Error('close failed')
    },
  }
  const adapters = {
    open: async () => {
      events.push('open')
      return browser
    },
    prepare: async (actual: typeof browser, name: string) => {
      expect(actual).toBe(browser)
      expect(['faye', 'edward']).toContain(name)
      events.push(`prepare-${name}`)
      if (fault === 'prepare') throw new Error('prepare failed')
      return {
        account: {
          did: fault === 'same-owner' ? 'did:plc:faye' : `did:plc:${name}`,
          seedText: `seed-${name}`,
        },
        page: name,
      }
    },
    delegation: async (page: string) => {
      expect(page).toBe('faye')
      events.push('delegation')
      return `delegation-${++serial}`
    },
    remove: async (page: string) => {
      expect(page).toBe('faye')
      events.push('remove')
      removed = true
      return fault === 'remove' ? 500 : 200
    },
  }
  return { adapters, events, requests }
}
afterEach(() => vi.unstubAllGlobals())
describe('standard driver orchestration', () => {
  it('uses account labels that meet the October PDS three-character minimum', async () => {
    const fixture = orchestrationFixture()
    const prepare = vi.fn(fixture.adapters.prepare)
    await runScenario({ ...fixture.adapters, prepare })
    const labels = prepare.mock.calls.map(([, name]) => name)
    expect(labels).toHaveLength(2)
    for (const label of labels) {
      expect(label.length).toBeGreaterThanOrEqual(3)
    }
    expect(labels).toEqual(['faye', 'edward'])
  })
  it('executes all checks in order with actual cryptographic HTTP headers and closes before returning', async () => {
    const fixture = orchestrationFixture()
    const receipt = await runScenario(fixture.adapters)
    expect(receipt).toEqual({
      suite: 'standard-credential-transport',
      assertions: [
        'standard-exchange',
        'default-lifetime-600',
        'october-pds-read',
        'same-signature-reused',
        'wrong-owner-denied',
        'two-owners-one-host',
        'wrong-key-denied',
        'tampered-token-denied',
        'cross-space-denied',
        'stratos-read',
        'renewal-fresh-key',
        'delegation-replay-denied',
        'conflicting-proof-denied',
        'legacy-compatible',
        'renewal-after-removal-denied',
      ].map((id) => ({ id, status: 'passed' })),
    })
    expect(fixture.requests).toHaveLength(17)
    expect([...fixture.requests[1].headers]).toEqual([
      ...fixture.requests[2].headers,
    ])
    expect([...fixture.requests[1].headers]).toEqual([
      ...fixture.requests[3].headers,
    ])
    expect(fixture.requests[3].url.searchParams.get('repo')).toBe(
      'did:plc:edward',
    )
    expect(fixture.requests[4].headers.get('atproto-space-audience')).toBe(
      'did:plc:edward',
    )
    expect(fixture.events.slice(0, 4)).toEqual([
      'open',
      'prepare-faye',
      'prepare-edward',
      'delegation',
    ])
    expect(fixture.events.slice(-5)).toEqual([
      '/xrpc/zone.stratos.space.getSpaceCredential',
      'remove',
      'delegation',
      '/xrpc/zone.stratos.space.getSpaceCredential',
      'close',
    ])
  })
  it.each([
    ...Array.from({ length: 17 }, (_, i) => `http-${i + 1}`),
    ...[1, 2, 5, 10, 14, 16].map((i) => `body-${i}`),
    'issuer',
    'subject',
    'binding',
    'audience',
    'jti',
    'lifetime',
    'seed-faye',
    'seed-edward',
    'denial',
    'legacy-key',
    'same-owner',
    'prepare',
    'remove',
    'close',
  ])('fails rather than issuing a passing receipt for %s', async (fault) => {
    const fixture = orchestrationFixture(fault)
    const messages: Record<string, string> = {
      'http-10': 'Standard exchange failed',
      'http-2': 'October PDS rejected Stratos credential',
      'seed-faye': 'October read omitted seeded record',
      'seed-edward': 'Second owner read omitted seeded record',
    }
    await expect(runScenario(fixture.adapters)).rejects.toThrow(messages[fault])
    expect(fixture.events.at(-1)).toBe('close')
    expect(fixture.events.filter((event) => event === 'close')).toHaveLength(1)
  })
})
