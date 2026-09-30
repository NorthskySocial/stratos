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

  it('uses the PDS latest commit for a synthetic terminal page', async () => {
    const upstreamRequests: URL[] = []
    const terminalCommit = { revision: 'terminal-revision' }
    const commitServer = createProxyServer(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      upstreamRequests.push(url)
      return new Response(JSON.stringify({ commit: terminalCommit }))
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
      url.searchParams.set(
        'space',
        'at://did:example:authority/space/feed/home',
      )
      if (cursor) url.searchParams.set('cursor', cursor)
      return fetch(url)
    }
    const firstPage = await page()
    expect((await firstPage.json()).cursor).toBe('replacement-1')
    const terminalPage = await page('replacement-1')
    expect((await terminalPage.json()).commit).toEqual(terminalCommit)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0].pathname).toBe(
      '/xrpc/com.atproto.space.getLatestCommit',
    )
    expect(upstreamRequests[0].searchParams.get('repo')).toBe(
      'did:example:motoko',
    )
    expect(upstreamRequests[0].searchParams.get('space')).toBe(
      'at://did:example:authority/space/feed/home',
    )
    const status = await (await fetch(`${origin}/_control/status`)).json()
    expect(status).toMatchObject({ commitRequests: 1, commitFailures: 0 })
  })

  it('keeps serving after the PDS latest commit is unavailable', async () => {
    let upstreamRequests = 0
    const commitServer = createProxyServer(async () => {
      upstreamRequests += 1
      return new Response(JSON.stringify({}), { status: 200 })
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
    expect(upstreamRequests).toBe(1)
    const statusResponse = await fetch(`${origin}/_control/status`)
    expect(statusResponse.status).toBe(200)
    expect(await statusResponse.json()).toMatchObject({
      commitRequests: 1,
      commitFailures: 1,
      lastCommitStatus: 200,
    })
  })
})
