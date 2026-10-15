export function openBrowser(): Promise<unknown>
export function prepareAccount(
  browser: unknown,
  name: string,
): Promise<{
  account: { username: string; password: string; did: string; seedText: string }
  page: unknown
}>
export function acquireDelegation(page: unknown): Promise<string>
export function removeMember(page: unknown): Promise<number>
export function main(
  argv?: string[],
  run?: () => Promise<{
    suite: string
    assertions: { id: string; status: string }[]
  }>,
): Promise<void>

export function credentialLifetime(
  response: Response,
  expectedLifetime?: number,
  now?: number,
): Promise<{ credential: string; claims: Record<string, unknown> }>
export function deniedRenewal(
  exchange: () => Promise<Response>,
  remove: () => Promise<number>,
): Promise<void>
export function denied(response: Response, caseName: string): Promise<void>
export function runScenario<
  Page,
  Browser extends { close(): Promise<void> },
>(adapters: {
  open: () => Promise<Browser>
  prepare: (
    browser: Browser,
    name: string,
  ) => Promise<{
    account: { did: string; seedText: string }
    page: Page
  }>
  delegation: (page: Page) => Promise<string>
  remove: (page: Page) => Promise<number>
}): Promise<{ suite: string; assertions: { id: string; status: string }[] }>
