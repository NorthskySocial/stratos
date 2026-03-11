import { describe, it, expect } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

import { findBlobRefs } from '../src/blob/blob-refs.js'

const createCid = async (data: string): Promise<CID> => {
  const bytes = new TextEncoder().encode(data)
  const hash = await sha256.digest(bytes)
  return CID.createV1(0x55, hash)
}

const makeBlobRef = (cidStr: string, mimeType = 'image/png', size = 1024) => ({
  $type: 'blob' as const,
  ref: { $link: cidStr },
  mimeType,
  size,
})

describe('findBlobRefs', () => {
  it('returns empty array for null/undefined/primitives', () => {
    expect(findBlobRefs(null)).toEqual([])
    expect(findBlobRefs(undefined)).toEqual([])
    expect(findBlobRefs('hello')).toEqual([])
    expect(findBlobRefs(42)).toEqual([])
    expect(findBlobRefs(true)).toEqual([])
  })

  it('returns empty array for records with no blobs', () => {
    const record = {
      $type: 'app.stratos.feed.post',
      text: 'hello world',
      boundary: { values: [{ value: 'test' }] },
      createdAt: new Date().toISOString(),
    }
    expect(findBlobRefs(record)).toEqual([])
  })

  it('finds a single blob ref in an image embed', async () => {
    const cid = await createCid('test-image-1')
    const record = {
      $type: 'app.stratos.feed.post',
      text: 'post with image',
      boundary: { values: [{ value: 'test' }] },
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.images',
        images: [
          {
            image: makeBlobRef(cid.toString(), 'image/jpeg', 2048),
            alt: 'test image',
          },
        ],
      },
    }

    const refs = findBlobRefs(record)
    expect(refs).toHaveLength(1)
    expect(refs[0].cid.toString()).toBe(cid.toString())
    expect(refs[0].mimeType).toBe('image/jpeg')
  })

  it('finds multiple blob refs in a multi-image embed', async () => {
    const cid1 = await createCid('image-1')
    const cid2 = await createCid('image-2')
    const cid3 = await createCid('image-3')

    const record = {
      $type: 'app.stratos.feed.post',
      text: 'gallery post',
      boundary: { values: [{ value: 'test' }] },
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.images',
        images: [
          { image: makeBlobRef(cid1.toString()), alt: 'one' },
          { image: makeBlobRef(cid2.toString()), alt: 'two' },
          { image: makeBlobRef(cid3.toString(), 'image/gif'), alt: 'three' },
        ],
      },
    }

    const refs = findBlobRefs(record)
    expect(refs).toHaveLength(3)
    expect(refs.map((r) => r.cid.toString()).sort()).toEqual(
      [cid1, cid2, cid3].map((c) => c.toString()).sort(),
    )
  })

  it('finds a thumb blob in an external embed', async () => {
    const thumbCid = await createCid('thumb-data')
    const record = {
      $type: 'app.stratos.feed.post',
      text: 'link post',
      boundary: { values: [{ value: 'test' }] },
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: 'Example',
          description: 'A test link',
          thumb: makeBlobRef(thumbCid.toString(), 'image/png', 512),
        },
      },
    }

    const refs = findBlobRefs(record)
    expect(refs).toHaveLength(1)
    expect(refs[0].cid.toString()).toBe(thumbCid.toString())
  })

  it('returns empty array for external embed without thumb', () => {
    const record = {
      $type: 'app.stratos.feed.post',
      text: 'link post no thumb',
      boundary: { values: [{ value: 'test' }] },
      embed: {
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com',
          title: 'Example',
          description: 'No thumbnail',
        },
      },
    }
    expect(findBlobRefs(record)).toEqual([])
  })

  it('returns empty array for a record embed (no blobs)', () => {
    const record = {
      $type: 'app.stratos.feed.post',
      text: 'quoting another post',
      boundary: { values: [{ value: 'test' }] },
      embed: {
        $type: 'app.bsky.embed.record',
        record: {
          uri: 'at://did:plc:abc/app.stratos.feed.post/123',
          cid: 'bafyreifake',
        },
      },
    }
    expect(findBlobRefs(record)).toEqual([])
  })

  it('finds blobs in recordWithMedia embed', async () => {
    const imageCid = await createCid('rwm-image')
    const record = {
      $type: 'app.stratos.feed.post',
      text: 'quote with media',
      boundary: { values: [{ value: 'test' }] },
      embed: {
        $type: 'app.bsky.embed.recordWithMedia',
        record: {
          record: {
            uri: 'at://did:plc:abc/app.stratos.feed.post/456',
            cid: 'bafyreifake2',
          },
        },
        media: {
          $type: 'app.bsky.embed.images',
          images: [
            {
              image: makeBlobRef(imageCid.toString(), 'image/webp', 4096),
              alt: 'attached image',
            },
          ],
        },
      },
    }

    const refs = findBlobRefs(record)
    expect(refs).toHaveLength(1)
    expect(refs[0].cid.toString()).toBe(imageCid.toString())
    expect(refs[0].mimeType).toBe('image/webp')
  })

  it('finds video blob', async () => {
    const videoCid = await createCid('video-data')
    const record = {
      $type: 'app.stratos.feed.post',
      text: '',
      boundary: { values: [{ value: 'test' }] },
      embed: {
        $type: 'app.bsky.embed.video',
        video: makeBlobRef(videoCid.toString(), 'video/mp4', 50000),
        alt: 'a video',
      },
    }

    const refs = findBlobRefs(record)
    expect(refs).toHaveLength(1)
    expect(refs[0].mimeType).toBe('video/mp4')
  })

  it('handles deeply nested structures within depth limit', async () => {
    const cid = await createCid('deep-blob')
    let obj: Record<string, unknown> = {
      blob: makeBlobRef(cid.toString()),
    }
    for (let i = 0; i < 30; i++) {
      obj = { nested: obj }
    }
    const refs = findBlobRefs(obj)
    expect(refs).toHaveLength(1)
  })

  it('stops recursing past depth limit of 32', async () => {
    const cid = await createCid('too-deep-blob')
    let obj: Record<string, unknown> = {
      blob: makeBlobRef(cid.toString()),
    }
    for (let i = 0; i < 35; i++) {
      obj = { nested: obj }
    }
    const refs = findBlobRefs(obj)
    expect(refs).toHaveLength(0)
  })

  it('skips Uint8Array values', () => {
    const record = {
      data: new Uint8Array([1, 2, 3]),
      text: 'hello',
    }
    expect(findBlobRefs(record)).toEqual([])
  })

  it('skips invalid blob refs with bad CID', () => {
    const record = {
      embed: {
        $type: 'app.bsky.embed.images',
        images: [
          {
            image: {
              $type: 'blob',
              ref: { $link: 'not-a-valid-cid' },
              mimeType: 'image/png',
              size: 100,
            },
            alt: 'bad blob',
          },
        ],
      },
    }
    expect(findBlobRefs(record)).toEqual([])
  })

  it('skips objects that look like blobs but missing required fields', () => {
    const record = {
      embed: {
        images: [
          { image: { $type: 'blob', ref: { $link: 'abc' } } },
          { image: { $type: 'blob', mimeType: 'image/png' } },
          {
            image: {
              $type: 'notblob',
              ref: { $link: 'abc' },
              mimeType: 'image/png',
            },
          },
        ],
      },
    }
    expect(findBlobRefs(record)).toEqual([])
  })
})
