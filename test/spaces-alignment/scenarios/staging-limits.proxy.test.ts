import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The disposable Node proxy is an untyped scenario fixture.
import { createProxyServer } from './staging-limits.proxy.mjs'

const server = createProxyServer()
const servers = new Set([server])

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (active) =>
        new Promise<void>((resolve) => {
          if (active.listening) active.close(() => resolve())
          else resolve()
        }),
    ),
  )
  servers.clear()
  servers.add(server)
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

  it('uses the commit from the terminal upstream PDS page', async () => {
    const upstreamCursors: Array<string | undefined> = []
    const terminalCommit = { revision: 'terminal-revision' }
    const commitServer = createProxyServer(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const cursor = url.searchParams.get('cursor') ?? undefined
      upstreamCursors.push(cursor)
      return cursor
        ? new Response(JSON.stringify({ ops: [], commit: terminalCommit }))
        : new Response(JSON.stringify({ ops: [], cursor: 'upstream-next' }))
    })
    servers.add(commitServer)
    await new Promise<void>((resolve) =>
      commitServer.listen(0, '127.0.0.1', resolve),
    )
    const address = commitServer.address()
    if (!address || typeof address === 'string')
      throw new Error('Proxy did not bind a local port')
    const origin = `http://127.0.0.1:${address.port}`
    await fetch(`${origin}/_control/mode?value=replacement`)
    const page = async (cursor?: string) => {
      const url = new URL('/xrpc/com.atproto.space.listRepoOps', origin)
      url.searchParams.set('repo', 'did:example:motoko')
      if (cursor) url.searchParams.set('cursor', cursor)
      return fetch(url)
    }
    const firstPage = await page()
    expect((await firstPage.json()).cursor).toBe('replacement-1')
    const terminalPage = await page('replacement-1')
    expect((await terminalPage.json()).commit).toEqual(terminalCommit)
    expect(upstreamCursors).toEqual([undefined, 'upstream-next'])
  })

  it('keeps serving after upstream commit pagination is exhausted', async () => {
    let upstreamPages = 0
    const commitServer = createProxyServer(async () => {
      upstreamPages += 1
      return new Response(JSON.stringify({ ops: [], cursor: 'still-paging' }))
    })
    servers.add(commitServer)
    await new Promise<void>((resolve) =>
      commitServer.listen(0, '127.0.0.1', resolve),
    )
    const address = commitServer.address()
    if (!address || typeof address === 'string')
      throw new Error('Proxy did not bind a local port')
    const origin = `http://127.0.0.1:${address.port}`
    await fetch(`${origin}/_control/mode?value=replacement`)
    const page = async (cursor?: string) => {
      const url = new URL('/xrpc/com.atproto.space.listRepoOps', origin)
      url.searchParams.set('repo', 'did:example:rei')
      if (cursor) url.searchParams.set('cursor', cursor)
      return fetch(url)
    }
    await page()
    const failedTerminalPage = await page('replacement-1')
    expect(failedTerminalPage.status).toBe(502)
    expect(upstreamPages).toBe(256)
    const statusResponse = await fetch(`${origin}/_control/status`)
    expect(statusResponse.status).toBe(200)
  })
})
