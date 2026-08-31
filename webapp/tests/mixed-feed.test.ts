import {describe, expect, it, vi} from 'vitest'
import {render, screen} from '@testing-library/svelte'
import Feed from '../src/lib/Feed.svelte'

describe('Feed.svelte', () => {
  it('renders public and private authors from the same unified feed', () => {
    render(Feed, {
      props: {
        loading: false,
        stratosAgent: null,
        publicAgent: null,
        serviceUrl: 'https://stratos.example',
        onreply: vi.fn(),
        posts: [
          {
            uri: 'at://did:plc:faye/app.bsky.feed.post/one',
            cid: 'faye-cid',
            author: 'did:plc:faye',
            authorHandle: 'faye.example',
            text: 'Faye posts in public.',
            createdAt: '1999-02-01T00:00:00.000Z',
            boundaries: [],
            isPrivate: false,
            reply: null,
          },
          {
            uri: 'at://did:web:stratos.example/space/zone.stratos.space.feed/nerve/did:plc:rei/zone.stratos.feed.post/two',
            cid: 'rei-cid',
            author: 'did:plc:rei',
            authorHandle: 'rei.example',
            text: 'Rei posts in private.',
            createdAt: '1999-02-02T00:00:00.000Z',
            boundaries: ['did:web:stratos.example/nerve'],
            isPrivate: true,
            reply: null,
          },
        ],
      },
    })

    expect(screen.getByText('@faye.example')).toBeInTheDocument()
    expect(screen.getByText('@rei.example')).toBeInTheDocument()
    expect(screen.getByText('Faye posts in public.')).toBeInTheDocument()
    expect(screen.getByText('Rei posts in private.')).toBeInTheDocument()
    expect(screen.getByText('Private')).toBeInTheDocument()
  })
})
