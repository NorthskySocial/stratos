// The ordered phase list of the E2E run. Kept apart from run-all.ts so a test
// can read the list without starting a run.

export interface Phase {
  name: string
  script: string
  /** If true, always run (e.g. teardown) even after prior failures */
  always?: boolean
}

export interface RunOptions {
  appview: boolean
  spacesPds: boolean
}

export const SPACES_PDS_OPTION = '--spaces-pds'
/** Compose profile that holds the spaces PDS service. */
export const SPACES_PDS_PROFILE = 'spaces-pds'
const SPACES_PDS_ENV = 'STRATOS_E2E_SPACES_PDS'

export function parseRunOptions(args: readonly string[]): RunOptions {
  return {
    appview: args.includes('--appview'),
    spacesPds: args.includes(SPACES_PDS_OPTION),
  }
}

/** run-all.ts exports the option so each phase process sees the same choice. */
export function exportSpacesPdsChoice(options: RunOptions): void {
  if (options.spacesPds) Deno.env.set(SPACES_PDS_ENV, 'true')
}

export function spacesPdsRequested(): boolean {
  return Deno.env.get(SPACES_PDS_ENV) === 'true'
}

export function phasesFor(options: RunOptions): Phase[] {
  return [
    {
      name: 'Cloudflare Tunnel',
      script: 'cloudflare-tunnel-setup.ts',
    },
    { name: 'Setup', script: 'setup.ts' },
    { name: 'OAuth Enrollment', script: 'test-enrollment.ts' },
    { name: 'Multi-Enrollment Verify', script: 'test-multi-enrollment.ts' },
    { name: 'OAuth Login: Invalid Password', script: 'test-auth-failures.ts' },
    { name: 'Configure Boundaries', script: 'configure-boundaries.ts' },
    { name: 'Post CRUD & Boundaries', script: 'test-posts.ts' },
    { name: 'DPoP CRUD (production auth)', script: 'test-dpop-crud.ts' },
    { name: 'Blobs: Upload & Access', script: 'test-blobs.ts' },
    { name: 'Spaces: Credentials & Sync', script: 'test-spaces.ts' },
    { name: 'Sync Stream: subscribeRecords', script: 'test-sync-stream.ts' },
    { name: 'Feedgen: describeFeed & getFeed', script: 'test-feedgen.ts' },
    ...(options.appview
      ? [{ name: 'AppView Service-Auth Feed', script: 'test-appview-feed.ts' }]
      : []),
    ...(options.spacesPds
      ? [
          {
            name: 'Mixed Mode: Spaces PDS Custody',
            script: 'test-mixed-mode.ts',
          },
        ]
      : []),
    { name: 'Admin API: Boundary Management', script: 'test-admin-api.ts' },
    { name: 'Admin UI: SPA Smoke Tests', script: 'test-admin-ui.ts' },
    { name: 'Unenrollment', script: 'test-unenrollment.ts' },
    { name: 'Teardown', script: 'teardown.ts', always: true },
  ]
}
