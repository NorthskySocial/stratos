/**
 * Spike A6 — does a repo host check space membership on WRITE?
 *
 * "We only ever use OAuth" answers whether OUR client is correctly scoped. It
 * does not answer whether the host authorizes the write against the space
 * authority. This script tests that directly: a second account writes into a
 * space whose authority DID cannot be resolved at all and which has no member
 * list anywhere.
 *
 * If the write succeeds, the host authorizes writes purely from the caller's
 * own OAuth/session scope. Membership is then enforced only when a READER asks
 * the authority for a credential. Stratos must therefore treat "a record is in
 * this repo for my space" as an unverified claim until it checks its own
 * membership and boundary state.
 *
 * Run from stratos-service: pnpm exec tsx ../test/spike/spaces/a6-write-authorization.ts
 */
import { readFileSync } from 'node:fs'

const REPO_ROOT = new URL('../../../', import.meta.url).pathname
const ACCOUNTS_PATH = `${REPO_ROOT}../ops/alpha-users.json`
const COLLECTION = 'zone.stratos.feed.post'

// Deliberately unresolvable: no DNS, no DID document, no member list.
const UNRESOLVABLE_AUTHORITY = 'did:web:authority-that-does-not-exist.invalid'

const log = (step: string, detail: unknown) =>
  console.log(`\n── ${step}\n`, detail)

interface AlphaAccounts {
  pds: string
  accounts: { username: string; password: string }[]
}

async function main() {
  const cfg = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8')) as AlphaAccounts
  const pdsUrl = `https://${cfg.pds}`
  // The SECOND account, unrelated to the A5 writer.
  const account = cfg.accounts[1] ?? cfg.accounts[0]
  if (!account) throw new Error('no accounts in alpha-users.json')

  const sessionRes = await fetch(
    `${pdsUrl}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: account.username,
        password: account.password,
      }),
    },
  )
  const session = (await sessionRes.json()) as {
    did?: string
    accessJwt?: string
  }
  if (!sessionRes.ok || !session.accessJwt || !session.did) {
    throw new Error('could not authenticate the second account')
  }
  log('second account session', {
    handle: account.username,
    did: session.did,
  })

  const spaceUri = `at://${UNRESOLVABLE_AUTHORITY}/space/zone.stratos.space.feed/nobody`
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.space.createRecord`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      space: spaceUri,
      repo: session.did,
      collection: COLLECTION,
      rkey: `unauth${Date.now()}`,
      validate: false,
      record: {
        $type: COLLECTION,
        text: 'write-authorization probe',
        createdAt: new Date().toISOString(),
      },
    }),
  })
  const body = await res.json()
  log('write into an unresolvable, unowned space', {
    space: spaceUri,
    status: res.status,
    body,
  })

  console.log(`\n${'='.repeat(60)}`)
  if (res.ok) {
    console.log(
      'RESULT: the host does NOT authorize writes against the space authority.',
    )
    console.log('Presence of a record in a repo is NOT evidence of membership.')
  } else {
    console.log('RESULT: the host DID reject the write. Detail above.')
    // The whole mixed-mode boundary rule rests on this staying true. If a
    // host starts authorizing writes, that is a finding, not a passing run.
    process.exitCode = 1
  }
  console.log('='.repeat(60))
}

main().catch((err) => {
  console.error('spike failed:', err)
  process.exitCode = 1
})
