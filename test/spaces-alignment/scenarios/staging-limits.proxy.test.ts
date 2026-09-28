import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The disposable Node proxy is an untyped scenario fixture.
import { createProxyServer } from './staging-limits.proxy.mjs'

const server = createProxyServer()

afterEach(async () => {
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('staging limits proxy', () => {
  it('interrupts both repos when their pages interleave', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Proxy did not bind a local port')
    const origin = `http://127.0.0.1:${address.port}`
    await fetch(`${origin}/_control/mode?value=limit`)
    const page = async (repo: string, cursor?: string) => {
      const url = new URL('/xrpc/com.atproto.space.listRepoOps', origin)
      url.searchParams.set('repo', repo)
      if (cursor) url.searchParams.set('cursor', cursor)
      return fetch(url)
    }
    const firstA = await page('did:example:rei')
    const firstB = await page('did:example:motoko')
    expect(firstA.status).toBe(200)
    expect(firstB.status).toBe(200)
    const cursorA = (await firstA.json()).cursor as string
    const cursorB = (await firstB.json()).cursor as string
    expect((await page('did:example:rei', cursorA)).status).toBe(503)
    expect((await page('did:example:motoko', cursorB)).status).toBe(503)
    const status = await (await fetch(`${origin}/_control/status`)).json()
    expect(status).toMatchObject({ pages: 2, interruptions: 2, targetCount: 2 })
  })
})
