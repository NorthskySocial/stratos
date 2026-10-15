import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  openBrowser,
  prepareAccount,
  acquireDelegation,
  removeMember,
  denied,
  credentialLifetime,
} from './standard-credential-transport.driver.mjs'

export const requiredAssertions = [
  'rust-manager-expiry-refresh',
  'rust-standard-exchange',
  'rust-stratos-read',
  'rust-october-pds-read',
  'rust-two-owners-one-host',
  'rust-wrong-owner-denied',
  'rust-wrong-key-denied',
  'rust-same-signature-reused',
  'rust-renewal-fresh-key',
  'rust-renewal-after-removal-denied',
]

export async function runScenario() {
  const child = spawn('/usr/local/bin/space_interop_probe', [], {
    env: { ...process.env, SSL_CERT_FILE: '/ca/root.crt' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let exited = false
  child.on('error', () => {
    exited = true
    child.stdout.destroy()
  })
  child.on('exit', () => {
    exited = true
  })
  async function probe(input) {
    assert.equal(exited, false, 'Rust signing probe exited')
    child.stdin.write(JSON.stringify(input) + '\n')
    const response = await lines.next()
    assert.equal(
      response.done,
      false,
      'Rust signing probe returned no response',
    )
    return JSON.parse(response.value)
  }
  const domain = process.env.SANDBOX_DOMAIN
  assert.match(domain ?? '', /^[a-z0-9.-]+$/)
  const authority = 'https://stratos-e2e.atmosbox.internal'
  const authorityDid = `did:web:stratos-e2e.${domain}`
  const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
  const pds = `https://october-pds-e2e.${domain}`
  const passed = []
  let browser
  try {
    browser = await openBrowser()
    const { account, page } = await prepareAccount(browser, 'faye')
    const second = await prepareAccount(browser, 'edward')
    assert.notEqual(account.did, second.account.did)
    async function exchange(grant, delegation) {
      const headers = await probe({ operation: 'exchange', grant, delegation })
      assert.ok(
        headers.signature.endsWith('==:'),
        'Rust compact signature must retain padding',
      )
      return fetch(`${authority}/xrpc/zone.stratos.space.getSpaceCredential`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ space }),
      })
    }
    function presentation(grant, credential, audience) {
      return probe({ operation: 'present', grant, credential, audience })
    }
    function recordsUrl(repo) {
      const url = new URL('/xrpc/com.atproto.space.listRecords', pds)
      for (const [name, value] of Object.entries({
        repo,
        space,
        collection: 'zone.stratos.feed.post',
      }))
        url.searchParams.set(name, value)
      return url
    }
    async function read(repo, headers, marker) {
      const response = await fetch(recordsUrl(repo), { headers })
      assert.equal(response.status, 200, 'Rust-signed October PDS read failed')
      assert.ok(
        (await response.json()).records.some(
          (item) => item.value?.text === marker,
        ),
        'Rust read omitted actual seeded record',
      )
    }
    const key = await probe({ operation: 'generate', grant: 'initial' })
    const { credential, claims } = await credentialLifetime(
      await exchange('initial', await acquireDelegation(page)),
      10,
    )
    assert.equal(claims.iss, authorityDid)
    assert.equal(claims.sub, space)
    assert.equal(claims.cnf.kid, key.keyId)
    passed.push('rust-standard-exchange')
    const headers = await presentation('initial', credential, account.did)
    await read(account.did, headers, account.seedText)
    passed.push('rust-october-pds-read')
    await read(account.did, headers, account.seedText)
    passed.push('rust-same-signature-reused')
    await denied(
      await fetch(recordsUrl(second.account.did), { headers }),
      'wrong-owner-denied',
    )
    passed.push('rust-wrong-owner-denied')
    await read(
      second.account.did,
      await presentation('initial', credential, second.account.did),
      second.account.seedText,
    )
    passed.push('rust-two-owners-one-host')
    await probe({ operation: 'generate', grant: 'wrong' })
    const wrong = await fetch(recordsUrl(account.did), {
      headers: await presentation('wrong', credential, account.did),
    })
    // Production presentation deliberately omits keyid: upstream detects the wrong key cryptographically.
    assert.equal(wrong.status, 401)
    const wrongBody = await wrong.json()
    assert.equal(wrongBody.error, 'BadSpaceSignature')
    assert.equal(wrongBody.message, 'invalid HTTP message signature')
    passed.push('rust-wrong-key-denied')
    const membersUrl = new URL('/xrpc/zone.stratos.space.listRepos', authority)
    membersUrl.searchParams.set('space', space)
    const members = await fetch(membersUrl, {
      headers: await presentation('initial', credential, authorityDid),
    })
    assert.equal(members.status, 200)
    const membership = await members.json()
    assert.ok(
      membership.repos.some((repo) => repo.did === account.did),
      'Authority omitted actual enrolled owner',
    )
    passed.push('rust-stratos-read')
    const next = await probe({ operation: 'generate', grant: 'renewed' })
    assert.notEqual(next.keyId, key.keyId)
    const renewed = await credentialLifetime(
      await exchange('renewed', await acquireDelegation(page)),
      10,
    )
    assert.equal(renewed.claims.cnf.kid, next.keyId)
    await read(
      account.did,
      await presentation('renewed', renewed.credential, account.did),
      account.seedText,
    )
    passed.push('rust-renewal-fresh-key')
    assert.deepEqual(
      await probe({
        operation: 'manager-init',
        authority,
        authority_did: authorityDid,
        feedgen_did: `did:web:feedgen-e2e.${domain}`,
        signing_key: await readFile(
          '/run/sandbox-secrets/probe-service-signing-key',
          'utf8',
        ),
      }),
      { ready: true },
    )
    const managerRequest = {
      operation: 'manager-get',
      boundary: `${authorityDid}/general`,
      audience: account.did,
    }
    const first = await probe(managerRequest)
    assert.equal(typeof first.keyId, 'string', 'Production issuer failed')
    await read(account.did, first.headers, account.seedText)
    const cached = await probe(managerRequest)
    assert.equal(cached.keyId, first.keyId, 'Manager did not cache short grant')
    // Wait beyond the configured actual lifetime, without advancing a test clock.
    await new Promise((resolve) => setTimeout(resolve, 11000))
    const refreshed = await probe(managerRequest)
    assert.equal(typeof refreshed.keyId, 'string', 'Production refresh failed')
    assert.notEqual(refreshed.keyId, first.keyId)
    await read(account.did, refreshed.headers, account.seedText)
    passed.push('rust-manager-expiry-refresh')
    const removalDelegation = await acquireDelegation(page)
    assert.equal(await removeMember(page), 200)
    await probe({ operation: 'generate', grant: 'removed' })
    await denied(
      await exchange('removed', removalDelegation),
      'renewal-after-removal-denied',
    )
    passed.push('rust-renewal-after-removal-denied')
    assert.deepEqual([...passed].sort(), [...requiredAssertions].sort())
    return {
      suite: 'rust-production-interop',
      assertions: passed.map((id) => ({ id, status: 'passed' })),
    }
  } finally {
    child.stdin.end()
    child.kill()
    await browser?.close()
  }
}

try {
  console.log(JSON.stringify(await runScenario()))
} catch (error) {
  console.error(
    'Rust production interoperability failed: ' +
      (error instanceof Error ? error.name : 'UnknownError'),
  )
  process.exitCode = 1
}
