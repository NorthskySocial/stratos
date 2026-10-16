import { describe, expect, it, vi } from 'vitest'
const identityModule = vi.hoisted(() => ({
  openServiceSigningIdentity: vi.fn(),
}))
vi.mock(
  '/app/stratos-service/dist/infra/signing/service-identity.js',
  () => identityModule,
)
const driverPath = './credential-revocation-contract.driver.mjs'
const {
  method,
  requiredAssertions,
  responseContract,
  verifyBefore,
  verifyAfter,
  prepare,
  authorityCheck,
  runCli,
} = await import(driverPath)

const state = {
  authorityDid: 'did:web:rei.test',
  pdsDid: 'did:web:pds.test',
  did: 'did:plc:motoko',
  space: 'at://did:web:rei.test/space/zone.stratos.space.feed/general',
  otherSpace: 'at://did:web:rei.test/space/zone.stratos.space.feed/other',
  seedText: 'Nerv',
  url: 'https://pds.test/read',
  a: { jti: 'grant-a', headers: { authorization: 'synthetic-a' } },
  b: { jti: 'grant-b', headers: { authorization: 'synthetic-b' } },
}
function fixture() {
  let revoked = false
  const calls: unknown[] = []
  return {
    calls,
    read: async (grant: { jti: string }) =>
      new Response(
        JSON.stringify(
          revoked && grant.jti === state.a.jti
            ? { error: 'CredentialRevoked' }
            : { records: [{ value: { text: state.seedText } }] },
        ),
        { status: revoked && grant.jti === state.a.jti ? 401 : 200 },
      ),
    notify: async (
      body: { space: string; credentials: string[] },
      options: { iss?: string; aud?: string; lxm?: string | null } = {},
    ) => {
      calls.push([body, options])
      let status = 200
      let error
      if (options.lxm !== undefined) {
        status = 401
        error = 'BadJwtLexiconMethod'
      } else if (options.iss || options.aud) {
        status = 403
        error = 'Forbidden'
      } else if (
        !body.credentials.length ||
        body.credentials.length > 100 ||
        body.credentials.includes('')
      ) {
        status = 400
        error = 'InvalidRequest'
      } else if (
        body.space === state.space &&
        body.credentials.includes(state.a.jti)
      )
        revoked = true
      return new Response(JSON.stringify({ error }), { status })
    },
    unsupported: async () =>
      new Response(JSON.stringify({ error: 'MethodNotImplemented' }), {
        status: 501,
      }),
    document: async () => ({ id: state.authorityDid, service: [] }),
  }
}

describe('credential revocation wire assertions', () => {
  it('pins the receiver method and every truthful design assertion', async () => {
    expect(method).toBe('com.atproto.space.notifyCredentialRevoked')
    const io = fixture()
    const before = await verifyBefore(state, io)
    const receipt = await verifyAfter(before, io.read)
    expect(receipt.suite).toBe('credential-revocation-contract')
    expect(receipt.assertions).toEqual(
      requiredAssertions
        .filter((id: string) => id !== 'upstream-restart-retention')
        .concat('upstream-restart-retention')
        .map((id: string) => ({ id, status: 'passed' })),
    )
    expect(io.calls).toEqual([
      [
        { space: state.space, credentials: ['grant-b'] },
        { iss: state.authorityDid + '#atproto' },
      ],
      [
        { space: state.space, credentials: ['grant-b'] },
        { aud: state.authorityDid },
      ],
      [{ space: state.space, credentials: ['grant-b'] }, { aud: state.pdsDid }],
      [
        { space: state.space, credentials: ['grant-b'] },
        { lxm: 'com.atproto.space.listRecords' },
      ],
      [{ space: state.space, credentials: ['grant-b'] }, { lxm: null }],
      [{ space: state.space, credentials: [] }, {}],
      [{ space: state.space, credentials: ['grant-b', ''] }, {}],
      [{ space: state.space, credentials: Array(101).fill('grant-b') }, {}],
      [{ space: state.otherSpace, credentials: ['grant-b'] }, {}],
      [{ space: state.space, credentials: ['grant-a'] }, {}],
      [{ space: state.space, credentials: ['grant-a', 'grant-a'] }, {}],
    ])
  })
  it('rejects status-only denials and unexpected statuses', async () => {
    await expect(
      responseContract(
        new Response('{"error":"Other"}', { status: 401 }),
        401,
        'CredentialRevoked',
      ),
    ).rejects.toThrow()
    await expect(
      responseContract(
        new Response('{}', { status: 200 }),
        401,
        'CredentialRevoked',
      ),
    ).rejects.toThrow()
  })
  it('never reports success when a wire operation fails', async () => {
    for (const name of ['read', 'notify', 'unsupported', 'document'] as const) {
      await expect(
        verifyBefore(state, {
          ...fixture(),
          [name]: async () => {
            throw Error('wire failure')
          },
        }),
      ).rejects.toThrow('wire failure')
    }
    const io = fixture()
    const before = await verifyBefore(state, io)
    await expect(verifyAfter(before, fixture().read)).rejects.toThrow()
    await expect(
      verifyBefore({ ...state, b: state.a }, fixture()),
    ).rejects.toThrow()
    await expect(
      verifyBefore(state, {
        ...fixture(),
        read: async () => new Response('{"records":[]}', { status: 200 }),
      }),
    ).rejects.toThrow()
    for (const service of [
      '#atproto_space_host',
      state.authorityDid + '#atproto_space_host',
    ]) {
      await expect(
        verifyBefore(state, {
          ...fixture(),
          document: async () => ({
            id: state.authorityDid,
            service: [{ id: service }],
          }),
        }),
      ).rejects.toThrow()
    }
  })
  it('checks every readable grant and tolerates unrelated records', async () => {
    const io = fixture()
    const read = vi.fn(io.read)
    await verifyBefore(state, { ...io, read })
    expect(read.mock.calls.map(([grant]) => grant.jti)).toEqual([
      'grant-a',
      'grant-b',
      ...Array(9).fill('grant-b'),
      'grant-a',
      'grant-b',
      'grant-a',
      'grant-b',
    ])
    const mixed = async (grant: { jti: string }) => {
      const response = await io.read(grant)
      return response.status === 200
        ? Response.json({
            records: [
              {},
              { value: { text: 'other' } },
              { value: { text: state.seedText } },
            ],
          })
        : response
    }
    const fresh = fixture()
    const before = await verifyBefore(state, {
      ...fresh,
      read: async (grant: { jti: string }) => {
        const response = await fresh.read(grant)
        return response.status === 200
          ? Response.json({
              records: [
                {},
                { value: { text: 'other' } },
                { value: { text: state.seedText } },
              ],
            })
          : response
      },
    })
    await verifyAfter(before, mixed)
    for (const records of [[], [{ value: { text: 'wrong' } }]]) {
      const bad = fixture()
      let calls = 0
      await expect(
        verifyBefore(state, {
          ...bad,
          read: async (grant: { jti: string }) =>
            ++calls === 1 ? Response.json({ records }) : bad.read(grant),
        }),
      ).rejects.toThrow()
    }
  })
  it('rejects every status-only denial at its actual wire position', async () => {
    for (const operation of ['notify', 'read', 'unsupported'] as const) {
      const count = operation === 'notify' ? 8 : operation === 'read' ? 2 : 1
      for (let target = 0; target < count; target++) {
        const io = fixture()
        const original = io[operation]
        let denials = 0
        const replacement = async (...args: unknown[]) => {
          const response = await Reflect.apply(original, io, args)
          if (response.status >= 400 && denials++ === target)
            return new Response('{}', { status: response.status })
          return response
        }
        await expect(
          verifyBefore(state, { ...io, [operation]: replacement }),
        ).rejects.toThrow()
      }
    }
    const io = fixture()
    const before = await verifyBefore(state, io)
    await expect(
      verifyAfter(before, async (grant: { jti: string }) =>
        grant === state.a
          ? new Response('{}', { status: 401 })
          : io.read(grant),
      ),
    ).rejects.toThrow()
  })
  it('requires the seeded text and allows unrelated service entries', async () => {
    await verifyBefore(state, {
      ...fixture(),
      document: async () => ({
        id: state.authorityDid,
        service: [{ id: '#atproto_pds' }],
      }),
    })
    for (const records of [[{ value: { text: 'Not Nerv' } }], [{}]]) {
      await expect(
        verifyBefore(state, {
          ...fixture(),
          read: async () => new Response(JSON.stringify({ records })),
        }),
      ).rejects.toThrow()
      const io = fixture()
      const before = await verifyBefore(state, io)
      await expect(
        verifyAfter(before, async (grant: { jti: string }) =>
          grant === state.a
            ? io.read(grant)
            : new Response(JSON.stringify({ records })),
        ),
      ).rejects.toThrow()
    }
  })
})

function preparation() {
  let serial = 0
  const close = vi.fn(async () => {})
  const browser = { close }
  const page = {}
  const key = {}
  const io = {
    domain: 'nerv.test',
    openBrowser: vi.fn(async () => browser),
    prepareAccount: vi.fn(async () => ({
      account: { did: state.did, seedText: state.seedText },
      page,
    })),
    proofKey: vi.fn(() => key),
    acquireDelegation: vi.fn(async () => 'synthetic-delegation'),
    signedHeaders: vi.fn(
      (authorization: string, _key: unknown, audience?: string) => ({
        authorization,
        ...(audience ? { audience } : {}),
      }),
    ),
    fetch: vi.fn(async () => new Response('{}')),
    credentialLifetime: vi.fn(async () => ({
      credential: 'synthetic-credential',
      claims: {
        iss: 'did:web:stratos-e2e.nerv.test',
        sub: 'at://did:web:stratos-e2e.nerv.test/space/zone.stratos.space.feed/general',
        jti: 'grant-' + ++serial,
      },
    })),
  }
  return { io, browser, page, key }
}
function authority() {
  const wire = fixture()
  const metadata = { ino: 1, size: 100, mtimeMs: 123, isFile: () => true }
  const sign = vi.fn(async () => Buffer.from('signature'))
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({
    signingKey: { jwtAlg: 'ES256', sign },
    close,
  }))
  const io = {
    loadIdentity: vi.fn(async () => ({ openServiceSigningIdentity: open })),
    stat: vi.fn(async () => metadata),
    mkdtemp: vi.fn(async () => '/tmp/synthetic-identity'),
    symlink: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      if (url === state.url)
        return wire.read(init?.headers === state.a.headers ? state.a : state.b)
      if (url.endsWith('/.well-known/did.json'))
        return Response.json(await wire.document())
      if (url.includes('atmosbox.internal')) return wire.unsupported()
      const token = (
        init?.headers as Record<string, string>
      ).authorization.slice(7)
      const claims = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString(),
      )
      const options = Object.fromEntries(
        ['iss', 'aud', 'lxm']
          .filter(
            (name) =>
              claims[name] !==
              (
                {
                  iss: state.authorityDid,
                  aud: state.did,
                  lxm: method,
                } as Record<string, string>
              )[name],
          )
          .map((name) => [name, claims[name] ?? null]),
      )
      return wire.notify(JSON.parse(init?.body as string), options)
    }),
  }
  return { io, open, sign, close, metadata }
}

describe('credential revocation driver adapters', () => {
  it('prepares two exchanges with exact binding and request fields', async () => {
    const { io, browser, page, key } = preparation()
    const result = await prepare(io)
    expect(result).toEqual({
      authorityDid: 'did:web:stratos-e2e.nerv.test',
      pdsDid: 'did:web:october-pds-e2e.nerv.test',
      space:
        'at://did:web:stratos-e2e.nerv.test/space/zone.stratos.space.feed/general',
      otherSpace:
        'at://did:web:stratos-e2e.nerv.test/space/zone.stratos.space.feed/other',
      did: state.did,
      seedText: state.seedText,
      url: 'https://october-pds-e2e.nerv.test/xrpc/com.atproto.space.listRecords?repo=did%3Aplc%3Amotoko&space=at%3A%2F%2Fdid%3Aweb%3Astratos-e2e.nerv.test%2Fspace%2Fzone.stratos.space.feed%2Fgeneral&collection=zone.stratos.feed.post',
      a: {
        jti: 'grant-1',
        headers: {
          authorization: 'Atproto-Space synthetic-credential',
          audience: state.did,
        },
      },
      b: {
        jti: 'grant-2',
        headers: {
          authorization: 'Atproto-Space synthetic-credential',
          audience: state.did,
        },
      },
    })
    expect(io.prepareAccount).toHaveBeenCalledWith(browser, 'faye')
    expect(io.acquireDelegation).toHaveBeenCalledWith(page)
    expect(io.signedHeaders.mock.calls).toEqual([
      ['Bearer synthetic-delegation', key],
      ['Atproto-Space synthetic-credential', key, state.did],
      ['Bearer synthetic-delegation', key],
      ['Atproto-Space synthetic-credential', key, state.did],
    ])
    expect(io.fetch.mock.calls).toHaveLength(2)
    for (const call of io.fetch.mock.calls as unknown as [
      string,
      RequestInit,
    ][])
      expect(call).toEqual([
        'https://stratos-e2e.atmosbox.internal/xrpc/zone.stratos.space.getSpaceCredential',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer synthetic-delegation',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ space: result.space }),
        },
      ])
    expect(browser.close).toHaveBeenCalledOnce()
  })
  it('rejects invalid domain and claims and closes failed preparations', async () => {
    for (const domain of ['', 'NERV', '/nerv', 'nerv/', undefined]) {
      const { io, browser } = preparation()
      vi.stubEnv('SANDBOX_DOMAIN', undefined)
      try {
        await expect(prepare({ ...io, domain })).rejects.toThrow()
      } finally {
        vi.unstubAllEnvs()
      }
      expect(browser.close).not.toHaveBeenCalled()
    }
    for (const claims of [
      { iss: 'wrong' },
      { sub: 'wrong' },
      { jti: '' },
      { jti: 3 },
    ]) {
      const { io, browser } = preparation()
      const original = await io.credentialLifetime()
      io.credentialLifetime.mockResolvedValue({
        ...original,
        claims: { ...original.claims, ...claims },
      } as typeof original)
      await expect(prepare(io)).rejects.toThrow()
      expect(browser.close).toHaveBeenCalledOnce()
    }
    for (const name of [
      'prepareAccount',
      'acquireDelegation',
      'fetch',
      'credentialLifetime',
    ] as const) {
      const { io, browser } = preparation()
      io[name].mockRejectedValueOnce(Error('synthetic-failure'))
      await expect(prepare(io)).rejects.toThrow('synthetic-failure')
      expect(browser.close).toHaveBeenCalledOnce()
    }
  })
  it('signs exact service JWTs and preserves identity metadata', async () => {
    const { io, open, sign, close } = authority()
    const before = Date.now() / 1000
    const result = await authorityCheck(state, io)
    expect(result.passed).toHaveLength(12)
    expect(open).toHaveBeenCalledWith(
      '/tmp/synthetic-identity',
      state.authorityDid,
    )
    expect(io.stat.mock.calls).toEqual([
      ['/app/data/service-signing-identity.json'],
      ['/app/data/service-signing-identity.json'],
    ])
    expect(io.symlink).toHaveBeenCalledWith(
      '/app/data/service-signing-identity.json',
      '/tmp/synthetic-identity/service-signing-identity.json',
    )
    expect(io.mkdtemp).toHaveBeenCalledWith('/tmp/revocation-contract-')
    expect(close).toHaveBeenCalledOnce()
    expect(io.rm).toHaveBeenCalledWith('/tmp/synthetic-identity', {
      recursive: true,
      force: true,
    })
    const tokens = sign.mock.calls as unknown as [Buffer][]
    expect(tokens).toHaveLength(11)
    const ids = new Set()
    for (const [index, [input]] of tokens.entries()) {
      const [header, payload] = input
        .toString()
        .split('.')
        .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()))
      expect(header).toEqual({ typ: 'JWT', alg: 'ES256' })
      const options =
        [
          { iss: state.authorityDid + '#atproto' },
          { aud: state.authorityDid },
          { aud: state.pdsDid },
          { lxm: 'com.atproto.space.listRecords' },
          { lxm: undefined },
        ][index] ?? {}
      expect(payload).toEqual({
        iss: state.authorityDid,
        aud: state.did,
        lxm: method,
        iat: expect.any(Number),
        exp: expect.any(Number),
        jti: expect.any(String),
        ...options,
      })
      expect(payload.iat).toBeGreaterThanOrEqual(Math.floor(before))
      expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
      expect(payload.exp).toBe(payload.iat + 60)
      expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/)
      ids.add(payload.jti)
      const [url, init] = io.fetch.mock.calls.filter(([url]) =>
        url.startsWith('https://pds.test/xrpc/'),
      )[index]
      expect(url).toBe('https://pds.test/xrpc/' + method)
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({
        authorization:
          'Bearer ' +
          input.toString() +
          '.' +
          Buffer.from('signature').toString('base64url'),
        'content-type': 'application/json',
      })
    }
    expect(ids.size).toBe(11)
    expect(io.fetch).toHaveBeenCalledWith(
      'https://stratos-e2e.atmosbox.internal/xrpc/' + method,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          space: state.space,
          credentials: [state.a.jti],
        }),
      },
    )
  })
  it('fails closed on identity, signing, transport and cleanup failures', async () => {
    for (const field of ['ino', 'size', 'mtimeMs'] as const) {
      const { io, metadata, close } = authority()
      io.stat
        .mockResolvedValueOnce(metadata)
        .mockResolvedValueOnce({ ...metadata, [field]: metadata[field] + 1 })
      await expect(authorityCheck(state, io)).rejects.toThrow()
      expect(close).toHaveBeenCalledOnce()
      expect(io.rm).toHaveBeenCalledOnce()
    }
    const defaults = authority()
    identityModule.openServiceSigningIdentity.mockImplementation(defaults.open)
    await authorityCheck(state, { ...defaults.io, loadIdentity: undefined })
    expect(defaults.close).toHaveBeenCalledOnce()
    const notFile = authority()
    notFile.io.stat.mockResolvedValue({
      ...notFile.metadata,
      isFile: () => false,
    })
    await expect(authorityCheck(state, notFile.io)).rejects.toThrow()
    expect(notFile.open).not.toHaveBeenCalled()
    for (const name of [
      'loadIdentity',
      'stat',
      'mkdtemp',
      'symlink',
      'rm',
      'fetch',
      'open',
      'sign',
      'close',
    ] as const) {
      const f = authority()
      const operation =
        name in f.io
          ? f.io[name as keyof typeof f.io]
          : f[name as 'open' | 'sign' | 'close']
      operation.mockRejectedValueOnce(Error('synthetic-failure'))
      await expect(authorityCheck(state, f.io)).rejects.toThrow(
        'synthetic-failure',
      )
      if (['symlink', 'rm', 'fetch', 'open', 'sign', 'close'].includes(name))
        expect(f.io.rm).toHaveBeenCalledOnce()
      if (['fetch', 'sign', 'close'].includes(name))
        expect(f.close).toHaveBeenCalledOnce()
    }
  })
  it('handles CLI phases and emits only a generic failure on malformed or failed input', async () => {
    for (const phase of ['prepare', 'before', 'after', 'unknown']) {
      for (const failure of [false, true]) {
        const io = fixture()
        const prepared = await verifyBefore(state, io)
        const runtime = {
          argv: ['node', 'driver.mjs', phase],
          stdin: (async function* () {
            yield JSON.stringify(prepared).slice(0, 20)
            yield JSON.stringify(prepared).slice(20)
          })(),
          exitCode: 0,
        }
        const output = vi.fn()
        const error = vi.fn()
        const prepareState = vi.fn(async () => {
          if (failure) throw Error('private')
          return prepared
        })
        const check = vi.fn(async () => {
          if (failure) throw Error('private')
          return prepared
        })
        const request = vi.fn(async () => {
          if (failure) throw Error('private')
          return io.read(request.mock.calls.length === 1 ? state.a : state.b)
        })
        await runCli(runtime, {
          prepare: prepareState,
          authorityCheck: check,
          fetch: request,
          output,
          error,
        })
        if (failure || phase === 'unknown') {
          expect(runtime.exitCode).toBe(1)
          expect(output).not.toHaveBeenCalled()
          expect(error.mock.calls).toEqual([
            ['Credential revocation contract probe failed'],
          ])
        } else {
          expect(runtime.exitCode).toBe(0)
          expect(error).not.toHaveBeenCalled()
          expect(output.mock.calls).toEqual([
            [
              JSON.stringify(
                phase === 'after'
                  ? await verifyAfter(prepared, io.read)
                  : prepared,
              ),
            ],
          ])
          if (phase === 'prepare') expect(prepareState).toHaveBeenCalledOnce()
          if (phase === 'before') expect(check).toHaveBeenCalledWith(prepared)
          if (phase === 'after')
            expect(request.mock.calls).toEqual([
              [state.url, { headers: state.a.headers }],
              [state.url, { headers: state.b.headers }],
            ])
        }
      }
    }
    for (const input of ['', '{', 'null']) {
      const runtime = {
        argv: ['node', 'driver.mjs', 'after'],
        stdin: (async function* () {
          yield input
        })(),
        exitCode: 0,
      }
      const output = vi.fn(),
        error = vi.fn()
      await runCli(runtime, { output, error })
      expect(runtime.exitCode).toBe(1)
      expect(output).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledWith(
        'Credential revocation contract probe failed',
      )
    }
  })
})
