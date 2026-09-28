import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const [sandbox, project] = process.argv.slice(2)
assert.ok(sandbox && project)
const composePrefix = [
  'compose',
  '--project-name',
  project,
  '--project-directory',
  sandbox,
]
const domain = JSON.parse(
  await readFile(join(sandbox, 'state/manifest.json'), 'utf8'),
).domain
assert.equal(domain, 'atmosbox.test')
const authority = `did:web:stratos-e2e.${domain}`
const boundary = `${authority}/general`
const assertions = []

async function command(args, label) {
  try {
    return (
      await execute('docker', args, {
        cwd: sandbox,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout
  } catch (error) {
    throw new Error(
      `${label} failed with exit ${error.code ?? 'unknown'}: ${(error.stderr ?? '').slice(-1200)}`,
    )
  }
}

function compose(args, label) {
  return command([...composePrefix, ...args], label)
}

function parsedLine(output, prefix) {
  const line = output
    .split('\n')
    .map((value) => value.trim())
    .findLast((value) => value.startsWith(prefix))
  assert.ok(line, 'Sandbox command returned no structured result')
  return JSON.parse(line)
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const proxyScript = String.raw`
import http from 'node:http'
const held = []
let pending = 0
let armed = false
let aborted = 0
http.createServer(async (req, res) => {
  res.on('close', () => { if (!res.writableEnded) aborted += 1 })
  const path = new URL(req.url, 'http://proxy').pathname
  if (path === '/_control/hold') {
    armed = true
    aborted = 0
    res.end('ok')
    return
  }
  if (path === '/_control/status') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ pending, armed, aborted }))
    return
  }
  if (path === '/_control/release') {
    armed = false
    for (const release of held.splice(0)) release()
    res.end('ok')
    return
  }
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const headers = { ...req.headers }
    delete headers.connection
    const upstream = await fetch('http://feedgen-e2e-pds-spaces:3000' + req.url, {
      method: req.method, headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    })
    if (path === '/xrpc/com.atproto.space.listRepoOps') {
      console.error('event=revocation_proxy_page status=' + upstream.status)
    }
    const body = Buffer.from(await upstream.arrayBuffer())
    if (armed && path === '/xrpc/com.atproto.space.listRepoOps') {
      armed = false
      pending += 1
      await new Promise((resolve) => held.push(resolve))
      pending -= 1
    }
    const responseHeaders = Object.fromEntries(upstream.headers)
    delete responseHeaders['content-length']
    delete responseHeaders['content-encoding']
    delete responseHeaders['transfer-encoding']
    res.writeHead(upstream.status, responseHeaders)
    res.end(body)
  } catch {
    res.writeHead(502)
    res.end()
  }
}).listen(3000, '0.0.0.0')
`

const browserScript = String.raw`
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const domain = process.env.SANDBOX_DOMAIN
const authority = 'did:web:stratos-e2e.' + domain
const action = process.env.REVOCATION_ACTION
const state = JSON.parse(await readFile('/sandbox-state/accounts.json', 'utf8'))
async function session(url, identifier, password) {
  const response = await fetch(url + '/xrpc/com.atproto.server.createSession', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  assert.equal(response.status, 200)
  return response.json()
}
if (action === 'write') {
  const url = 'https://spaces-pds-e2e.' + domain
  const password = (await readFile('/run/sandbox-secrets/browser-password', 'utf8')).trim()
  const actor = await session(url, 'motoko.spaces-pds-e2e.' + domain, password)
  const response = await fetch(url + '/xrpc/com.atproto.space.createRecord', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + actor.accessJwt, 'content-type': 'application/json' },
    body: JSON.stringify({
      space: 'at://' + authority + '/space/zone.stratos.space.feed/general',
      repo: actor.did, collection: 'zone.stratos.feed.post',
      record: { $type: 'zone.stratos.feed.post', text: 'Revocation fixture ' + randomUUID(), createdAt: new Date().toISOString() },
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.uri && body.cid)
  console.log(JSON.stringify({ kind: 'revocation-write', ok: true }))
} else {
  assert.equal(action, 'read')
  const username = 'user1.pds1.' + domain
  const account = state.accounts[username]
  assert.ok(account?.password)
  const url = 'https://pds1.' + domain
  const actor = await session(url, username, account.password)
  const endpoint = new URL(url + '/xrpc/zone.stratos.feedgen.getFeed')
  endpoint.searchParams.set('feed', 'general')
  endpoint.searchParams.set('limit', '50')
  let response
  for (let attempt = 0; attempt < 20; attempt++) {
    response = await fetch(endpoint, {
      headers: { authorization: 'Bearer ' + actor.accessJwt,
        'atproto-proxy': 'did:web:feedgen-e2e.' + domain + '#stratos_feedgen' },
    })
    if (response.ok) break
    const error = await response.json()
    assert.equal(error.error, 'FeedNotReady')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (response.status === 503) {
    console.log(JSON.stringify({ kind: 'revocation-feed', notReady: true }))
    process.exit(0)
  }
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(Array.isArray(body.feed))
  const uris = body.feed.map((entry) => entry.post?.uri)
  console.log(JSON.stringify({ kind: 'revocation-feed',
    pds: uris.filter((uri) => uri?.includes('/space/')).length,
    other: uris.filter((uri) => uri?.startsWith('at://') && !uri.includes('/space/')).length }))
}
`

const adminScript = String.raw`
import assert from 'node:assert/strict'
import { createServiceDb, closeServiceDb } from './dist/db/index.js'
import { SqliteEnrollmentStore } from './dist/storage/sqlite/enrollment-store.js'
import { SqliteAdminUserStore } from './dist/oauth/admin-user-store.js'
import { SqliteAdminSessionStore } from './dist/oauth/admin-session-store.js'
const authority = 'did:web:stratos-e2e.' + process.env.SANDBOX_DOMAIN
const boundary = authority + '/general'
const action = process.env.REVOCATION_ACTION
if (action === 'setup') {
  const db = createServiceDb('/app/data/service.sqlite')
  async function setupWrite(write) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { return await write() }
      catch (error) {
        if (error?.cause?.code !== 'SQLITE_BUSY' || attempt === 9) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
  try {
    const enrollment = new SqliteEnrollmentStore(db)
    const admins = new SqliteAdminUserStore(db)
    const sessions = new SqliteAdminSessionStore(db)
    const members = await enrollment.listEnrollmentsByBoundary(authority + '/all', { limit: 100 })
    const actor = members.find((entry) => entry.custody === 'pds')
    assert.ok(actor, 'Baseline PDS-custody actor is missing')
    const admin = 'did:plc:revocationfixture'
    await setupWrite(() => admins.add(admin, admin))
    const key = await setupWrite(() => sessions.create(admin, 600_000))
    console.log(JSON.stringify({ kind: 'revocation-admin-setup', did: actor.did, key }))
  } finally {
    await closeServiceDb(db)
  }
} else {
  assert.ok(action === 'remove' || action === 'add')
  const did = process.env.REVOCATION_DID
  const key = process.env.REVOCATION_SESSION
  assert.ok(did && key)
  const response = await fetch('http://localhost:3100/xrpc/zone.stratos.admin.' +
    (action === 'remove' ? 'removeBoundary' : 'addBoundary'), {
    method: 'POST', headers: { origin: 'https://stratos-e2e.atmosbox.internal',
      cookie: 'stratos_admin_session=' + encodeURIComponent(key),
      'content-type': 'application/json' },
    body: JSON.stringify({ did, boundary }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(Array.isArray(body.boundaries))
  assert.equal(body.boundaries.includes(boundary), action === 'add')
  console.log(JSON.stringify({ kind: 'revocation-admin', action, ok: true }))
}
`

function browser(action) {
  return compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      '-e',
      `REVOCATION_ACTION=${action}`,
      'feedgen-e2e-browser',
      '--input-type=module',
      '-e',
      browserScript,
    ],
    `browser ${action}`,
  )
}

async function feed() {
  return parsedLine(await browser('read'), '{"kind":"revocation-feed",')
}

async function admin(action, access) {
  const output = await compose(
    [
      'exec',
      '-T',
      '-e',
      `REVOCATION_ACTION=${action}`,
      ...(access
        ? [
            '-e',
            `REVOCATION_DID=${access.did}`,
            '-e',
            `REVOCATION_SESSION=${access.key}`,
          ]
        : []),
      'feedgen-e2e-stratos',
      'node',
      '--input-type=module',
      '-e',
      adminScript,
    ],
    `authority ${action}`,
  )
  if (action === 'setup') {
    const setup = parsedLine(output, '{"kind":"revocation-admin-setup",')
    assert.ok(setup.did && setup.key)
    return setup
  }
  const result = parsedLine(output, '{"kind":"revocation-admin",')
  assert.equal(result.action, action)
  assert.equal(result.ok, true)
}

async function control(action) {
  const output = await compose(
    [
      '-f',
      'compose.yaml',
      '-f',
      'state/pds-revocation-proxy.yaml',
      'exec',
      '-T',
      'pds-revocation-proxy',
      'node',
      '--input-type=module',
      '-e',
      `const r=await fetch('http://localhost:3000/_control/${action}');if(!r.ok)process.exit(1);console.log(await r.text())`,
    ],
    `proxy ${action}`,
  )
  return action === 'status' ? JSON.parse(output.trim()) : undefined
}

async function waitFor(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(500)
  }
  throw new Error(`${label} did not complete`)
}

const caddyPath = join(sandbox, 'state/Caddyfile')
const originalCaddy = await readFile(caddyPath, 'utf8')
const route = `${'spaces-pds-e2e.' + domain} {\n  tls internal\n  reverse_proxy feedgen-e2e-pds-spaces:3000\n}`
assert.ok(
  originalCaddy.includes(route),
  'PDS route no longer matches the pinned sandbox',
)
await waitFor(
  async () => {
    const initial = await feed()
    return initial.pds > 0 && initial.other > 0
  },
  'PDS and other-member baseline',
  60_000,
)
const adminAccess = await admin('setup')
let proxyStarted = false

try {
  const config = JSON.parse(
    await compose(['config', '--format', 'json'], 'inspect sandbox compose'),
  )
  const image = config.services['feedgen-e2e-pds-spaces']?.image
  assert.ok(typeof image === 'string' && image.length > 0)
  const proxyPath = join(sandbox, 'state/pds-revocation-proxy.mjs')
  await writeFile(proxyPath, proxyScript, { mode: 0o600 })
  await writeFile(
    join(sandbox, 'state/pds-revocation-proxy.yaml'),
    `services:\n  pds-revocation-proxy:\n    image: ${JSON.stringify(image)}\n    entrypoint: ["node", "/proxy.mjs"]\n    networks:\n      - atmosinabox\n    volumes:\n      - ${JSON.stringify(`${proxyPath}:/proxy.mjs:ro`)}\n`,
    { mode: 0o600 },
  )
  await compose(
    [
      '-f',
      'compose.yaml',
      '-f',
      'state/pds-revocation-proxy.yaml',
      'up',
      '-d',
      'pds-revocation-proxy',
    ],
    'start private proxy',
  )
  proxyStarted = true
  await writeFile(
    caddyPath,
    originalCaddy.replace(
      route,
      route.replace('feedgen-e2e-pds-spaces:3000', 'pds-revocation-proxy:3000'),
    ),
  )
  await compose(['restart', 'gateway'], 'route private PDS through proxy')

  await control('hold')
  parsedLine(await browser('write'), '{"kind":"revocation-write",')
  await waitFor(
    async () => (await control('status')).pending === 1,
    'paused PDS response',
  )
  await admin('remove', adminAccess)
  assert.deepEqual(await control('status'), {
    pending: 1,
    armed: false,
    aborted: 0,
  })
  await control('release')
  await waitFor(
    async () => {
      const result = await feed()
      return result.pds === 0 && result.other > 0
    },
    'authority revocation and other-member preservation',
    60_000,
  )
  assertions.push('other-member-preserved')
  assertions.push('late-page-revoked')

  await compose(['restart', 'feedgen-e2e-rust'], 'restart feedgen')
  await waitFor(async () => {
    const result = await feed()
    return result.pds === 0 && result.other > 0
  }, 'restart invalidation')
  assertions.push('restart-keeps-revocation')

  await admin('add', adminAccess)
  await waitFor(
    async () => (await feed()).pds > 0,
    'fresh membership recovery',
    90_000,
  )
  assertions.push('fresh-generation-recovers')

  await control('hold')
  parsedLine(await browser('write'), '{"kind":"revocation-write",')
  await waitFor(
    async () => (await control('status')).pending === 1,
    'paused old generation',
  )
  await admin('remove', adminAccess)
  await admin('add', adminAccess)
  assert.deepEqual(await control('status'), {
    pending: 1,
    armed: false,
    aborted: 0,
  })
  await control('release')
  await waitFor(
    async () => {
      const result = await feed()
      return result.pds === 0
    },
    'old generation rejection',
    60_000,
  )
  assertions.push('old-generation-rejected')
  await waitFor(
    async () => (await feed()).pds > 0,
    'new generation recovery',
    90_000,
  )

  console.log(
    JSON.stringify({
      suite: 'pds-revocation',
      assertions: assertions.map((id) => ({ id, status: 'passed' })),
    }),
  )
} finally {
  try {
    if (proxyStarted) await control('release')
  } finally {
    await writeFile(caddyPath, originalCaddy)
    await compose(['restart', 'gateway'], 'restore private PDS route')
  }
}
