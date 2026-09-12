import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { Secp256k1Keypair, type ExportableKeypair } from '@atproto/crypto'
import type { CatalogBoundary } from '../src/feeds/catalog-model.js'

// Run directly with tsx. The .smoke.ts suffix excludes this child process from Vitest/Stryker.
const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'nerv-catalog-cli-'))
let rows: CatalogBoundary[] = []
let failCatalog = false
let catalogRequests = 0
let credentialRequests = 0
let membershipRequests = 0
let subscriptions = 0
const authority = createServer((req, res) => {
  req.resume()
  res.setHeader('content-type', 'application/json')
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/xrpc/zone.stratos.sync.listBoundaries') {
    catalogRequests += 1
    res.statusCode = failCatalog ? 503 : 200
    res.end(
      JSON.stringify(
        failCatalog ? { error: 'Unavailable' } : { boundaries: rows },
      ),
    )
  } else if (path === '/xrpc/zone.stratos.space.getSpaceCredential') {
    credentialRequests += 1
    res.end(
      JSON.stringify({
        credential: 'local-smoke-credential',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    )
  } else if (path === '/xrpc/zone.stratos.space.listRepos') {
    membershipRequests += 1
    res.end(JSON.stringify({ repos: [] }))
  } else {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'UnexpectedLocalEndpoint' }))
  }
})
const sockets = new WebSocketServer({ noServer: true })
authority.on('upgrade', (req, socket, head) => {
  if (
    new URL(req.url ?? '/', 'http://127.0.0.1').pathname !==
    '/xrpc/zone.stratos.sync.subscribeRecords'
  ) {
    socket.destroy()
    return
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    subscriptions += 1
    sockets.emit('connection', ws, req)
  })
})
await new Promise<void>((resolve) => authority.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`
const reservation = createServer()
await new Promise<void>((resolve) =>
  reservation.listen(0, '127.0.0.1', resolve),
)
const port = (reservation.address() as AddressInfo).port
await new Promise<void>((resolve) => reservation.close(() => resolve()))
const serviceUrl = `http://127.0.0.1:${port}`
const signingKey = await Secp256k1Keypair.create({ exportable: true })
const signingKeyHex = Buffer.from(
  await (signingKey as ExportableKeypair).export(),
).toString('hex')
const child = spawn(
  join(root, 'node_modules/.bin/tsx'),
  ['stratos-feedgen/src/bin/main.ts'],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      FEEDGEN_SERVICE_DID: 'did:web:bebop.example',
      FEEDGEN_PUBLIC_URL: serviceUrl,
      FEEDGEN_SIGNING_KEY: signingKeyHex,
      STRATOS_SERVICE_URL: upstreamUrl,
      STRATOS_SERVICE_DID: 'did:web:nerv.example',
      FEEDGEN_PORT: String(port),
      FEEDGEN_SQLITE_PATH: join(directory, 'records.sqlite'),
      FEEDGEN_MEMBERSHIP_SQLITE_PATH: join(directory, 'membership.sqlite'),
      FEEDGEN_BLOB_CACHE_DIRECTORY: join(directory, 'blobs'),
      FEEDGEN_BOUNDARY_CATALOG_REFRESH_MS: '1000',
      FEEDGEN_BOUNDARY_CATALOG_MAX_AGE_MS: '3000',
      FEEDGEN_BOUNDARY_CATALOG_REQUEST_TIMEOUT_MS: '1000',
      FEEDGEN_SPACE_SYNC_ENABLED: 'false',
    },
  },
)
let logs = ''
const capture = (chunk: Buffer) => {
  logs = `${logs}${chunk.toString()}`.slice(-32000)
}
child.stdout.on('data', capture)
child.stderr.on('data', capture)
const exited = once(child, 'exit')
const watchdog = setTimeout(() => child.kill('SIGKILL'), 25000)
const deadline = Date.now() + 20000

async function waitUntil(
  check: () => Promise<boolean>,
  message: string,
): Promise<void> {
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Feedgen exited early: ${child.exitCode}`)
    try {
      if (await check()) return
    } catch {
      // The child may still be opening its local listener or changing readiness.
    }
    await delay(25)
  }
  throw new Error(message)
}

const health = () =>
  fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(500) })
async function describe(): Promise<{
  feeds: Array<{ id: string; displayName: string }>
}> {
  const response = await fetch(
    `${serviceUrl}/xrpc/zone.stratos.feedgen.describeFeed`,
    { signal: AbortSignal.timeout(500) },
  )
  assert.equal(response.status, 200)
  return (await response.json()) as {
    feeds: Array<{ id: string; displayName: string }>
  }
}

try {
  await waitUntil(
    async () => (await health()).status === 200,
    'Feedgen never became ready with the empty authority catalogue',
  )
  assert.deepEqual((await describe()).feeds, [])
  assert.ok(subscriptions > 0)
  assert.ok(catalogRequests >= 2)
  rows = [
    {
      boundary: 'did:web:nerv.example/bebop',
      roomId: 'bebop',
      displayName: 'Cowboy Crew',
      description: 'Faye and Spike',
      listed: true,
      joinable: false,
      revision: 1,
    },
  ]
  await waitUntil(
    async () => (await describe()).feeds[0]?.id === 'bebop',
    'Feedgen never discovered the new authority boundary',
  )
  assert.equal((await describe()).feeds[0]?.displayName, 'Cowboy Crew')
  assert.equal((await health()).status, 200)
  assert.ok(credentialRequests > 0)
  assert.ok(membershipRequests > 0)
  failCatalog = true
  await waitUntil(
    async () => (await health()).status === 503,
    'Feedgen remained ready after catalogue failure',
  )
  assert.deepEqual((await describe()).feeds, [])
  child.kill('SIGTERM')
  const [code, signal] = await exited
  assert.equal(signal, null)
  assert.equal(code, 0)
  console.info(
    'PASS: actual feedgen CLI discovers upstream boundaries, fails closed, and shuts down cleanly',
  )
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n${logs.replaceAll(signingKeyHex, '[redacted]')}`,
  )
} finally {
  clearTimeout(watchdog)
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL')
  await exited
  for (const socket of sockets.clients) socket.terminate()
  await new Promise<void>((resolve) => sockets.close(() => resolve()))
  authority.closeAllConnections()
  await new Promise<void>((resolve) => authority.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
}
