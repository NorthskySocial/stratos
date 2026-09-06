import { describe, expect, it, vi } from 'vitest'
import { getActorProfiles, searchActors } from './typeahead'

describe('Typeahead actor client', () => {
  it('searches the canonical endpoint and keeps safe profile fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          actors: [
            {
              did: 'did:plc:misato',
              handle: 'misato.example',
              displayName: 'Misato Katsuragi',
              avatar: 'https://cdn.example/misato.jpg',
              viewer: { following: 'ignored' },
            },
          ],
        }),
        { status: 200 },
      ),
    )

    await expect(searchActors('  misa  ', fetcher)).resolves.toEqual([
      {
        did: 'did:plc:misato',
        handle: 'misato.example',
        displayName: 'Misato Katsuragi',
        avatar: 'https://cdn.example/misato.jpg',
      },
    ])
    expect(fetcher).toHaveBeenCalledWith(
      'https://typeahead.waow.tech/xrpc/tech.waow.typeahead.searchActors?q=misa&limit=6',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Client': expect.any(String) }),
      }),
    )
  })

  it('loads profiles in batches of 25 for feed avatars', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const actors = new URL(String(input)).searchParams.getAll('actors')
      return new Response(
        JSON.stringify({
          profiles: actors.map((actor) => ({
            did: actor,
            handle: `${actor.split(':').at(-1)}.example`,
            avatar: `https://cdn.example/${actor.split(':').at(-1)}.jpg`,
          })),
        }),
        { status: 200 },
      )
    })
    const actors = Array.from(
      { length: 26 },
      (_, index) => `did:plc:pilot-${index}`,
    )

    const profiles = await getActorProfiles(actors, fetcher)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(profiles.get('did:plc:pilot-25')?.avatar).toBe(
      'https://cdn.example/pilot-25.jpg',
    )
  })
})
