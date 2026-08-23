// Backend selection for the E2E suite. The run-all.ts orchestrator sets the
// environment variables that these switches read.

export type Backend = 'sqlite' | 'postgres'

export function getBackend(): Backend {
  const backend = Deno.env.get('STRATOS_E2E_BACKEND')
  if (backend === 'postgres') return 'postgres'
  return 'sqlite'
}

export function isPostgres(): boolean {
  return getBackend() === 'postgres'
}

/**
 * AppView E2E mode: brings up the Stratos + AppView stack (docker-compose.e2e.yml)
 * so the service-auth subscription path can be exercised end-to-end. Implies the
 * postgres backend, since the AppView indexes from the shared Postgres instance.
 */
export function isAppview(): boolean {
  return Deno.env.get('STRATOS_E2E_APPVIEW') === 'true'
}
