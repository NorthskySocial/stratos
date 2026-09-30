import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

async function command(args, timeout = 180_000) {
  const result = await execute('docker', args, {
    cwd: sandbox,
    timeout,
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
     if(!session.ok)throw new Error('Feed viewer session failed ('+session.status+'): '+await session.text());const {accessJwt}=await session.json();
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

async function feedContainsText(text) {
  const response = await generalFeed()
  if (response.status !== 200 || !Array.isArray(response.body?.feed))
    return null
  return response.body.feed.some((item) => item?.post?.record?.text === text)
}

async function waitForPublishedText(text) {
  await waitFor(
    async () => (await feedContainsText(text)) === true,
    'published staged record',
  )
}

async function waitForDeletedText(text) {
  await waitFor(
    async () => (await feedContainsText(text)) === false,
    'deleted staged record',
  )
}

async function configureLimits(overrides = {}) {
  const environment = {
    FEEDGEN_PROJECTION_MAX_BYTES: 131_072,
    FEEDGEN_PROJECTION_MAX_AGE_MS: 86_400_000,
    ...overrides,
  }
  await writeFile(
    join(sandbox, 'state/staging-limits-config.yaml'),
    `services:\n  feedgen-e2e-rust:\n    environment:\n${Object.entries(
      environment,
    )
      .map(
        ([name, value]) => `      ${name}: ${JSON.stringify(String(value))}\n`,
      )
      .join('')}`,
    { mode: 0o600 },
  )
  limitsChanged = true
  await withLimits([
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    'feedgen-e2e-rust',
  ])
}

const caddyPath = join(sandbox, 'state/Caddyfile')
const originalCaddy = await readFile(caddyPath, 'utf8')
const route = `spaces-pds-e2e.${domain} {\n  tls internal\n  reverse_proxy feedgen-e2e-pds-spaces:3000\n}`
assert.ok(originalCaddy.includes(route), 'Pinned PDS route changed')
const config = JSON.parse(await compose(['config', '--format', 'json']))
const image = config.services['feedgen-e2e-pds-spaces']?.image
assert.ok(typeof image === 'string' && image.length > 0)
// Reuse the locked feedgen build, including its bundled SQLCipher, for a
// read-only inspector. The inspector never emits keys or record contents.
const inspectorDirectory = join(sandbox, 'state/staging-limits-inspector')
await mkdir(inspectorDirectory, { recursive: true, mode: 0o700 })
const rustBuild = config.services['feedgen-e2e-rust']?.build
assert.ok(typeof rustBuild?.context === 'string')
const sourceDirectory = resolve(sandbox, rustBuild.context)
const inspectorImage = `${project}-staging-limits-inspector`
const inspectorSource = String.raw`
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let key = std::fs::read_to_string(&args[2])?;
    let key = key.trim();
    assert!(key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()));
    let db = Connection::open_with_flags(&args[1], OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(std::time::Duration::from_secs(2))?;
    db.execute_batch(&format!("PRAGMA key = \"x'{}'\"; PRAGMA query_only = ON; BEGIN;", key))?;
    let scalar = |sql: &str| -> rusqlite::Result<i64> { db.query_row(sql, [], |row| row.get(0)) };
    let mut stages = Vec::new();
    for (table, expression) in [
        ("space_sync_stage", "length(space_uri)+length(did)+length(uri)+length(boundary)+COALESCE(length(cid),0)+COALESCE(length(sort_at),0)+COALESCE(length(indexed_at),0)+COALESCE(length(record_json),0)+COALESCE(length(blob_refs_json),0)+length(updated_at)"),
        ("space_sync_stage_cursor", "length(space_uri)+length(did)+length(boundary)+length(CAST(cursor AS BLOB))+length(updated_at)"),
        ("space_sync_pending_verification", "length(space_uri)+length(did)+length(boundary)+length(updated_at)"),
        ("space_sync_stage_lifetime", "length(space_uri)+length(did)+length(boundary)+length(created_at)+length(last_progress_at)"),
    ] {
        let mut query = db.prepare(&format!("SELECT space_uri,did,COUNT(*),SUM({expression}) FROM {table} GROUP BY space_uri,did"))?;
        for row in query.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,i64>(3)?)))? {
            let (space,did,rows,bytes) = row?;
            stages.push(json!({"space":space,"did":did,"table":table,"rows":rows,"bytes":bytes}));
        }
    }
    let mut synthetic = Vec::new();
    for rkey in ["replacement","deleted","rolled-back"] {
        let suffix = format!("%/{rkey}");
        let staged: i64 = db.query_row("SELECT COUNT(*) FROM space_sync_stage WHERE uri LIKE ?1", [&suffix], |row| row.get(0))?;
        let published: i64 = db.query_row("SELECT COUNT(*) FROM post WHERE uri LIKE ?1", [&suffix], |row| row.get(0))?;
        let bytes: i64 = db.query_row("SELECT COALESCE(SUM(projection_bytes),0) FROM post WHERE uri LIKE ?1", [&suffix], |row| row.get(0))?;
        synthetic.push(json!({"rkey":rkey,"staged":staged,"published":published,"bytes":bytes}));
    }
    let published = scalar("SELECT COALESCE(SUM(projection_bytes),0) FROM post")?;
    let measured = scalar("SELECT COALESCE(SUM(length(uri)+length(author_did)+length(cid)+length(sort_at)+length(indexed_at)+length(record_json)+length(blob_refs_json)),0) FROM post")?;
    let rolled_back = scalar("SELECT COUNT(*) FROM space_sync_stage WHERE uri LIKE '%/rolled-back-%'")?;
    let mut limits = serde_json::Map::new();
    let mut query = db.prepare("SELECT key,value FROM retention_metadata")?;
    for row in query.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?)))? {
        let (key,value) = row?;
        limits.insert(key, json!(value));
    }
    println!("{}",json!({"stages":stages,"publishedBytes":published,"publishedMeasuredBytes":measured,"synthetic":synthetic,"rolledBackRows":rolled_back,"limits":limits}));
    db.execute_batch("ROLLBACK;")?;
    Ok(())
}
`
await writeFile(join(inspectorDirectory, 'inspector.rs'), inspectorSource)
const feedgenDockerfile = await readFile(
  join(sourceDirectory, 'stratos-feedgen-ng/Dockerfile'),
  'utf8',
)
const inspectorDockerfile = feedgenDockerfile
  .replace(
    'FROM debian:bookworm-slim',
    `COPY --from=inspector-source inspector.rs /tmp/inspector.rs
RUN rustc --edition=2024 /tmp/inspector.rs -L dependency=/workspace/target/release/deps \\
    --extern rusqlite=$(find /workspace/target/release/deps -name 'librusqlite-*.rlib' | head -1) \\
    --extern serde_json=$(find /workspace/target/release/deps -name 'libserde_json-*.rlib' | head -1) \\
    -o /workspace/staging-limits-inspector

FROM debian:bookworm-slim`,
  )
  .replace(
    'COPY --from=builder /workspace/target/release/stratos-feedgen-ng /usr/local/bin/stratos-feedgen-ng',
    'COPY --from=builder /workspace/staging-limits-inspector /usr/local/bin/staging-limits-inspector',
  )
  .replaceAll(
    '/usr/local/bin/stratos-feedgen-ng',
    '/usr/local/bin/staging-limits-inspector',
  )
await writeFile(join(inspectorDirectory, 'Dockerfile'), inspectorDockerfile)

async function storageUsage() {
  const container = (await compose(['ps', '-q', 'feedgen-e2e-rust'])).trim()
  assert.ok(container)
  const output = await command([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--volumes-from',
    `${container}:ro`,
    inspectorImage,
    '/var/lib/feedgen/projection.sqlite',
    '/run/sandbox-secrets/feedgen-storage-key',
  ])
  const usage = JSON.parse(output.trim())
  usage.stageRows = usage.stages.reduce((sum, row) => sum + row.rows, 0)
  usage.stageBytes = usage.stages.reduce((sum, row) => sum + row.bytes, 0)
  assert.equal(
    usage.publishedBytes,
    usage.publishedMeasuredBytes,
    'Persisted published accounting differs from stored record sizes',
  )
  assert.ok(
    usage.stageBytes + usage.publishedBytes <=
      usage.limits.projection_max_bytes,
    'Persisted staged and published usage exceeds the aggregate projection cap',
  )
  assert.ok(usage.stageRows <= usage.limits.stage_global_max_rows)
  assert.ok(usage.stageBytes <= usage.limits.stage_global_max_bytes)
  const targets = new Map()
  for (const row of usage.stages) {
    const target = `${row.space}/${row.did}`
    const total = targets.get(target) ?? { rows: 0, bytes: 0 }
    total.rows += row.rows
    total.bytes += row.bytes
    targets.set(target, total)
  }
  for (const total of targets.values()) {
    assert.ok(total.rows <= usage.limits.stage_target_max_rows)
    assert.ok(total.bytes <= usage.limits.stage_target_max_bytes)
  }
  return usage
}

const syntheticUsage = (usage, rkey) =>
  usage.synthetic.find((row) => row.rkey === rkey)

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
const proxyRunner = `import { createProxyServer } from '/proxy.mjs';
const server = createProxyServer();
const handler = server.listeners('request')[0];
server.removeAllListeners('request');
let gate = 'open';
let pending = [];
let mode = 'observe';
let pageCounts = new Map();
server.on('request', async (req, res) => {
  const url = new URL(req.url, 'http://proxy');
  if (url.pathname === '/_control/hold-terminal' || url.pathname === '/_control/release-terminal' || url.pathname === '/_control/open' || url.pathname === '/_control/freeze') {
    gate = url.pathname.endsWith('hold-terminal') ? 'terminal' : url.pathname.endsWith('release-terminal') ? 'first' : url.pathname.endsWith('freeze') ? 'all' : 'open';
    const waiting = pending; pending = [];
    for (const resume of waiting) resume();
    res.end('ok'); return;
  }
  if (url.pathname === '/_control/mode') {
    mode = url.searchParams.get('value') || 'observe';
    pageCounts.clear();
    gate = url.searchParams.get('gate') === 'terminal' ? 'terminal' : 'open';
    await handler(req, res);
    const waiting = pending;
    pending = [];
    for (const resume of waiting) resume();
    return;
  }
  if (url.pathname === '/xrpc/com.atproto.space.listRepoOps') {
    const repo = url.searchParams.get('repo') || '';
    while (true) {
      const page = pageCounts.get(repo) || 0;
      const terminal = ['replacement', 'delete', 'rollback'].includes(mode) && page % 2 === 1;
      const held = gate === 'all' || (gate === 'terminal' && terminal) || (gate === 'first' && !terminal);
      if (!held) {
        pageCounts.set(repo, page + 1);
        break;
      }
      await new Promise(resolve => pending.push(resolve));
      if (res.destroyed) return;
    }
  }
  await handler(req, res);
});
server.listen(3000, '0.0.0.0');`
await writeFile(
  join(sandbox, 'state/staging-limits-proxy.yaml'),
  `services:\n  staging-limits-proxy:\n    image: ${JSON.stringify(image)}\n    entrypoint: ["node", "--input-type=module", "-e", ${JSON.stringify(proxyRunner)}]\n    networks: [atmosinabox]\n    volumes:\n      - ${JSON.stringify(`${proxyPath}:/proxy.mjs:ro`)}\n`,
  { mode: 0o600 },
)

let inspectorBuilt = false
let proxyStarted = false
let gatewayChanged = false
let limitsChanged = false
let accountConfigChanged = false
try {
  await command(
    [
      'build',
      '--tag',
      inspectorImage,
      '--file',
      join(inspectorDirectory, 'Dockerfile'),
      '--build-context',
      `inspector-source=${inspectorDirectory}`,
      sourceDirectory,
    ],
    600_000,
  )
  inspectorBuilt = true
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

  await configureLimits()
  await waitFor(
    async () => (await control('status')).targetCount >= 2,
    'both authority-listed spaces-PDS targets',
  )
  await control('release-terminal')
  await waitFor(
    async () => (await storageUsage()).stageRows === 0,
    'baseline stage promotion before accounting snapshot',
  )
  const beforeReplacement = await storageUsage()
  assert.equal(
    beforeReplacement.stageRows,
    0,
    'Baseline has an unfinished stage',
  )
  await control('mode?value=replacement&gate=terminal')
  await waitFor(
    async () =>
      syntheticUsage(await storageUsage(), 'replacement').staged ===
      (await control('status')).targetCount,
    'persisted first replacement page',
  )
  const stagedReplacement = await storageUsage()
  const replacementTargets = syntheticUsage(
    stagedReplacement,
    'replacement',
  ).staged
  assert.equal(
    stagedReplacement.stageRows,
    replacementTargets * 3,
    'First replacement page did not account for record, cursor, and lifetime',
  )
  assert.equal(
    stagedReplacement.publishedBytes,
    beforeReplacement.publishedBytes,
    'Unverified replacement changed published storage',
  )
  await control('release-terminal')
  await waitForPublishedText('staged replacement')
  await waitFor(
    async () => (await storageUsage()).stageRows === 0,
    'replacement promotion releases every staging table',
  )
  const replacementUsage = await storageUsage()
  const replacement = syntheticUsage(replacementUsage, 'replacement')
  assert.equal(
    replacement.published,
    replacementTargets,
    'Same-path replacement added another published row',
  )
  assert.equal(
    replacementUsage.publishedBytes - beforeReplacement.publishedBytes,
    replacement.bytes - syntheticUsage(beforeReplacement, 'replacement').bytes,
    'Promotion retained staged bytes in aggregate published storage',
  )
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

  await control('mode?value=delete&gate=terminal')
  await waitFor(
    async () =>
      syntheticUsage(await storageUsage(), 'deleted').staged ===
      (await control('status')).targetCount,
    'persisted first delete page',
  )
  const stagedDelete = await storageUsage()
  const deleteTargets = syntheticUsage(stagedDelete, 'deleted').staged
  assert.equal(
    stagedDelete.stageRows,
    deleteTargets * 3,
    'First delete page did not account for record, cursor, and lifetime',
  )
  assert.equal(stagedDelete.publishedBytes, replacementUsage.publishedBytes)
  await control('release-terminal')
  await waitForDeletedText('delete staged record')
  await waitFor(
    async () => (await storageUsage()).stageRows === 0,
    'delete promotion releases every staging table',
  )
  const deleteUsage = await storageUsage()
  assert.equal(syntheticUsage(deleteUsage, 'deleted').published, 0)
  assert.equal(
    deleteUsage.publishedBytes,
    replacementUsage.publishedBytes,
    'Deleted staged record left persisted bytes after promotion',
  )
  assertions.push('same-path-replacement-and-delete-accounting')
  assertions.push('promotion-replaces-staged-accounting')

  await configureLimits({
    FEEDGEN_STAGE_TARGET_MAX_BYTES: 3_500,
  })
  await control('mode?value=rollback&gate=terminal')
  await waitFor(
    async () =>
      syntheticUsage(await storageUsage(), 'rolled-back').staged ===
      (await control('status')).targetCount,
    'persisted page before rollback',
  )
  const beforeRollback = await storageUsage()
  await control('release-terminal')
  await waitFor(
    async () =>
      [
        ...(await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).matchAll(
          /event=space_stage_limit rejected_targets=1/g,
        ),
      ].length >= syntheticUsage(beforeRollback, 'rolled-back').staged,
    'rejected staged-page rollback for every target',
  )
  await control('freeze')
  await waitForDeletedText('rollback staged record')
  await waitFor(
    async () => (await storageUsage()).stageRows === 0,
    'rejected targets discard their persisted first page',
  )
  const rollbackUsage = await storageUsage()
  assert.equal(
    rollbackUsage.rolledBackRows,
    0,
    'Rejected page persisted one of its new record rows',
  )
  assert.equal(
    rollbackUsage.stageRows,
    0,
    'Rejected targets retained persisted stage rows',
  )
  assert.equal(
    rollbackUsage.stageBytes,
    0,
    'Rejected targets retained persisted stage bytes',
  )
  assert.equal(rollbackUsage.publishedBytes, beforeRollback.publishedBytes)
  assertions.push('rejected-page-transaction-rollback')
  assertions.push('persisted-storage-accounting')

  await control('mode?value=replacement')
  await control('open')
  await configureLimits()
  await waitForPublishedText('staged replacement')
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
  await storageUsage()
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
  const interruptedRequests = (await control('status')).requests
  const verifiedRequest = interruptedRequests.find((request) => request.repo)
  assert.ok(verifiedRequest, 'Interrupted sync did not request a PDS page')
  assertions.push('interrupted-stage')
  await control('mode?value=observe')
  await delay(2_000)
  await configureLimits({ FEEDGEN_PROJECTION_MAX_AGE_MS: 1_000 })
  await waitFor(
    async () =>
      (await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).includes(
        'event=space_stage_cleanup expired_targets=',
      ),
    'expired stage cleanup',
  )
  const requestsAfterCleanup = (await control('status')).requests.length
  await configureLimits({ FEEDGEN_PROJECTION_MAX_AGE_MS: 1_000 })
  await waitFor(
    async () =>
      (await control('status')).requests
        .slice(requestsAfterCleanup)
        .some((request) => request.repo === verifiedRequest.repo),
    'restart without staged cursor',
  )
  const resumedRequest = (await control('status')).requests
    .slice(requestsAfterCleanup)
    .find((request) => request.repo === verifiedRequest.repo)
  assert.equal(
    resumedRequest?.cursor,
    verifiedRequest.cursor,
    'Expired staging resumed from an unverified staged cursor',
  )
  assertions.push('expired-stage-restart')

  await configureLimits({
    FEEDGEN_STAGE_TARGET_MAX_BYTES: 35_000,
    FEEDGEN_STAGE_GLOBAL_MAX_BYTES: 40_000,
  })
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
  await storageUsage()

  // Existing stages are synthetic. Expire them before each independent row cap
  // so another limit cannot mask the intended rejection reason.
  async function clearStage() {
    await control('mode?value=observe')
    await control('freeze')
    await delay(2_000)
    await configureLimits({ FEEDGEN_PROJECTION_MAX_AGE_MS: 1_000 })
    await waitFor(
      async () => (await storageUsage()).stageRows === 0,
      'synthetic stage cleanup before row cap',
    )
  }

  await clearStage()
  await configureLimits({
    FEEDGEN_PROJECTION_MAX_BYTES: 1_048_576,
    FEEDGEN_STAGE_TARGET_MAX_BYTES: 262_144,
    FEEDGEN_STAGE_GLOBAL_MAX_BYTES: 524_288,
    FEEDGEN_STAGE_TARGET_MAX_ROWS: 15,
    FEEDGEN_STAGE_GLOBAL_MAX_ROWS: 100,
  })
  await control('mode?value=limit')
  await control('open')
  await waitFor(
    async () =>
      (await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).includes(
        'reason=target_rows',
      ),
    'target staged-row rejection with spare byte capacity',
  )
  await control('freeze')
  const targetRowUsage = await storageUsage()
  assert.ok(targetRowUsage.stageBytes < 262_144)
  const targetRowLogs = await compose([
    'logs',
    '--no-color',
    'feedgen-e2e-rust',
  ])
  const targetRows = targetRowLogs.match(
    /event=space_stage_budget_rejected target_rows=(\d+) target_bytes=(\d+) global_rows=(\d+) global_bytes=(\d+) reason=target_rows/,
  )
  assert.ok(targetRows)
  assert.ok(Number(targetRows[1]) > 15 && Number(targetRows[2]) < 262_144)
  assert.ok(Number(targetRows[3]) <= 100 && Number(targetRows[4]) < 524_288)
  assertions.push('target-row-budget')

  await clearStage()
  await configureLimits({
    FEEDGEN_PROJECTION_MAX_BYTES: 1_048_576,
    FEEDGEN_STAGE_TARGET_MAX_BYTES: 262_144,
    FEEDGEN_STAGE_GLOBAL_MAX_BYTES: 524_288,
    FEEDGEN_STAGE_TARGET_MAX_ROWS: 25,
    FEEDGEN_STAGE_GLOBAL_MAX_ROWS: 30,
  })
  await control('mode?value=global')
  await control('open')
  await waitFor(
    async () =>
      [
        ...(await compose(['logs', '--no-color', 'feedgen-e2e-rust'])).matchAll(
          /event=space_stage_budget_rejected target_rows=(\d+) target_bytes=(\d+) global_rows=(\d+) global_bytes=(\d+) reason=global_rows/g,
        ),
      ].some((row) => Number(row[3]) > Number(row[1])),
    'global staged-row rejection across separate targets',
  )
  await control('freeze')
  const globalRowUsage = await storageUsage()
  assert.ok(globalRowUsage.stageRows <= 30)
  assert.ok(globalRowUsage.stageBytes < 524_288)
  const globalRowLogs = await compose([
    'logs',
    '--no-color',
    'feedgen-e2e-rust',
  ])
  const globalRows = [
    ...globalRowLogs.matchAll(
      /event=space_stage_budget_rejected target_rows=(\d+) target_bytes=(\d+) global_rows=(\d+) global_bytes=(\d+) reason=global_rows/g,
    ),
  ].find((row) => Number(row[3]) > Number(row[1]))
  assert.ok(globalRows)
  assert.ok(Number(globalRows[1]) <= 25 && Number(globalRows[3]) > 30)
  assert.ok(Number(globalRows[2]) < 262_144 && Number(globalRows[4]) < 524_288)
  assertions.push('global-row-budget')

  console.log(
    JSON.stringify({
      suite: 'staging-limits',
      assertions: assertions.map((id) => ({ id, status: 'passed' })),
    }),
  )
} finally {
  if (proxyStarted) await control('open').catch(() => undefined)
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
  if (inspectorBuilt) await command(['image', 'rm', inspectorImage])
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
