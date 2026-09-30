import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const [sandbox, project] = process.argv.slice(2)
assert.ok(sandbox && project)
const prefix = [
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
const assertions = []

async function command(args) {
  const result = await execute('docker', args, {
    cwd: sandbox,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout
}

const compose = (args) => command([...prefix, ...args])
const withProxy = (args) =>
  compose([
    '-f',
    'compose.yaml',
    '-f',
    'state/staging-limits-proxy.yaml',
    ...args,
  ])
const withLimits = (args) =>
  compose([
    '-f',
    'compose.yaml',
    '-f',
    'state/staging-limits-config.yaml',
    ...args,
  ])
const withAccount = (args) =>
  compose([
    '-f',
    'compose.yaml',
    '-f',
    'state/staging-limits-account.yaml',
    ...args,
  ])
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, label, timeout = 150_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(1_000)
  }
  const status = await control('status').catch(() => null)
  throw new Error(`${label} did not complete: proxy ${JSON.stringify(status)}`)
}

async function control(path) {
  const output = await withProxy([
    'exec',
    '-T',
    'staging-limits-proxy',
    'node',
    '--input-type=module',
    '-e',
    `const response = await fetch('http://localhost:3000/_control/${path}');
     if (!response.ok) process.exit(1); console.log(await response.text())`,
  ])
  return path === 'status' ? JSON.parse(output.trim()) : undefined
}

async function health() {
  const output = await compose([
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'node',
    'feedgen-e2e-browser',
    '--input-type=module',
    '-e',
    `const start=Date.now();const response=await fetch('https://feedgen-e2e.${domain}/health');
     console.log(JSON.stringify({ status:response.status, elapsed:Date.now()-start }))`,
  ])
  return JSON.parse(
    output
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{"status":')),
  )
}

async function generalFeed() {
  const output = await compose([
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'node',
    'feedgen-e2e-browser',
    '--input-type=module',
    '-e',
    `const password=(await (await import('node:fs/promises')).readFile('/run/sandbox-secrets/browser-password','utf8')).trim();
     const session=await fetch('https://spaces-pds-e2e.${domain}/xrpc/com.atproto.server.createSession',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:'rei.spaces-pds-e2e.${domain}',password})});
     if(!session.ok)process.exit(1);const {accessJwt}=await session.json();
     const response=await fetch('https://spaces-pds-e2e.${domain}/xrpc/zone.stratos.feedgen.getFeed?feed=general&limit=50',{headers:{authorization:'Bearer '+accessJwt,'atproto-proxy':'did:web:feedgen-e2e.${domain}#stratos_feedgen'}});
     console.log(JSON.stringify({status:response.status,body:await response.json()}))`,
  ])
  return JSON.parse(
    output
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{"status":')),
  )
}

async function waitForFeedText(text, present) {
  await waitFor(async () => {
    const response = await generalFeed()
    if (response.status !== 200) return false
    const feed = response.body?.feed
    if (!Array.isArray(feed)) return false
    return feed.some((item) => item?.post?.record?.text === text) === present
  }, `${present ? 'published' : 'deleted'} staged record`)
}

const caddyPath = join(sandbox, 'state/Caddyfile')
const originalCaddy = await readFile(caddyPath, 'utf8')
const route = `spaces-pds-e2e.${domain} {\n  tls internal\n  reverse_proxy feedgen-e2e-pds-spaces:3000\n}`
assert.ok(originalCaddy.includes(route), 'Pinned PDS route changed')
const config = JSON.parse(await compose(['config', '--format', 'json']))
const image = config.services['feedgen-e2e-pds-spaces']?.image
assert.ok(typeof image === 'string' && image.length > 0)
const privateOrigins =
  config.services['feedgen-e2e-stratos']?.environment?.IDENTITY_PRIVATE_ORIGINS
assert.ok(
  typeof privateOrigins === 'string' &&
    privateOrigins.includes(`https://motoko.spaces-pds-e2e.${domain}`),
  'Pinned Stratos private identity origins changed',
)
const secondAccountOrigin = `https://rei.spaces-pds-e2e.${domain}`
const accountScript = join(sandbox, 'state/staging-limits.account.mjs')
await writeFile(
  accountScript,
  await readFile(new URL('./staging-limits.account.mjs', import.meta.url)),
  { mode: 0o444 },
)
await writeFile(
  join(sandbox, 'state/staging-limits-account.yaml'),
  `services:\n  feedgen-e2e-stratos:\n    environment:\n      IDENTITY_PRIVATE_ORIGINS: ${JSON.stringify(`${privateOrigins},${secondAccountOrigin}`)}\n  feedgen-e2e-browser:\n    volumes:\n      - ${JSON.stringify(`${accountScript}:/runner/staging-limits.account.mjs:ro`)}\n`,
  { mode: 0o600 },
)
const proxyPath = join(sandbox, 'state/staging-limits-proxy.mjs')
await writeFile(
  proxyPath,
  await readFile(new URL('./staging-limits.proxy.mjs', import.meta.url)),
  { mode: 0o600 },
)
await writeFile(
  join(sandbox, 'state/staging-limits-proxy.yaml'),
  `services:\n  staging-limits-proxy:\n    image: ${JSON.stringify(image)}\n    entrypoint: ["node", "--input-type=module", "-e", "import { createProxyServer } from '/proxy.mjs'; createProxyServer().listen(3000, '0.0.0.0')"]\n    networks: [atmosinabox]\n    volumes:\n      - ${JSON.stringify(`${proxyPath}:/proxy.mjs:ro`)}\n`,
  { mode: 0o600 },
)

let proxyStarted = false
let gatewayChanged = false
let limitsChanged = false
let accountConfigChanged = false
try {
  accountConfigChanged = true
  await withAccount([
    'up',
    '-d',
    '--wait',
    '--no-deps',
    '--force-recreate',
    'feedgen-e2e-stratos',
  ])
  const added = await withAccount([
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'node',
    'feedgen-e2e-browser',
    '/runner/staging-limits.account.mjs',
  ])
  assert.match(
    added,
    /"did":"did:/,
    'Second spaces-PDS target was not provisioned',
  )
  await withProxy(['up', '-d', 'staging-limits-proxy'])
  proxyStarted = true
  await writeFile(
    caddyPath,
    originalCaddy.replace(
      route,
      route.replace('feedgen-e2e-pds-spaces:3000', 'staging-limits-proxy:3000'),
    ),
  )
  await compose(['restart', 'gateway'])
  gatewayChanged = true

  await writeFile(
    join(sandbox, 'state/staging-limits-config.yaml'),
    'services:\n  feedgen-e2e-rust:\n    environment:\n      FEEDGEN_PROJECTION_MAX_BYTES: "131072"\n      FEEDGEN_PROJECTION_MAX_AGE_MS: "86400000"\n',
    { mode: 0o600 },
  )
  await withLimits([
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    'feedgen-e2e-rust',
  ])
  limitsChanged = true
  await control('mode?value=replacement')
  await waitForFeedText('staged replacement', true)
  const replacementFeed = await generalFeed()
  assert.equal(replacementFeed.status, 200)
  assert.ok(
    replacementFeed.body.feed.some(
      (item) => item?.post?.record?.text === 'staged replacement',
    ) &&
      replacementFeed.body.feed.every(
        (item) => item?.post?.record?.text !== 'replacement staged record',
      ),
    'Same-path replacement did not publish only its final value',
  )
  assertions.push('same-path-replacement-and-delete-accounting')

  await control('mode?value=delete')
  await waitForFeedText('delete staged record', false)
  assertions.push('promotion-replaces-staged-accounting')

  await writeFile(
    join(sandbox, 'state/staging-limits-config.yaml'),
    'services:\n  feedgen-e2e-rust:\n    environment:\n      FEEDGEN_PROJECTION_MAX_BYTES: "131072"\n      FEEDGEN_PROJECTION_MAX_AGE_MS: "86400000"\n      FEEDGEN_STAGE_TARGET_MAX_BYTES: "3500"\n',
    { mode: 0o600 },
  )
  await withLimits(['up', '-d', '--no-deps', '--force-recreate', 'feedgen-e2e-rust'])
  await control('mode?value=rollback')
  await waitFor(
    async () =>
      (await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).includes(
        'event=space_stage_limit rejected_targets=1',
      ),
    'rejected staged-page rollback',
  )
  await waitForFeedText('rollback staged record', false)
  assertions.push('rejected-page-transaction-rollback')

  await writeFile(
    join(sandbox, 'state/staging-limits-config.yaml'),
    'services:\n  feedgen-e2e-rust:\n    environment:\n      FEEDGEN_PROJECTION_MAX_BYTES: "131072"\n      FEEDGEN_PROJECTION_MAX_AGE_MS: "86400000"\n',
    { mode: 0o600 },
  )
  await withLimits(['up', '-d', '--no-deps', '--force-recreate', 'feedgen-e2e-rust'])
  await control('mode?value=replacement')
  await waitForFeedText('staged replacement', true)
  assert.equal((await generalFeed()).status, 200)
  assertions.push('unrelated-target-remains-available')

  await control('mode?value=limit')
  await waitFor(
    async () => (await control('status')).interruptions >= 2,
    'separate interrupted sync passes',
  )
  await waitFor(
    async () =>
      (await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).includes(
        'event=space_stage_budget_rejected',
      ),
    'persistent staging rejection',
  )
  const progress = await control('status')
  assert.ok(progress.pages >= 3 && progress.interruptions >= 2)
  assertions.push('cumulative-pass-budget')

  const logs = await compose(['logs', '--no-color', 'feedgen-e2e-rust'])
  const accounting = logs.match(
    /event=space_stage_budget_rejected target_rows=(\d+) target_bytes=(\d+) global_rows=(\d+) global_bytes=(\d+)/,
  )
  assert.ok(accounting)
  assert.ok(Number(accounting[2]) > 32_768)
  assert.match(
    logs,
    /event=space_stage_budget_rejected[^\n]*reason=target_bytes/,
  )
  assertions.push('storage-accounting')
  const response = await health()
  assert.ok([200, 503].includes(response.status) && response.elapsed < 2_000)
  assertions.push('service-responsive')

  await control('mode?value=interrupted')
  const before = (await control('status')).pages
  await waitFor(
    async () => (await control('status')).pages > before,
    'fresh interrupted stage',
  )
  assertions.push('interrupted-stage')
  await control('mode?value=observe')
  await writeFile(
    join(sandbox, 'state/staging-limits-config.yaml'),
    'services:\n  feedgen-e2e-rust:\n    environment:\n      FEEDGEN_PROJECTION_MAX_BYTES: "131072"\n      FEEDGEN_PROJECTION_MAX_AGE_MS: "1000"\n',
    { mode: 0o600 },
  )
  await delay(2_000)
  const firstBefore = (await control('status')).firstRequests
  await withLimits([
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    'feedgen-e2e-rust',
  ])
  await waitFor(
    async () =>
      (await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).includes(
        'event=space_stage_cleanup expired_targets=',
      ),
    'expired stage cleanup',
  )
  await waitFor(
    async () => (await control('status')).firstRequests > firstBefore,
    'restart without staged cursor',
  )
  assertions.push('expired-stage-restart')

  await writeFile(
    join(sandbox, 'state/staging-limits-config.yaml'),
    'services:\n  feedgen-e2e-rust:\n    environment:\n      FEEDGEN_PROJECTION_MAX_BYTES: "131072"\n      FEEDGEN_PROJECTION_MAX_AGE_MS: "86400000"\n      FEEDGEN_STAGE_TARGET_MAX_BYTES: "35000"\n      FEEDGEN_STAGE_GLOBAL_MAX_BYTES: "40000"\n',
    { mode: 0o600 },
  )
  await withLimits([
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    'feedgen-e2e-rust',
  ])
  await control('mode?value=global')
  await waitFor(
    async () => (await control('status')).globalTargetCount >= 2,
    'multiple authority-listed targets',
  )
  await waitFor(
    async () =>
      [
        ...(await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).matchAll(
          /event=space_stage_budget_rejected target_rows=(\d+) target_bytes=(\d+) global_rows=(\d+) global_bytes=(\d+) reason=global_bytes/g,
        ),
      ].some(
        (match) =>
          Number(match[3]) > Number(match[1]) &&
          Number(match[4]) > Number(match[2]),
      ),
    'global staged-byte rejection across targets',
  )
  const globalLogs = await compose(['logs', '--no-color', 'feedgen-e2e-rust'])
  const global = [
    ...globalLogs.matchAll(
      /event=space_stage_budget_rejected target_rows=(\d+) target_bytes=(\d+) global_rows=(\d+) global_bytes=(\d+) reason=global_bytes/g,
    ),
  ].find(
    (match) =>
      Number(match[3]) > Number(match[1]) &&
      Number(match[4]) > Number(match[2]),
  )
  assert.ok(global)
  assert.ok(Number(global[2]) < 35_000 && Number(global[4]) > 40_000)
  assert.ok(
    Number(global[3]) > Number(global[1]) &&
      Number(global[4]) > Number(global[2]),
    'Global rejection did not include another staged target',
  )
  assertions.push('multi-target-global-budget')

  console.log(
    JSON.stringify({
      suite: 'staging-limits',
      assertions: assertions.map((id) => ({ id, status: 'passed' })),
    }),
  )
} finally {
  if (gatewayChanged) {
    await writeFile(caddyPath, originalCaddy)
    await compose(['restart', 'gateway'])
  }
  if (limitsChanged) {
    await compose([
      'up',
      '-d',
      '--no-deps',
      '--force-recreate',
      'feedgen-e2e-rust',
    ])
  }
  if (proxyStarted) {
    await withProxy(['stop', 'staging-limits-proxy'])
    await withProxy(['rm', '-f', 'staging-limits-proxy'])
  }
  if (accountConfigChanged) {
    await compose([
      'up',
      '-d',
      '--no-deps',
      '--force-recreate',
      'feedgen-e2e-stratos',
    ])
  }
}
