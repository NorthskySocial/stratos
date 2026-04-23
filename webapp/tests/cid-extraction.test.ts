import { describe, expect, it } from 'vitest'
import { getCid } from '../src/lib/utils/cid'

describe('getCid extraction', () => {
  it('extracts CID from direct string', () => {
    expect(getCid('bafkrei-direct')).toBe('bafkrei-direct')
  })

  it('extracts CID from top-level cid property', () => {
    expect(getCid({ cid: 'bafkrei-cid' })).toBe('bafkrei-cid')
  })

  it('extracts CID from top-level $link property', () => {
    expect(getCid({ $link: 'bafkrei-link' })).toBe('bafkrei-link')
  })

  it('extracts CID from standard ATProto ref structure', () => {
    expect(
      getCid({
        ref: { $link: 'bafkrei-ref-link' },
        mimeType: 'image/jpeg',
      }),
    ).toBe('bafkrei-ref-link')
  })

  it('extracts CID from nested original structure (from logs)', () => {
    const input = {
      ref: {
        code: 85,
        version: 1,
        hash: { '0': 18, '1': 32, '2': 193 }, // non-string ref
      },
      size: 384452,
      mimeType: 'image/jpeg',
      original: {
        $type: 'blob',
        ref: {
          $link: 'bafkreigbpcsylct4vguz6dnvq6drop3ipktp6ppgx4glw6zarimppfxehy',
        },
        mimeType: 'image/jpeg',
        size: 384452,
      },
    }
    expect(getCid(input as unknown as Parameters<typeof getCid>[0])).toBe(
      'bafkreigbpcsylct4vguz6dnvq6drop3ipktp6ppgx4glw6zarimppfxehy',
    )
  })

  it('extracts CID from original.ref when it is a direct string', () => {
    const input = {
      original: {
        ref: 'bafkrei-original-string',
        mimeType: 'image/jpeg',
      },
    }
    expect(getCid(input as unknown as Parameters<typeof getCid>[0])).toBe(
      'bafkrei-original-string',
    )
  })

  it('extracts CID from full post structure provided in issue', () => {
    const input = {
      text: 'goldfinger',
      $type: 'zone.stratos.feed.post',
      embed: {
        $type: 'zone.stratos.embed.images',
        images: [
          {
            alt: 'goldfinger',
            image: {
              ref: {
                $link:
                  'bafkreigbpcsylct4vguz6dnvq6drop3ipktp6ppgx4glw6zarimppfxehy',
              },
              size: 384452,
              mimeType: 'image/jpeg',
              original: {
                ref: {
                  $link:
                    'bafkreigbpcsylct4vguz6dnvq6drop3ipktp6ppgx4glw6zarimppfxehy',
                },
                size: 384452,
                $type: 'blob',
                mimeType: 'image/jpeg',
              },
            },
          },
        ],
      },
      boundary: {
        $type: 'zone.stratos.boundary.defs#Domains',
        values: [
          {
            value: 'did:web:stratos.ngrok.dev/example.com',
          },
        ],
      },
      createdAt: '2026-04-13T01:24:23.595Z',
    }
    const image = input.embed.images[0].image
    expect(getCid(image as unknown as Parameters<typeof getCid>[0])).toBe(
      'bafkreigbpcsylct4vguz6dnvq6drop3ipktp6ppgx4glw6zarimppfxehy',
    )
  })

  it('extracts CID when nested under image property', () => {
    const input = {
      image: {
        ref: { $link: 'bafkrei-nested-image' },
      },
    }
    expect(getCid(input as unknown as Parameters<typeof getCid>[0])).toBe(
      'bafkrei-nested-image',
    )
  })

  it('extracts CID from image property when it is a direct string', () => {
    const input = {
      image: 'bafkrei-image-string',
    }
    expect(getCid(input as unknown as Parameters<typeof getCid>[0])).toBe(
      'bafkrei-image-string',
    )
  })

  it('extracts CID from ref property when it is a direct string', () => {
    const input = {
      ref: 'bafkrei-ref-string',
    }
    expect(getCid(input as unknown as Parameters<typeof getCid>[0])).toBe(
      'bafkrei-ref-string',
    )
  })

  it('returns undefined when no CID is found', () => {
    expect(getCid({})).toBeUndefined()
    expect(
      getCid({ something: 'else' } as unknown as Parameters<typeof getCid>[0]),
    ).toBeUndefined()
  })
})
