import { describe, expect, it } from 'vitest'
import type { ClubhouseFeedPost } from './feedgen'
import { mergeFeedAuthors } from './feed-authors'

const rei: ClubhouseFeedPost = {
  uri: 'at://did:plc:rei/zone.stratos.feed.post/eva',
  cid: 'new-cid',
  text: 'Meet at Tokyo-3',
  indexedAt: '2026-09-07T08:00:00Z',
  author: {
    did: 'did:plc:rei',
    handle: 'rei.example',
    displayName: 'Rei',
    avatar: 'https://example.com/rei.png',
  },
  reply: {
    root: { uri: 'root', cid: 'root-cid' },
    parent: { uri: 'parent', cid: 'parent-cid' },
  },
}

describe('mergeFeedAuthors', () => {
  it('preserves current posts and reply references, applies author fields, and ignores absent posts', () => {
    const asuka = { ...rei, uri: 'asuka' }
    const enriched = {
      ...rei,
      cid: 'old-cid',
      text: 'Old text',
      reply: undefined,
      author: {
        did: rei.author.did,
        handle: 'rei.new.example',
        displayName: 'Rei Ayanami',
        avatar: 'https://example.com/new.png',
      },
    }
    const result = mergeFeedAuthors(
      [rei, asuka],
      [enriched, { ...enriched, uri: 'deleted' }],
    )
    expect(result).toEqual([{ ...rei, author: enriched.author }, asuka])
    expect(result[1]).toBe(asuka)
    expect(rei.author.displayName).toBe('Rei')
  })

  it('retains existing fields when enrichment omits them', () => {
    expect(
      mergeFeedAuthors([rei], [{ ...rei, author: { did: rei.author.did } }]),
    ).toEqual([rei])
  })

  it('rejects author data for a different DID even when the URI matches', () => {
    const result = mergeFeedAuthors(
      [rei],
      [{ ...rei, author: { did: 'did:plc:asuka', displayName: 'Asuka' } }],
    )
    expect(result[0]).toBe(rei)
  })
})
