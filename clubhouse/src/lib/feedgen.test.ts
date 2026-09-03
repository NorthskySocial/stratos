import { describe, expect, it, vi } from 'vitest'
import { FeedCursorStore, FeedgenError, getFeed, safePostText } from './feedgen'

const session = (response: Response) => ({
  fetchHandler: vi.fn().mockResolvedValue(response),
})

describe('Feedgen room client', () => {
  it('uses only getFeed through the PDS proxy and preserves a feed cursor', async () => {
    const current = session(new Response(JSON.stringify({
      cursor: 'kaworu-next',
      feed: [{ post: {
        uri: 'at://did:plc:kaworu/zone.stratos.feed.post/1',
        cid: 'bafy-kaworu', indexedAt: '2026-09-03T10:00:00.000Z',
        author: { did: 'did:plc:kaworu', handle: 'kaworu.example' },
        record: { text: '<img src=x onerror=alert(1)>' },
      } }],
    }), { status: 200 }))
    const page = await getFeed(current as never, { feedgenDid: 'did:web:feed.example' }, {
      feed: 'terminal-dogma', limit: 200, cursor: 'asuka-cursor',
    })
    expect(page.posts[0]?.text).toBe('<img src=x onerror=alert(1)>')
    expect(current.fetchHandler).toHaveBeenCalledWith(
      '/xrpc/zone.stratos.feedgen.getFeed?feed=terminal-dogma&limit=100&cursor=asuka-cursor',
      { method: 'GET', headers: { 'atproto-proxy': 'did:web:feed.example#stratos_feedgen' } },
    )
  })

  it('keeps cursors scoped to a feed and clears a fresh room request', () => {
    const cursors = new FeedCursorStore()
    cursors.set('tokyo-3', 'rei-next')
    cursors.set('nerv-hq', 'misato-next')
    cursors.reset('nerv-hq')
    expect(cursors.get('tokyo-3')).toBe('rei-next')
    expect(cursors.get('nerv-hq')).toBeUndefined()
  })

  it('surfaces the Feedgen domain error instead of an empty feed', async () => {
    const current = session(new Response(JSON.stringify({ error: 'BoundaryMismatch' }), { status: 403 }))
    await expect(getFeed(current as never, { feedgenDid: 'did:web:feed.example' }, { feed: 'tokyo-3', limit: 50 }))
      .rejects.toMatchObject({ code: 'BoundaryMismatch' })
  })

  it('treats only text fields as post text', () => {
    expect(safePostText({ text: 'Shinji <b>stays text</b>' })).toBe('Shinji <b>stays text</b>')
    expect(safePostText({ html: '<script>bad()</script>' })).toBe('')
  })
})
