import { assert, info } from './log.ts'
import { DOMAINS, SERVICE_DID, STRATOS_URL, TEST_ROOT } from './config.ts'

const FEEDGEN_CWD = `${TEST_ROOT}/../stratos-feedgen`
const SQLITE_HEADER = new TextEncoder().encode('SQLite format 3\0')
const SQLITE_SIDECAR_SUFFIXES = ['-journal', '-shm', '-wal']
const MAX_LOG_LINES = 500

export const FEEDGEN_DID = 'did:web:feedgen.test'
export const FEEDGEN_SIGNING_KEY =
  '097ce261481a889a756db476dceb6cc57596541c264675e9712c7252cfd1183c'
export const SPACE_COMMIT_TAMPER_MODULE = new URL(
  './tamper-space-commit.mjs',
  import.meta.url,
).href

export interface FeedDefinition {
  id: string
  boundary: string
}

export interface FeedgenLogEvent {
  readonly line: string
  readonly fields: Readonly<Record<string, unknown>>
}

export interface FeedgenWarmupEvent {
  readonly event: FeedgenLogEvent
  readonly attempted: number
  readonly acquired: number
  readonly failed: number
}

interface CapturedFeedgenLogEvent extends FeedgenLogEvent {
  readonly startId: number
}

export interface FeedgenStartOptions {
  port: number
  feeds?: FeedDefinition[]
  env?: Record<string, string>
}

interface SqliteArtifactSnapshot {
  childTmpDir: ReadonlySet<string>
  feedgenCwd: ReadonlySet<string>
}

export class FeedgenHarness {
  readonly childTmpDir: string
  private readonly beforeArtifacts: SqliteArtifactSnapshot
  private readonly logs: CapturedFeedgenLogEvent[] = []
  private child: Deno.ChildProcess | undefined
  private drains: Promise<void>[] = []
  private startId = 0

  private constructor(
    childTmpDir: string,
    beforeArtifacts: SqliteArtifactSnapshot,
  ) {
    this.childTmpDir = childTmpDir
    this.beforeArtifacts = beforeArtifacts
  }

  static async create(): Promise<FeedgenHarness> {
    const childTmpDir = await Deno.makeTempDir({ prefix: 'feedgen-e2e-tmp-' })
    return new FeedgenHarness(
      childTmpDir,
      await snapshotSqliteArtifacts(childTmpDir),
    )
  }

  async start(options: FeedgenStartOptions): Promise<void> {
    await this.stop()
    const startId = ++this.startId
    const url = `http://127.0.0.1:${options.port}`
    const feeds = options.feeds ?? [
      { id: 'swordsmith', boundary: DOMAINS.swordsmith },
      { id: 'aekea', boundary: DOMAINS.aekea },
    ]
    const child = new Deno.Command('node', {
      args: ['dist-bundle/main.mjs'],
      cwd: FEEDGEN_CWD,
      stdout: 'piped',
      stderr: 'piped',
      env: {
        ...withoutInheritedSqlitePath(),
        FEEDGEN_SERVICE_DID: FEEDGEN_DID,
        FEEDGEN_SIGNING_KEY,
        FEEDGEN_PUBLIC_URL: url,
        FEEDGEN_PORT: String(options.port),
        FEEDGEN_FEEDS_JSON: JSON.stringify({ feeds }),
        TEMP: this.childTmpDir,
        TMP: this.childTmpDir,
        TMPDIR: this.childTmpDir,
        STRATOS_SERVICE_URL: STRATOS_URL,
        STRATOS_PUBLIC_URL: STRATOS_URL,
        STRATOS_SERVICE_DID: SERVICE_DID,
        ...options.env,
      },
    }).spawn()
    this.child = child
    this.drains = [
      drainLogs(child.stdout, (line) => this.recordLog(startId, line)),
      drainLogs(child.stderr, (line) => this.recordLog(startId, line)),
    ]
  }

  async stop(): Promise<void> {
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
      await this.child.status
    } catch {
      // The process already exited.
    } finally {
      await Promise.allSettled(this.drains)
      this.child = undefined
      this.drains = []
    }
  }

  async waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}/health`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url)
        const body = (await res.json()) as { ok?: boolean }
        if (res.ok && body.ok === true) return true
      } catch {
        // The process is still starting.
      }
      await delay(250)
    }
    return false
  }

  async waitForLog(
    predicate: (event: FeedgenLogEvent) => boolean,
    timeoutMs: number,
    occurrence = 1,
  ): Promise<FeedgenLogEvent> {
    const startId = this.startId
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const matched = this.logs.filter(
        (event) => event.startId === startId && predicate(event),
      )[occurrence - 1]
      if (matched) return matched
      await delay(100)
    }
    throw new Error(
      `feedgen log condition timed out: ${this.logs
        .slice(-20)
        .map((event) => event.line)
        .join('\n')}`,
    )
  }

  async waitForWarmup(timeoutMs: number): Promise<FeedgenWarmupEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const event = this.logs
        .slice()
        .reverse()
        .find((entry) => {
          return (
            entry.startId === this.startId &&
            entry.fields['msg'] === 'space credential warm-up completed'
          )
        })
      if (event) {
        const attempted = event.fields['attempted']
        const acquired = event.fields['acquired']
        const failed = event.fields['failed']
        if (
          typeof attempted === 'number' &&
          typeof acquired === 'number' &&
          typeof failed === 'number'
        ) {
          return { event, attempted, acquired, failed }
        }
      }
      await delay(100)
    }
    throw new Error(
      `feedgen credential warm-up timed out: ${this.logs
        .slice(-20)
        .map((event) => event.line)
        .join('\n')}`,
    )
  }

  countLogs(predicate: (event: FeedgenLogEvent) => boolean): number {
    return this.logs.filter(predicate).length
  }

  recentLogLines(limit = 20): string[] {
    return this.logs.slice(-limit).map((event) => event.line)
  }

  async cleanup(): Promise<void> {
    await this.stop()
    try {
      await assertNoNewSqliteArtifacts(this.beforeArtifacts, this.childTmpDir)
    } finally {
      await Deno.remove(this.childTmpDir, { recursive: true })
    }
  }

  private recordLog(startId: number, line: string): void {
    this.logs.push({
      line,
      fields: parseLogLine(line),
      startId,
    })
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift()
  }
}

export async function buildFeedgen(): Promise<boolean> {
  info('bundling stratos-feedgen (production esbuild bundle)')
  const result = await new Deno.Command('pnpm', {
    args: ['--filter', '@northskysocial/stratos-feedgen', 'bundle'],
    cwd: `${TEST_ROOT}/..`,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()
  return result.success
}

function withoutInheritedSqlitePath(): Record<string, string> {
  const env = Deno.env.toObject()
  delete env['FEEDGEN_SQLITE_PATH']
  return env
}

async function drainLogs(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return
  const decoder = new TextDecoder()
  let remainder = ''
  for await (const chunk of stream) {
    const lines = (remainder + decoder.decode(chunk, { stream: true })).split(
      '\n',
    )
    remainder = lines.pop() ?? ''
    for (const line of lines) {
      if (line) onLine(line)
    }
  }
  const finalLine = remainder + decoder.decode()
  if (finalLine) onLine(finalLine)
}

function parseLogLine(line: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Plain process output has no structured fields.
  }
  return {}
}

async function snapshotSqliteArtifacts(
  childTmpDir: string,
): Promise<SqliteArtifactSnapshot> {
  return {
    childTmpDir: await listSqliteArtifacts(childTmpDir),
    feedgenCwd: await listSqliteArtifacts(FEEDGEN_CWD),
  }
}

async function assertNoNewSqliteArtifacts(
  before: SqliteArtifactSnapshot,
  childTmpDir: string,
): Promise<void> {
  const after = await snapshotSqliteArtifacts(childTmpDir)
  const created = [
    ...new Set([
      ...[...after.childTmpDir].filter((path) => !before.childTmpDir.has(path)),
      ...[...after.feedgenCwd].filter((path) => !before.feedgenCwd.has(path)),
    ]),
  ]
  assert(
    created.length === 0,
    'default SQLite creates no filesystem artifacts',
    created.join(', '),
  )
}

async function listSqliteArtifacts(directory: string): Promise<Set<string>> {
  const artifacts = new Set<string>()
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue
    const path = `${directory}/${entry.name}`
    if (await isSqliteArtifact(path)) artifacts.add(path)
  }
  return artifacts
}

async function isSqliteArtifact(path: string): Promise<boolean> {
  if (SQLITE_SIDECAR_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return true
  }
  const file = await Deno.open(path)
  try {
    const header = new Uint8Array(SQLITE_HEADER.length)
    const size = await file.read(header)
    return (
      size === SQLITE_HEADER.length &&
      header.every((byte, index) => byte === SQLITE_HEADER[index])
    )
  } finally {
    file.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
