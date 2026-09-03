import { describe, expect, it, vi } from 'vitest'
import { configureAgent, createServiceFetch } from '../src/stratos-agent'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { stratosLexicons } from '@northskysocial/stratos-client/lexicons'

describe('createServiceFetch', () => {
  it('routes relative and absolute calls through the target service', async () => {
    const fetchHandler = vi.fn().mockResolvedValue(new Response())
    const fetch = createServiceFetch(
      { fetchHandler } as unknown as OAuthSession,
      'https://stratos.example',
    )

    await fetch('/xrpc/zone.stratos.feed.get')
    await fetch(
      new URL('https://elsewhere.example/xrpc/zone.stratos.feed.get?a=1'),
    )

    expect(fetchHandler).toHaveBeenNthCalledWith(
      1,
      'https://stratos.example/xrpc/zone.stratos.feed.get',
      undefined,
    )
    expect(fetchHandler).toHaveBeenNthCalledWith(
      2,
      'https://stratos.example/xrpc/zone.stratos.feed.get?a=1',
      undefined,
    )
  })

  it('retries one DPoP nonce challenge with the session fetch handler', async () => {
    const fetchHandler = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 401,
          headers: { 'dpop-nonce': 'reina' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok'))
    const fetch = createServiceFetch(
      { fetchHandler } as unknown as OAuthSession,
      'https://stratos.example',
    )

    await expect(fetch('/xrpc/zone.stratos.feed.get')).resolves.toMatchObject({
      status: 200,
    })
    expect(fetchHandler).toHaveBeenCalledTimes(2)
  })

  it('rejects Request inputs rather than silently losing their body', async () => {
    const fetchHandler = vi.fn()
    const fetch = createServiceFetch(
      { fetchHandler } as unknown as OAuthSession,
      'https://stratos.example',
    )

    await expect(
      fetch(new Request('https://stratos.example/xrpc/zone.stratos.feed.get')),
    ).rejects.toThrow('does not accept a Request')
    expect(fetchHandler).not.toHaveBeenCalled()
  })
})

describe('configureAgent', () => {
  it('keeps bundled Stratos lexicons when an app adds its own lexicon', () => {
    const add = vi.fn()
    const extra = { lexicon: 1, id: 'example.clubhouse.defs' }
    configureAgent({ api: { lex: { add } } } as never, [extra] as never)

    expect(add.mock.calls.map(([doc]) => doc)).toEqual([
      ...stratosLexicons,
      extra,
    ])
  })
})
