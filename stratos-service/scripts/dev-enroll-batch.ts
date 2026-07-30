// Enroll a batch of test users against a locally running dev Stratos service.
//
// Creates real accounts on the PDS (PDS_HOST + PDS_ADMIN_PASSWORD from .env),
// so DIDs resolve in plc.directory and handle lookups work, then inserts
// enrollment rows directly into the dev service's SQLite DB
// (stratos-service/data/service.sqlite). Boundary domains are picked
// round-robin from STRATOS_ALLOWED_DOMAINS, prefixed with the service DID.
//
// Usage: pnpm exec tsx scripts/dev-enroll-batch.ts [count]
// The service DID is derived from STRATOS_PUBLIC_URL unless
// STRATOS_SERVICE_DID is set (dev-local exports it; otherwise pass it).

import { createClient } from '@libsql/client'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import dotenv from 'dotenv'

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
dotenv.config({ path: path.join(rootDir, '.env') })

const PDS_HOST = process.env.PDS_HOST
const PDS_ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD
if (!PDS_HOST || !PDS_ADMIN_PASSWORD) {
  console.error('PDS_HOST and PDS_ADMIN_PASSWORD must be set in .env')
  process.exit(1)
}
const PDS_URL = `https://${PDS_HOST}`

const serviceDid =
  process.env.STRATOS_SERVICE_DID ??
  (process.env.STRATOS_PUBLIC_URL
    ? `did:web:${encodeURIComponent(new URL(process.env.STRATOS_PUBLIC_URL).host)}`
    : undefined)
if (!serviceDid) {
  console.error('Set STRATOS_SERVICE_DID or STRATOS_PUBLIC_URL in .env')
  process.exit(1)
}

const domains = (process.env.STRATOS_ALLOWED_DOMAINS ?? 'general')
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean)
const reserved = process.env.STRATOS_RESERVED_DOMAIN ?? 'general'

const dbPath = path.join(rootDir, 'stratos-service', 'data', 'service.sqlite')
if (!fs.existsSync(dbPath)) {
  console.error(
    `Service DB not found at ${dbPath} — is the dev service set up?`,
  )
  process.exit(1)
}

// Mock-data convention: 90s anime names.
const NAMES = [
  'usagi',
  'makoto',
  'shinji',
  'asuka',
  'misato',
  'faye',
  'spike',
  'motoko',
  'utena',
  'belldandy',
]

const adminAuth =
  'Basic ' + Buffer.from(`admin:${PDS_ADMIN_PASSWORD}`).toString('base64')

async function createInviteCode(): Promise<string> {
  const res = await fetch(
    `${PDS_URL}/xrpc/com.atproto.server.createInviteCode`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: adminAuth,
      },
      body: JSON.stringify({ useCount: 1 }),
    },
  )
  if (!res.ok) {
    throw new Error(`createInviteCode: ${res.status} ${await res.text()}`)
  }
  const { code } = (await res.json()) as { code: string }
  return code
}

async function createAccount(
  handle: string,
  password: string,
  inviteCode: string,
): Promise<{ did: string; handle: string }> {
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle,
      email: `${handle.split('.')[0]}@example.com`,
      password,
      inviteCode,
    }),
  })
  if (!res.ok) {
    throw new Error(
      `createAccount ${handle}: ${res.status} ${await res.text()}`,
    )
  }
  return (await res.json()) as { did: string; handle: string }
}

async function main() {
  const count = Math.min(
    Number.parseInt(process.argv[2] ?? '5', 10) || 5,
    NAMES.length,
  )
  const suffix = randomBytes(2).toString('hex')
  const db = createClient({ url: `file:${dbPath}` })
  const enrolled: Array<{ handle: string; did: string; boundaries: string[] }> =
    []

  console.log(`Enrolling ${count} users (service DID: ${serviceDid})`)

  for (let i = 0; i < count; i++) {
    const handle = `${NAMES[i]}-${suffix}.${PDS_HOST}`
    const password = randomBytes(12).toString('base64url')
    const invite = await createInviteCode()
    const account = await createAccount(handle, password, invite)

    // Round-robin one extra domain on top of the reserved all-members domain.
    const extra = domains.filter((domain) => domain !== reserved)
    const boundaries = [
      `${serviceDid}/${reserved}`,
      ...(extra.length > 0 ? [`${serviceDid}/${extra[i % extra.length]}`] : []),
    ]

    const signingKeyDid = `did:key:dev-${createHash('sha256')
      .update(account.did)
      .digest('hex')
      .slice(0, 16)}`

    await db.execute({
      sql: `INSERT OR REPLACE INTO enrollment
              (did, enrolledAt, pdsEndpoint, signingKeyDid, active, isService)
            VALUES (?, ?, ?, ?, 'true', 0)`,
      args: [account.did, new Date().toISOString(), PDS_URL, signingKeyDid],
    })
    for (const boundary of boundaries) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO enrollment_boundary (did, boundary) VALUES (?, ?)`,
        args: [account.did, boundary],
      })
    }

    enrolled.push({ handle: account.handle, did: account.did, boundaries })
    console.log(`  ✓ ${account.handle} → ${account.did}`)
    console.log(`    boundaries: ${boundaries.join(', ')}`)
    console.log(`    password: ${password}`)
  }

  db.close()

  const outPath = path.join(rootDir, 'scripts', 'dev-enrolled-users.json')
  fs.writeFileSync(outPath, JSON.stringify(enrolled, null, 2))
  console.log(
    `\nDone. ${enrolled.length} users enrolled; details in ${outPath}`,
  )
  console.log('Look them up in the admin UI by DID (or handle, once resolved).')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
