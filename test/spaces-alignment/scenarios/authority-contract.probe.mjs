import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Secp256k1Keypair } from '@atproto/crypto'
import {
  advanceKnownWriter,
  planStandardWriters,
} from './authority-contract.adapter.ts'

const domain = Deno.env.get('SANDBOX_DOMAIN')
assert.equal(domain, 'atmosbox.test')
const authorityDid = `did:web:stratos-e2e.${domain}`
const issuerDid = `did:web:feedgen-e2e.${domain}`
const space = `at://${authorityDid}/space/zone.stratos.space.feed/general`
const endpoint = 'http://feedgen-e2e-stratos:3100'
const keypair = await Secp256k1Keypair.import(
  (await Deno.readTextFile('/run/sandbox-secrets/feedgen-signing-key')).trim(),
)

async function serviceToken(method) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ typ: 'JWT', alg: keypair.jwtAlg })
  const payload = encode({
    iss: issuerDid,
    aud: authorityDid,
    lxm: method,
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
  })
  const content = `${header}.${payload}`
  const signature = await keypair.sign(new TextEncoder().encode(content))
  return `${content}.${Buffer.from(signature).toString('base64url')}`
}

async function listCustomRepos() {
  const method = 'zone.stratos.space.listRepos'
  const url = `${endpoint}/xrpc/${method}?space=${encodeURIComponent(space)}`
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${await serviceToken(method)}` },
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(Array.isArray(body.repos))
  return body.repos
}

try {
  const repos = await listCustomRepos()
  assert.ok(repos.some((row) => row.custody === 'stratos'))
  assert.ok(repos.some((row) => row.custody === 'pds'))
  assert.ok(repos.every((row) => row.hash === undefined))
  const members = repos.map((row) => ({
    did: row.did,
    custody: row.custody,
    active: true,
    boundaries: ['general'],
  }))
  const plan = planStandardWriters(members, 'general', space, new Map())
  assert.equal(plan.publishable, false)
  assert.equal(plan.rows.length, 0)
  assert.ok(plan.blockers.some((blocker) => blocker.startsWith('MST custody')))
  assert.ok(
    plan.blockers.some((blocker) =>
      blocker.startsWith('Missing verified PDS head'),
    ),
  )

  const fakeDid = 'did:plc:000000000000000000000000'
  assert.ok(repos.every((row) => row.did !== fakeDid))
  assert.throws(
    () =>
      advanceKnownWriter(
        [],
        {
          space,
          repo: fakeDid,
          rev: '3lqj7l6h6x222',
          hash: new Uint8Array(32),
          issuer: fakeDid,
          audience: authorityDid,
        },
        authorityDid,
        space,
        'general',
        members,
        {},
      ),
    /cannot discover a writer/,
  )
  const method = 'com.atproto.space.notifyWrite'
  const response = await fetch(`${endpoint}/xrpc/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await serviceToken(method)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      space,
      repo: fakeDid,
      rev: '3lqj7l6h6x222',
      hash: { $bytes: Buffer.alloc(32).toString('base64') },
    }),
  })
  assert.equal(response.status, 404, 'Production notifyWrite route was exposed')
  const after = await listCustomRepos()
  assert.deepEqual(
    after.map((row) => row.did),
    repos.map((row) => row.did),
  )

  console.log(
    JSON.stringify({
      suite: 'authority-contract-wire',
      assertions: [
        { id: 'mixed-custody-hash-gap', status: 'passed' },
        { id: 'unsolicited-writer-not-admitted', status: 'passed' },
      ],
    }),
  )
} catch (error) {
  console.error(
    'Authority contract wire probe failed:',
    error instanceof Error ? error.message : String(error),
  )
  Deno.exit(1)
}
