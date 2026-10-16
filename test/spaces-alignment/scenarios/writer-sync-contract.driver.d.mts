export interface Commit {
  rev: string
  hash: { $bytes: string }
  repoRev?: string
}
export interface WriterRow {
  did: string
  repoRev: string
  hash: { $bytes: string }
  spaceRev: string
  rev?: string
}
export interface Page {
  repos: WriterRow[]
  cursor?: string
  spaceRev?: string
}
export interface NotifyBody {
  space: string
  repo: string
  repoRev: string
  hash: { $bytes: string }
}
export interface NotifyOptions {
  audience?: 'authority-host' | 'authority' | 'writer'
  issuer?: 'writer' | 'other-writer'
}
export interface ContractApi {
  space: string
  writer: string
  otherWriter: string
  write(text: string): Promise<Commit>
  list(cursor?: string): Promise<Page>
  notify(body: NotifyBody, options?: NotifyOptions): Promise<Response>
  removeWriter(): Promise<void>
  unsupported(): Promise<Response[]>
}
export const requiredAssertions: string[]
export function checked(
  response: Response,
  status?: number,
  error?: string,
): Promise<unknown>
export function assertPage(page: unknown): void
export function futureRevision(now: number): string
export function verifyContract(
  api: ContractApi,
): Promise<{ suite: string; assertions: { id: string; status: 'passed' }[] }>
export interface RuntimeDependencies {
  domain?: string
  open?: () => Promise<{ close(): Promise<void> }>
  prepare?: (
    browser: unknown,
    name: string,
  ) => Promise<{ account: { did: string; accessJwt: string } }>
  keyFor?: () => unknown
  headersFor?: (
    authorization: string,
    key: unknown,
    audience?: string,
  ) => Record<string, string>
  request?: typeof fetch
}
export function runScenario(
  dependencies?: RuntimeDependencies,
): Promise<unknown>

export function main(
  argv?: string[],
  run?: () => Promise<unknown>,
): Promise<void>
