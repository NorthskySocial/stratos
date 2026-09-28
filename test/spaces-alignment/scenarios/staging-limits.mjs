import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const [sandbox, project] = process.argv.slice(2)
assert.ok(sandbox && project)
const prefix = ['compose', '--project-name', project, '--project-directory', sandbox]
const domain = JSON.parse(await readFile(join(sandbox, 'state/manifest.json'), 'utf8')).domain
assert.equal(domain, 'atmosbox.test')
const assertions = []

async function command(args) {
  const result = await execute('docker', args, {
    cwd: sandbox, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout
}

const compose = (args) => command([...prefix, ...args])
const withProxy = (args) => compose(['-f', 'compose.yaml', '-f', 'state/staging-limits-proxy.yaml', ...args])
const withLimits = (args) => compose(['-f', 'compose.yaml', '-f', 'state/staging-limits-config.yaml', ...args])
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, label, timeout = 150_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(1_000)
  }
  throw new Error(`${label} did not complete`)
}

const proxyScript = String.raw`
import http from 'node:http'
let mode = 'observe'
let blockedCursor = null
let pages = 0
let interruptions = 0
let firstRequests = 0
const cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://proxy')
  if (url.pathname === '/_control/mode') {
    mode = url.searchParams.get('value')
    blockedCursor = null
    res.end('ok')
    return
  }
  if (url.pathname === '/_control/status') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ pages, interruptions, firstRequests }))
    return
  }
  const isPage = url.pathname === '/xrpc/com.atproto.space.listRepoOps'
  if (isPage && !url.searchParams.has('cursor')) firstRequests += 1
  if (isPage && mode !== 'observe') {
    const cursor = url.searchParams.get('cursor')
    if (blockedCursor === cursor) {
      blockedCursor = null
      interruptions += 1
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"error":"Unavailable"}')
      return
    }
    const index = pages++
    const next = mode === 'limit' ? 'limit-' + (index + 1) : 'interrupted-' + (index + 1)
    blockedCursor = next
    const count = mode === 'limit' ? 10 : 1
    const ops = Array.from({ length: count }, (_, n) => ({
      rev: 'synthetic', collection: 'zone.stratos.feed.post',
      rkey: 'stage-' + index + '-' + n, cid,
      value: { $type: 'zone.stratos.feed.post', text: 'x'.repeat(1200),
        createdAt: new Date().toISOString() },
    }))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ops, cursor: next }))
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
    const body = Buffer.from(await upstream.arrayBuffer())
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

async function control(path) {
  const output = await withProxy([
    'exec', '-T', 'staging-limits-proxy', 'node', '--input-type=module', '-e',
    `const response = await fetch('http://localhost:3000/_control/${path}');
     if (!response.ok) process.exit(1); console.log(await response.text())`,
  ])
  return path === 'status' ? JSON.parse(output.trim()) : undefined
}

async function health() {
  const output = await compose([
    'run', '--rm', '--no-deps', '--entrypoint', 'node', 'feedgen-e2e-browser',
    '--input-type=module', '-e',
    `const start=Date.now();const response=await fetch('https://feedgen-e2e.${domain}/health');
     console.log(JSON.stringify({ status:response.status, elapsed:Date.now()-start }))`,
  ])
  return JSON.parse(output.trim().split('\n').findLast((line) => line.startsWith('{"status":')))
}

const caddyPath = join(sandbox, 'state/Caddyfile')
const originalCaddy = await readFile(caddyPath, 'utf8')
const route = `spaces-pds-e2e.${domain} {\n  tls internal\n  reverse_proxy feedgen-e2e-pds-spaces:3000\n}`
assert.ok(originalCaddy.includes(route), 'Pinned PDS route changed')
const config = JSON.parse(await compose(['config', '--format', 'json']))
const image = config.services['feedgen-e2e-pds-spaces']?.image
assert.ok(typeof image === 'string' && image.length > 0)
const proxyPath = join(sandbox, 'state/staging-limits-proxy.mjs')
await writeFile(proxyPath, proxyScript, { mode: 0o600 })
await writeFile(join(sandbox, 'state/staging-limits-proxy.yaml'),
  `services:\n  staging-limits-proxy:\n    image: ${JSON.stringify(image)}\n    entrypoint: ["node", "/proxy.mjs"]\n    networks: [atmosinabox]\n    volumes:\n      - ${JSON.stringify(`${proxyPath}:/proxy.mjs:ro`)}\n`, { mode: 0o600 })

let proxyStarted = false
let gatewayChanged = false
let limitsChanged = false
try {
  await withProxy(['up', '-d', 'staging-limits-proxy'])
  proxyStarted = true
  await writeFile(caddyPath, originalCaddy.replace(route,
    route.replace('feedgen-e2e-pds-spaces:3000', 'staging-limits-proxy:3000')))
  await compose(['restart', 'gateway'])
  gatewayChanged = true

  await writeFile(join(sandbox, 'state/staging-limits-config.yaml'),
    'services:\n  feedgen-e2e-rust:\n    environment:\n      FEEDGEN_PROJECTION_MAX_BYTES: "131072"\n      FEEDGEN_PROJECTION_MAX_AGE_MS: "86400000"\n',
    { mode: 0o600 })
  await withLimits(['up', '-d', '--no-deps', '--force-recreate', 'feedgen-e2e-rust'])
  limitsChanged = true
  await control('mode?value=limit')
  await waitFor(async () => (await control('status')).interruptions >= 2,
    'separate interrupted sync passes')
  await waitFor(async () => (await compose(['logs', '--no-color', 'feedgen-e2e-rust']))
    .includes('event=space_stage_budget_rejected'), 'persistent staging rejection')
  const progress = await control('status')
  assert.ok(progress.pages >= 3 && progress.interruptions >= 2)
  assertions.push('cumulative-pass-budget')

  const logs = await compose(['logs', '--no-color', 'feedgen-e2e-rust'])
  const accounting = logs.match(/event=space_stage_budget_rejected target_rows=(\d+) target_bytes=(\d+) global_rows=(\d+) global_bytes=(\d+)/)
  assert.ok(accounting)
  assert.ok(Number(accounting[2]) > 32_768)
  const fileSize = Number((await compose(['exec', '-T', 'feedgen-e2e-rust',
    'stat', '-c', '%s', '/var/lib/feedgen/projection.sqlite'])).trim())
  assert.ok(Number.isSafeInteger(fileSize) && fileSize > 0)
  assertions.push('storage-accounting')
  const response = await health()
  assert.ok([200, 503].includes(response.status) && response.elapsed < 2_000)
  assertions.push('service-responsive')

  await control('mode?value=interrupted')
  const before = (await control('status')).pages
  await waitFor(async () => (await control('status')).pages > before, 'fresh interrupted stage')
  assertions.push('interrupted-stage')
  await control('mode?value=observe')
  await writeFile(join(sandbox, 'state/staging-limits-config.yaml'),
    'services:\n  feedgen-e2e-rust:\n    environment:\n      FEEDGEN_PROJECTION_MAX_BYTES: "131072"\n      FEEDGEN_PROJECTION_MAX_AGE_MS: "1000"\n',
    { mode: 0o600 })
  await delay(2_000)
  const firstBefore = (await control('status')).firstRequests
  await withLimits(['up', '-d', '--no-deps', '--force-recreate', 'feedgen-e2e-rust'])
  await waitFor(async () => (await compose(['logs', '--no-color', 'feedgen-e2e-rust']))
    .includes('event=space_stage_cleanup expired_targets='), 'expired stage cleanup')
  await waitFor(async () => (await control('status')).firstRequests > firstBefore,
    'restart without staged cursor')
  assertions.push('expired-stage-restart')

  console.log(JSON.stringify({ suite: 'staging-limits',
    assertions: assertions.map((id) => ({ id, status: 'passed' })) }))
} finally {
  if (gatewayChanged) {
    await writeFile(caddyPath, originalCaddy)
    await compose(['restart', 'gateway'])
  }
  if (limitsChanged) {
    await compose(['up', '-d', '--no-deps', '--force-recreate', 'feedgen-e2e-rust'])
  }
  if (proxyStarted) {
    await withProxy(['stop', 'staging-limits-proxy'])
    await withProxy(['rm', '-f', 'staging-limits-proxy'])
  }
}
