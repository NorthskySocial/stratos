#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  createHash,
  createHmac,
  createPublicKey,
  ECDH,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  assertCurrentAuthorityDiscovery,
  assertStandardRouteUnsupported,
  didWebDocumentUrl,
  writerSigningKeyMultibase,
} from './authority-contract.discovery.mjs'

const require = createRequire('/runner/feedgen-ng-e2e-browser.mjs')
const { chromium } = require('playwright')
const domain = process.env.SANDBOX_DOMAIN
assert.equal(domain, 'atmosbox.test')
const clubhouse = 'https://clubhouse-e2e.atmosbox.internal'
const authority = 'https://stratos-e2e.atmosbox.internal'
const pds = `https://spaces-pds-e2e.${domain}`
const authorityDid = `did:web:stratos-e2e.${domain}`
const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
const mintUrl = `${authority}/xrpc/zone.stratos.space.getSpaceCredential`
const assertions = []

async function trustSandboxCa() {
  const certificate = '/ca/root.crt'
  await readFile(certificate)
  const database = path.join(process.env.HOME || '/tmp/config', '.pki', 'nssdb')
  await mkdir(database, { recursive: true })
  try {
    execFileSync(
      'certutil',
      ['-N', '-d', `sql:${database}`, '--empty-password'],
      {
        stdio: 'ignore',
      },
    )
  } catch {
    // The disposable browser profile may already have a trust database.
  }
  execFileSync(
    'certutil',
    [
      '-A',
      '-d',
      `sql:${database}`,
      '-n',
      'authority-contract',
      '-t',
      'C,,',
      '-i',
      certificate,
    ],
    { stdio: 'ignore' },
  )
}

async function clickEnabled(locator) {
  for (let index = 0; index < (await locator.count()); index += 1) {
    const button = locator.nth(index)
    if (
      (await button.isVisible().catch(() => false)) &&
      (await button.isEnabled())
    ) {
      await button.click({ noWaitAfter: true, timeout: 2_000 }).catch(() => {})
      return true
    }
  }
  return false
}

async function finishOAuth(page, username, password) {
  const deadline = Date.now() + 60_000
  let leftApp = false
  while (Date.now() < deadline) {
    const current = new URL(page.url())
    if (current.origin !== clubhouse) leftApp = true
    if (leftApp && current.origin === clubhouse) return
    const passwordInput = page
      .locator('input[name="password"], input[type="password"]')
      .first()
    if (await passwordInput.isVisible().catch(() => false)) {
      const usernameInput = page
        .locator(
          'input[name="username"]:not([readonly]):not([disabled]), input[name="identifier"]:not([readonly]):not([disabled])',
        )
        .first()
      if (await usernameInput.isVisible().catch(() => false))
        await usernameInput.fill(username)
      await passwordInput.fill(password)
      if (
        await clickEnabled(
          page.locator('button[type="submit"], button:has-text("Sign in")'),
        )
      ) {
        await delay(300)
        continue
      }
      await page.keyboard.press('Enter')
    } else {
      await clickEnabled(
        page.locator(
          'button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")',
        ),
      )
    }
    await delay(250)
  }
  throw new Error('Private OAuth callback did not complete')
}

async function oauthPage(browser) {
  const page = await browser.newPage()
  const username = `motoko.spaces-pds-e2e.${domain}`
  const password = (
    await readFile('/run/sandbox-secrets/browser-password', 'utf8')
  ).trim()
  await page.route(`${clubhouse}/assets/**`, (route) => route.abort())
  await page.goto(clubhouse, { waitUntil: 'domcontentloaded' })
  await page.evaluate((value) => {
    window.delegationScenarioDomain = value
  }, domain)
  await page.addScriptTag({ path: '/scenario/auth-client.iife.js' })
  await page
    .evaluate(
      (handle) => window.delegationScenarioAuth.signIn(handle),
      username,
    )
    .catch(() => {})
  await finishOAuth(page, username, password)
  await page.evaluate((value) => {
    window.delegationScenarioDomain = value
  }, domain)
  await page.addScriptTag({ path: '/scenario/auth-client.iife.js' })
  const did = await page.evaluate(async () => {
    const session = await window.delegationScenarioAuth.init()
    if (!session) throw new Error('OAuth session was not restored')
    return session.sub
  })
  assert.match(did, /^did:/)
  return { page, did }
}

async function delegation(page) {
  return page.evaluate(
    async ({ pdsUrl, spaceUri }) => {
      const session = window.delegationScenarioAuth.getSession()
      if (!session) throw new Error('OAuth session missing')
      const url = new URL('/xrpc/com.atproto.space.getDelegationToken', pdsUrl)
      url.searchParams.set('space', spaceUri)
      const response = await session.fetchHandler(url.href, { method: 'GET' })
      if (!response.ok)
        throw new Error(`Delegation failed (${response.status})`)
      const body = await response.json()
      if (typeof body.token !== 'string')
        throw new Error('Delegation response has no token')
      return body.token
    },
    { pdsUrl: pds, spaceUri: space },
  )
}

function proofKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const jwk = publicKey.export({ format: 'jwk' })
  return { privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } }
}

function encode(value) {
  return Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url')
}

function dpop(key, url, method, token) {
  const target = new URL(url)
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk }
  const claims = {
    htm: method,
    htu: `${target.origin}${target.pathname}`,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...(token
      ? { ath: createHash('sha256').update(token).digest('base64url') }
      : {}),
  }
  const message = `${encode(header)}.${encode(claims)}`
  const signature = sign('sha256', Buffer.from(message), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${message}.${signature.toString('base64url')}`
}

function credentialRequest(url, key, credential) {
  return {
    headers: {
      authorization: `DPoP ${credential}`,
      dpop: dpop(key, url, 'GET', credential),
    },
  }
}

function bytes(value, size) {
  assert.equal(typeof value?.$bytes, 'string')
  const decoded = Buffer.from(value.$bytes, 'base64')
  assert.equal(decoded.length, size)
  return decoded
}

function tlsVector(value) {
  const length = Buffer.alloc(2)
  length.writeUInt16BE(value.length)
  return Buffer.concat([length, value])
}

function decodeBase58(value) {
  assert.ok(value.startsWith('z'))
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let integer = 0n
  for (const character of value.slice(1)) {
    const digit = alphabet.indexOf(character)
    assert.ok(digit >= 0)
    integer = integer * 58n + BigInt(digit)
  }
  let hex = integer.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const leading = value.slice(1).match(/^1*/)?.[0].length ?? 0
  return Buffer.concat([Buffer.alloc(leading), Buffer.from(hex, 'hex')])
}

async function verifySignedHead(commit, did) {
  assert.equal(commit.ver, 1)
  assert.match(commit.rev, /^[234567a-z]{13}$/)
  const hash = bytes(commit.hash, 32)
  const ikm = bytes(commit.ikm, 32)
  const signature = bytes(commit.sig, 64)
  const mac = bytes(commit.mac, 32)
  const context = Buffer.concat([
    Buffer.from('atproto-space-v1'),
    tlsVector(Buffer.from(space)),
    tlsVector(Buffer.from(did)),
    tlsVector(Buffer.from(commit.rev)),
    tlsVector(ikm),
  ])
  const expanded = createHmac('sha256', ikm)
    .update(context)
    .update(Buffer.from([1]))
    .digest()
  const expectedMac = createHmac('sha256', expanded).update(hash).digest()
  assert.ok(expectedMac.equals(mac), 'PDS signed-head MAC mismatch')

  const didResponse = await fetch(
    `https://plc.${domain}/${encodeURIComponent(did)}`,
  )
  assert.equal(didResponse.status, 200)
  const document = await didResponse.json()
  const multicodec = decodeBase58(writerSigningKeyMultibase(document, did))
  assert.equal(multicodec[0], 0xe7)
  assert.equal(multicodec[1], 0x01)
  const uncompressed = ECDH.convertKey(
    multicodec.subarray(2),
    'secp256k1',
    undefined,
    undefined,
    'uncompressed',
  )
  const publicKey = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'secp256k1',
      x: uncompressed.subarray(1, 33).toString('base64url'),
      y: uncompressed.subarray(33, 65).toString('base64url'),
    },
  })
  assert.ok(
    verify(
      'sha256',
      context,
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    ),
    'PDS signed-head signature mismatch',
  )
}

async function main() {
  await trustSandboxCa()
  const didResponse = await fetch(didWebDocumentUrl(authorityDid))
  assert.equal(didResponse.status, 200)
  const document = await didResponse.json()
  assertCurrentAuthorityDiscovery(document, authorityDid, authority)
  assertions.push('production-role-absent')

  const browser = await chromium.launch({ headless: true })
  try {
    const { page, did } = await oauthPage(browser)
    const token = await delegation(page)
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'))
    assert.equal(claims.iss, did)
    assert.equal(claims.sub, space)
    assert.equal(claims.aud, `${authorityDid}#atproto_space_host`)
    const key = proofKey()
    const minted = await fetch(mintUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        dpop: dpop(key, mintUrl, 'POST'),
      },
      body: JSON.stringify({ space }),
    })
    assert.equal(minted.status, 200)
    const credential = (await minted.json()).credential
    assert.equal(typeof credential, 'string')
    const boundClaims = JSON.parse(
      Buffer.from(credential.split('.')[1], 'base64url'),
    )
    assert.equal(boundClaims.sub, space)
    assert.equal(typeof boundClaims.cnf?.jkt, 'string')
    assertions.push('delegated-dpop-exchange')

    const recordsUrl = new URL('/xrpc/com.atproto.space.listRecords', pds)
    recordsUrl.searchParams.set('space', space)
    recordsUrl.searchParams.set('repo', did)
    recordsUrl.searchParams.set('collection', 'zone.stratos.feed.post')
    const recordsResponse = await fetch(
      recordsUrl,
      credentialRequest(recordsUrl.href, key, credential),
    )
    assert.equal(recordsResponse.status, 200)
    assert.ok((await recordsResponse.json()).records.length > 0)
    const wrongKey = await fetch(
      recordsUrl,
      credentialRequest(recordsUrl.href, proofKey(), credential),
    )
    assert.ok([401, 403].includes(wrongKey.status))
    assertions.push('credential-read-and-wrong-key')

    const headUrl = new URL('/xrpc/com.atproto.space.getLatestCommit', pds)
    headUrl.searchParams.set('space', space)
    headUrl.searchParams.set('repo', did)
    const headResponse = await fetch(
      headUrl,
      credentialRequest(headUrl.href, key, credential),
    )
    assert.equal(headResponse.status, 200)
    await verifySignedHead((await headResponse.json()).commit, did)
    assertions.push('pds-signed-head')

    for (const method of [
      'getSpaceCredential',
      'listRepos',
      'registerNotify',
      'unregisterNotify',
    ]) {
      const url = new URL(`/xrpc/com.atproto.space.${method}`, authority)
      const procedure = method !== 'listRepos'
      if (!procedure) url.searchParams.set('space', space)
      const response = await fetch(url, {
        method: procedure ? 'POST' : 'GET',
        headers: {
          authorization: `DPoP ${credential}`,
          dpop: dpop(key, url.href, procedure ? 'POST' : 'GET', credential),
          ...(procedure ? { 'content-type': 'application/json' } : {}),
        },
        ...(procedure
          ? {
              body: JSON.stringify({
                space,
                service: `did:web:feedgen-e2e.${domain}`,
              }),
            }
          : {}),
      })
      await assertStandardRouteUnsupported(response, method)
    }
    assertions.push('standard-routes-unsupported')
  } finally {
    await browser.close()
  }
  console.log(
    JSON.stringify({
      suite: 'authority-contract-browser',
      assertions: assertions.map((id) => ({ id, status: 'passed' })),
    }),
  )
}

main().catch((error) => {
  console.error(
    'Authority contract browser probe failed:',
    error instanceof Error ? error.message : String(error),
  )
  process.exitCode = 1
})
