import { info } from './log.ts'
import { DOMAINS, SERVICE_DID, STRATOS_URL, TEST_ROOT } from './config.ts'

const WORKSPACE_ROOT = `${TEST_ROOT}/..`
const TARGET_DIR = `${WORKSPACE_ROOT}/target`
const EXECUTABLE_SUFFIX = Deno.build.os === 'windows' ? '.exe' : ''

export const FEEDGEN_DID = 'did:web:feedgen.test'
export const FEEDGEN_SIGNING_KEY =
  '097ce261481a889a756db476dceb6cc57596541c264675e9712c7252cfd1183c'
const FEEDGEN_PUBLIC_KEY_MULTIBASE =
  'zQ3shkb9BGsQPkg2fEWwwBbLiDuzryE1Rc1Sqka9dopGAuA5Z'
const FEEDS = [
  { id: 'swordsmith', boundary: DOMAINS.swordsmith },
  { id: 'aekea', boundary: DOMAINS.aekea },
]

export async function buildFeedgen(): Promise<boolean> {
  info('Building stratos-feedgen-ng')
  const result = await new Deno.Command('cargo', {
    args: [
      'build',
      '--locked',
      '--package',
      'stratos-feedgen-ng',
      '--target-dir',
      TARGET_DIR,
    ],
    cwd: WORKSPACE_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output()
  return result.success
}

export class FeedgenHarness {
  private child: Deno.ChildProcess | undefined

  constructor(private readonly port: number) {}

  start(): void {
    this.child = new Deno.Command(
      `${TARGET_DIR}/debug/stratos-feedgen-ng${EXECUTABLE_SUFFIX}`,
      {
        clearEnv: true,
        stdin: 'null',
        stdout: 'inherit',
        stderr: 'inherit',
        env: {
          FEEDGEN_SERVICE_DID: FEEDGEN_DID,
          FEEDGEN_SIGNING_KEY,
          FEEDGEN_PUBLIC_KEY_MULTIBASE,
          FEEDGEN_PUBLIC_URL: `http://127.0.0.1:${this.port}`,
          FEEDGEN_PORT: String(this.port),
          FEEDGEN_FEEDS_JSON: JSON.stringify({ feeds: FEEDS }),
          FEEDGEN_STORAGE_PROFILE: 'ephemeral',
          STRATOS_SERVICE_URL: STRATOS_URL,
          STRATOS_PUBLIC_URL: STRATOS_URL,
          STRATOS_SERVICE_DID: SERVICE_DID,
          PLC_DIRECTORY:
            Deno.env.get('PLC_DIRECTORY') || 'https://plc.directory',
        },
      },
    ).spawn()
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      child.kill('SIGTERM')
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    } finally {
      await child.status
      this.child = undefined
    }
  }

  async waitForHealth(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const url = `http://127.0.0.1:${this.port}/health`
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(1_000),
        })
        const body = (await response.json()) as {
          feedReady?: boolean
          serviceStreamConnected?: boolean
          pdsSpaceSyncLastPass?: {
            boundaries: number
            membershipFailures: number
          }
        }
        const membership = body.pdsSpaceSyncLastPass
        if (
          response.ok &&
          body.feedReady &&
          body.serviceStreamConnected &&
          membership?.boundaries === FEEDS.length &&
          membership.membershipFailures === 0
        ) {
          return true
        }
      } catch {
        // The process is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }
}
