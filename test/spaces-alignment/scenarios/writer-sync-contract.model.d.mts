export interface ModelRow {
  did: string
  repoRev: string
}
export interface ModelPage {
  repos: ModelRow[]
  cursor?: string
}
export interface Write {
  repo: string
  repoRev: string
  timestamp: number
  hash: string
}
export interface State {
  writers: Map<string, Write & { spaceRev: string }>
  spaceRev?: string
}
export function catchUp(
  list: (cursor?: string) => Promise<ModelPage>,
  durableProcess: (rows: ModelRow[]) => Promise<void>,
  checkpoint?: string,
): Promise<string | undefined>
export function acceptWrite(
  state: State,
  input: Write,
  members: Set<string>,
  now: number,
  nextRevision: (previous?: string) => string,
): { spaceRev: string; prevSpaceRev?: string } | undefined
export function coalesceRetry<T extends { repoRev: string }>(
  pending: T | undefined,
  update: T,
): T
export function clearDelivered<T extends { repoRev: string }>(
  pending: T,
  delivered: { repoRev: string },
): T | undefined
export function retryDelay(attempt: number, jitter: number): number
