import assert from 'node:assert/strict'
import { mkdtemp, symlink, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  openBrowser,
  prepareAccount,
  acquireDelegation,
  proofKey,
  signedHeaders,
  credentialLifetime,
} from './standard-credential-transport.driver.mjs'

export const method = 'com.atproto.space.notifyCredentialRevoked'
export const requiredAssertions = [
  'upstream-two-grants-read',
  'upstream-wrong-issuer-denied',
  'upstream-foreign-audience-denied',
  'upstream-service-audience-denied',
  'upstream-wrong-method-denied',
  'upstream-missing-method-denied',
  'upstream-malformed-batch-denied',
  'upstream-cross-space-isolation',
  'upstream-grant-a-revoked-b-unaffected',
  'upstream-duplicate-idempotence',
  'upstream-restart-retention',
  'stratos-unsupported-route',
  'stratos-unsupported-role-unadvertised',
]

export async function responseContract(response, status, error) {
  assert.equal(response.status, status)
  if (error) assert.equal((await response.json()).error, error)
}

export async function verifyBefore(
  state,
  { read, notify, unsupported, document },
) {
  const passed = []
  const record = async (id, operation) => {
    await operation()
    passed.push(id)
  }
  const readable = async (grant) => {
    const response = await read(grant)
    await responseContract(response, 200)
    assert.ok(
      (await response.json()).records.some(
        (item) => item.value?.text === state.seedText,
      ),
    )
  }
  await record('upstream-two-grants-read', async () => {
    assert.notEqual(state.a.jti, state.b.jti)
    await readable(state.a)
    await readable(state.b)
  })
  for (const [id, options, status, error] of [
    [
      'upstream-wrong-issuer-denied',
      { iss: state.authorityDid + '#atproto' },
      403,
      'Forbidden',
    ],
    [
      'upstream-foreign-audience-denied',
      { aud: state.authorityDid },
      403,
      'Forbidden',
    ],
    [
      'upstream-service-audience-denied',
      { aud: state.pdsDid },
      403,
      'Forbidden',
    ],
    [
      'upstream-wrong-method-denied',
      { lxm: 'com.atproto.space.listRecords' },
      401,
      'BadJwtLexiconMethod',
    ],
    [
      'upstream-missing-method-denied',
      { lxm: null },
      401,
      'BadJwtLexiconMethod',
    ],
  ]) {
    await record(id, async () => {
      await responseContract(
        await notify(
          { space: state.space, credentials: [state.b.jti] },
          options,
        ),
        status,
        error,
      )
      await readable(state.b)
    })
  }
  await record('upstream-malformed-batch-denied', async () => {
    for (const credentials of [
      [],
      [state.b.jti, ''],
      Array(101).fill(state.b.jti),
    ]) {
      await responseContract(
        await notify({ space: state.space, credentials }),
        400,
        'InvalidRequest',
      )
      await readable(state.b)
    }
  })
  await record('upstream-cross-space-isolation', async () => {
    await responseContract(
      await notify({ space: state.otherSpace, credentials: [state.b.jti] }),
      200,
    )
    await readable(state.b)
  })
  await record('upstream-grant-a-revoked-b-unaffected', async () => {
    await responseContract(
      await notify({ space: state.space, credentials: [state.a.jti] }),
      200,
    )
    await responseContract(await read(state.a), 401, 'CredentialRevoked')
    await readable(state.b)
  })
  await record('upstream-duplicate-idempotence', async () => {
    await responseContract(
      await notify({
        space: state.space,
        credentials: [state.a.jti, state.a.jti],
      }),
      200,
    )
    await responseContract(await read(state.a), 401, 'CredentialRevoked')
    await readable(state.b)
  })
  await record('stratos-unsupported-route', async () => {
    await responseContract(await unsupported(), 501, 'MethodNotImplemented')
  })
  await record('stratos-unsupported-role-unadvertised', async () => {
    const doc = await document()
    assert.equal(doc.id, state.authorityDid)
    assert.ok(Array.isArray(doc.service))
    assert.ok(
      !doc.service.some(
        (service) =>
          service.id === '#atproto_space_host' ||
          service.id === state.authorityDid + '#atproto_space_host',
      ),
    )
  })
  return { ...state, passed }
}

export async function verifyAfter(state, read) {
  await responseContract(await read(state.a), 401, 'CredentialRevoked')
  const response = await read(state.b)
  await responseContract(response, 200)
  assert.ok(
    (await response.json()).records.some(
      (item) => item.value?.text === state.seedText,
    ),
  )
  return {
    suite: 'credential-revocation-contract',
    assertions: [...state.passed, 'upstream-restart-retention'].map((id) => ({
      id,
      status: 'passed',
    })),
  }
}

export async function prepare({
  domain = process.env.SANDBOX_DOMAIN,
  openBrowser: open = openBrowser,
  prepareAccount: accountFor = prepareAccount,
  proofKey: keyFor = proofKey,
  acquireDelegation: delegationFor = acquireDelegation,
  signedHeaders: headersFor = signedHeaders,
  credentialLifetime: lifetime = credentialLifetime,
  fetch: request = fetch,
} = {}) {
  assert.match(domain ?? '', /^[a-z0-9.-]+$/)
  const authorityDid = `did:web:stratos-e2e.${domain}`
  const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
  const browser = await open()
  try {
    const { account, page } = await accountFor(browser, 'faye')
    const mint = async () => {
      const key = keyFor()
      const token = await delegationFor(page)
      const response = await request(
        'https://stratos-e2e.atmosbox.internal/xrpc/zone.stratos.space.getSpaceCredential',
        {
          method: 'POST',
          headers: {
            ...headersFor('Bearer ' + token, key),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ space }),
        },
      )
      const { credential, claims } = await lifetime(response)
      assert.equal(claims.iss, authorityDid)
      assert.equal(claims.sub, space)
      assert.equal(typeof claims.jti, 'string')
      assert.ok(claims.jti.length > 0)
      return {
        jti: claims.jti,
        headers: headersFor('Atproto-Space ' + credential, key, account.did),
      }
    }
    const url = new URL(
      `/xrpc/com.atproto.space.listRecords`,
      `https://october-pds-e2e.${domain}`,
    )
    url.searchParams.set('repo', account.did)
    url.searchParams.set('space', space)
    url.searchParams.set('collection', 'zone.stratos.feed.post')
    return {
      authorityDid,
      pdsDid: `did:web:october-pds-e2e.${domain}`,
      space,
      otherSpace: space.replace('/general', '/other'),
      did: account.did,
      seedText: account.seedText,
      url: url.href,
      a: await mint(),
      b: await mint(),
    }
  } finally {
    await browser.close()
  }
}

export async function authorityCheck(
  state,
  {
    loadIdentity = () =>
      import('/app/stratos-service/dist/infra/signing/service-identity.js'),
    stat: inspect = stat,
    mkdtemp: temporary = mkdtemp,
    symlink: link = symlink,
    rm: remove = rm,
    fetch: request = fetch,
  } = {},
) {
  const { openServiceSigningIdentity } = await loadIdentity()
  const file = '/app/data/service-signing-identity.json'
  const before = await inspect(file)
  assert.ok(before.isFile())
  const directory = await temporary('/tmp/revocation-contract-')
  try {
    await link(file, directory + '/service-signing-identity.json')
    const identity = await openServiceSigningIdentity(
      directory,
      state.authorityDid,
    )
    try {
      const notify = async (body, options = {}) => {
        const encode = (value) =>
          Buffer.from(JSON.stringify(value)).toString('base64url')
        const now = Math.floor(Date.now() / 1000)
        const input =
          encode({ typ: 'JWT', alg: identity.signingKey.jwtAlg }) +
          '.' +
          encode({
            iss: state.authorityDid,
            aud: state.did,
            lxm: method,
            iat: now,
            exp: now + 60,
            jti: randomUUID(),
            ...options,
            ...(options.lxm === null ? { lxm: undefined } : {}),
          })
        const signature = await identity.signingKey.sign(Buffer.from(input))
        return request(
          `https://${state.pdsDid.slice('did:web:'.length)}/xrpc/${method}`,
          {
            method: 'POST',
            headers: {
              authorization:
                'Bearer ' +
                input +
                '.' +
                Buffer.from(signature).toString('base64url'),
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          },
        )
      }
      return await verifyBefore(state, {
        read: (grant) => request(state.url, { headers: grant.headers }),
        notify,
        unsupported: () =>
          request(`https://stratos-e2e.atmosbox.internal/xrpc/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              space: state.space,
              credentials: [state.a.jti],
            }),
          }),
        document: async () => {
          const response = await request(
            'https://stratos-e2e.atmosbox.internal/.well-known/did.json',
          )
          await responseContract(response, 200)
          return response.json()
        },
      })
    } finally {
      await identity.close()
      const after = await inspect(file)
      assert.equal(after.ino, before.ino)
      assert.equal(after.size, before.size)
      assert.equal(after.mtimeMs, before.mtimeMs)
    }
  } finally {
    await remove(directory, { recursive: true, force: true })
  }
}

export async function runCli(
  runtime = process,
  {
    prepare: prepareState = prepare,
    authorityCheck: check = authorityCheck,
    fetch: request = fetch,
    output = console.log,
    error = console.error,
  } = {},
) {
  try {
    const phase = runtime.argv[2]
    let result
    if (phase === 'prepare') result = await prepareState()
    else {
      let input = ''
      for await (const chunk of runtime.stdin) input += chunk
      const state = JSON.parse(input)
      if (phase === 'before') result = await check(state)
      else {
        assert.equal(phase, 'after')
        result = await verifyAfter(state, (grant) =>
          request(state.url, { headers: grant.headers }),
        )
      }
    }
    output(JSON.stringify(result))
  } catch {
    error('Credential revocation contract probe failed')
    runtime.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runCli()
