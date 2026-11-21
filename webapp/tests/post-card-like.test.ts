import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import type { StratosEnrollment } from '../src/lib/stratos'
import PostCard from '../src/lib/PostCard.svelte'

const enrollment: StratosEnrollment = {
  service: 'https://stratos.example',
  custody: 'stratos',
  boundaries: [{ value: 'did:web:stratos.example/nerve' }],
  signingKey: 'did:key:zQ3shjRei',
  attestation: null,
  createdAt: '1995-10-04T00:00:00.000Z',
  rkey: 'nerve',
}

const session = {
  sub: 'did:plc:rei',
  did: 'did:plc:rei',
  fetchHandler: vi.fn(),
}

function renderCard(isPrivate: boolean, withSession: boolean) {
  render(PostCard, {
    post: {
      uri: 'at://did:plc:asuka/zone.stratos.feed.post/3kunit02',
      cid: 'bafyreiasuka',
      author: 'did:plc:asuka',
      authorHandle: 'asuka.example',
      text: 'Anta baka?',
      createdAt: new Date().toISOString(),
      boundaries: ['did:web:stratos.example/nerve'],
      isPrivate,
      reply: null,
      likeCount: 4,
    },
    stratosAgent: null,
    currentDid: 'did:plc:rei',
    onreply: () => {},
    ondelete: async () => {},
    ...(withSession ? { session, enrollment, attestationVerified: true } : {}),
  })
}

describe('PostCard.svelte like button', () => {
  it('shows the like button on a private post for an enrolled member', () => {
    renderCard(true, true)

    expect(screen.getByRole('button', { name: 'Like' })).toBeInTheDocument()
    expect(screen.getByText('4 likes')).toBeInTheDocument()
  })

  it('shows no like button on a public post', () => {
    renderCard(false, true)

    expect(
      screen.queryByRole('button', { name: 'Like' }),
    ).not.toBeInTheDocument()
  })

  it('shows no like button without a session and enrollment', () => {
    renderCard(true, false)

    expect(
      screen.queryByRole('button', { name: 'Like' }),
    ).not.toBeInTheDocument()
  })
})
