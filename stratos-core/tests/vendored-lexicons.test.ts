import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  jsonToLex,
  LexiconDefNotFoundError,
  Lexicons,
  ValidationError,
  type LexiconDoc,
} from '@atproto/lexicon'
import { stratosLexicons } from '../src/index.js'
import fixture from './fixtures/vendored-lexicons.json' with { type: 'json' }

const VENDORED_DIR = new URL('../src/lexicons/vendored/', import.meta.url)
const POST = 'zone.stratos.feed.post'
const BLOB_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const POST_CID = 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a'
const SHINJI = 'did:plc:shinji-ikari'
const MISATO = 'did:plc:misato-katsuragi'
const MAX_TEXT_BYTES = 3000

const strongRef = (rkey: string) => ({
  uri: `at://${SHINJI}/${POST}/${rkey}`,
  cid: POST_CID,
})

const blob = (mimeType: string, size = 1200) => ({
  $type: 'blob',
  ref: { $link: BLOB_CID },
  mimeType,
  size,
})

const aspectRatio = { width: 1920, height: 1080 }

const embeddedImages = {
  $type: 'app.bsky.embed.images',
  images: [{ image: blob('image/png'), alt: 'Unit 01', aspectRatio }],
}

function post(extra: Record<string, unknown> = {}) {
  return {
    $type: POST,
    text: 'Sortie',
    createdAt: '1996-10-04T00:00:00.000Z',
    ...extra,
  }
}

// The server hands the pipeline records in lex form, so blobs are BlobRef
// instances rather than the JSON blob shape.
function lexForm(record: Record<string, unknown>) {
  return jsonToLex(record) as Record<string, unknown>
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function vendoredBytes(path: string) {
  return readFileSync(new URL(path, VENDORED_DIR))
}

interface Reach {
  docs: Set<string>
  unresolved: string[]
}

function splitRef(ref: string, baseNsid: string) {
  const withoutScheme = ref.replace(/^lex:/, '')
  const [nsid, hash] = withoutScheme.split('#')
  return { nsid: nsid || baseNsid, hash: hash ?? 'main' }
}

// Follows every ref and union member reachable from a record's schema,
// resolving each one through the Lexicons object as the validator would.
function reachableFrom(lexicons: Lexicons, record: LexiconDoc): Reach {
  const reach: Reach = { docs: new Set(), unresolved: [] }
  const visited = new Set<string>()

  function visitRef(ref: string, baseNsid: string) {
    const { nsid, hash } = splitRef(ref, baseNsid)
    const key = `${nsid}#${hash}`
    if (visited.has(key)) return
    visited.add(key)
    let def
    try {
      def = lexicons.getDefOrThrow(key)
    } catch (err) {
      if (!(err instanceof LexiconDefNotFoundError)) throw err
      reach.unresolved.push(key)
      return
    }
    reach.docs.add(nsid)
    visitDef(def, nsid)
  }

  function visitDef(def: unknown, baseNsid: string) {
    if (Array.isArray(def)) {
      def.forEach((item) => visitDef(item, baseNsid))
      return
    }
    if (typeof def !== 'object' || def === null) return
    const node = def as Record<string, unknown>
    if (node.type === 'ref' && typeof node.ref === 'string') {
      visitRef(node.ref, baseNsid)
    }
    if (node.type === 'union' && Array.isArray(node.refs)) {
      for (const ref of node.refs as string[]) visitRef(ref, baseNsid)
    }
    for (const value of Object.values(node)) visitDef(value, baseNsid)
  }

  visitRef(`${record.id}#main`, record.id)
  return reach
}

function recordDocs(docs: LexiconDoc[]) {
  return docs.filter((doc) => doc.defs.main?.type === 'record')
}

describe('vendored lexicon documents', () => {
  it('lists the ten upstream definitions, all from one source commit', () => {
    expect(fixture.docs.map((doc) => doc.nsid).sort()).toEqual(
      [
        'app.bsky.embed.defs',
        'app.bsky.embed.external',
        'app.bsky.embed.gallery',
        'app.bsky.embed.images',
        'app.bsky.embed.record',
        'app.bsky.embed.recordWithMedia',
        'app.bsky.embed.video',
        'app.bsky.feed.like',
        'app.bsky.feed.repost',
        'app.bsky.richtext.facet',
        'com.atproto.label.defs',
        'com.atproto.repo.strongRef',
      ].sort(),
    )
    expect(new Set(fixture.docs.map((doc) => doc.sourceCommit))).toEqual(
      new Set(['98ef3a6b9']),
    )
  })

  describe.each(fixture.docs)('$nsid', (entry) => {
    it('is byte-identical to the pinned upstream file', () => {
      expect(sha256(vendoredBytes(entry.path))).toBe(entry.sha256)
    })

    it('declares the nsid the fixture names', () => {
      const doc = JSON.parse(vendoredBytes(entry.path).toString('utf8'))
      expect(doc.id).toBe(entry.nsid)
    })

    it('is part of the provider', () => {
      expect(stratosLexicons.map((doc) => doc.id)).toContain(entry.nsid)
    })
  })

  it('keeps every ref reachable from every record lexicon resolvable', () => {
    const lexicons = new Lexicons(stratosLexicons)
    const records = recordDocs(stratosLexicons)
    expect(records.map((doc) => doc.id)).toContain(POST)

    const unresolved = records.flatMap((doc) =>
      reachableFrom(lexicons, doc).unresolved.map(
        (ref) => `${doc.id} -> ${ref}`,
      ),
    )

    expect(unresolved).toEqual([])
  })

  it('vendors only documents that a record lexicon reaches', () => {
    const lexicons = new Lexicons(stratosLexicons)
    const reached = new Set<string>()
    for (const record of recordDocs(stratosLexicons)) {
      for (const nsid of reachableFrom(lexicons, record).docs) {
        reached.add(nsid)
      }
    }

    const unreached = fixture.docs
      .map((doc) => doc.nsid)
      .filter((nsid) => !reached.has(nsid))

    expect(unreached).toEqual([])
  })

  describe('a stratos post validated with the provider', () => {
    const lexicons = new Lexicons(stratosLexicons)
    const accepts = (record: Record<string, unknown>) =>
      expect(() =>
        lexicons.assertValidRecord(POST, lexForm(record)),
      ).not.toThrow()

    it('accepts facets of each kind', () => {
      accepts(
        post({
          text: 'Pilot @misato see https://nerv.tokyo.jp #eva',
          facets: [
            {
              index: { byteStart: 6, byteEnd: 13 },
              features: [
                { $type: 'app.bsky.richtext.facet#mention', did: MISATO },
              ],
            },
            {
              index: { byteStart: 18, byteEnd: 38 },
              features: [
                {
                  $type: 'app.bsky.richtext.facet#link',
                  uri: 'https://nerv.tokyo.jp',
                },
              ],
            },
            {
              index: { byteStart: 39, byteEnd: 43 },
              features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'eva' }],
            },
          ],
        }),
      )
    })

    it('accepts a reply', () => {
      accepts(
        post({
          reply: { root: strongRef('eva00'), parent: strongRef('eva01') },
        }),
      )
    })

    it('accepts self labels', () => {
      accepts(
        post({
          labels: {
            $type: 'com.atproto.label.defs#selfLabels',
            values: [{ val: 'graphic-media' }],
          },
        }),
      )
    })

    it('accepts a stratos image embed', () => {
      accepts(
        post({
          embed: {
            $type: 'zone.stratos.embed.images',
            images: [{ image: blob('image/png'), alt: 'Unit 02' }],
          },
        }),
      )
    })

    it('accepts an image embed', () => {
      accepts(post({ embed: embeddedImages }))
    })

    it('accepts a video embed', () => {
      accepts(
        post({
          embed: {
            $type: 'app.bsky.embed.video',
            video: blob('video/mp4', 4_000_000),
            aspectRatio,
            captions: [{ lang: 'ja', file: blob('text/vtt', 900) }],
          },
        }),
      )
    })

    it('accepts an external embed', () => {
      accepts(
        post({
          embed: {
            $type: 'app.bsky.embed.external',
            external: {
              uri: 'https://nerv.tokyo.jp/magi',
              title: 'MAGI',
              description: 'Three supercomputers',
              thumb: blob('image/jpeg'),
              associatedRefs: [strongRef('eva02')],
            },
          },
        }),
      )
    })

    it('accepts a record embed', () => {
      accepts(
        post({
          embed: {
            $type: 'app.bsky.embed.record',
            record: strongRef('eva03'),
          },
        }),
      )
    })

    it('accepts a record with image media', () => {
      accepts(
        post({
          embed: {
            $type: 'app.bsky.embed.recordWithMedia',
            record: {
              $type: 'app.bsky.embed.record',
              record: strongRef('eva04'),
            },
            media: embeddedImages,
          },
        }),
      )
    })

    it('accepts a record with gallery media', () => {
      accepts(
        post({
          embed: {
            $type: 'app.bsky.embed.recordWithMedia',
            record: {
              $type: 'app.bsky.embed.record',
              record: strongRef('eva05'),
            },
            media: {
              $type: 'app.bsky.embed.gallery',
              items: [
                {
                  $type: 'app.bsky.embed.gallery#image',
                  image: blob('image/png'),
                  alt: 'Unit 05',
                  aspectRatio,
                },
              ],
            },
          },
        }),
      )
    })

    it('refuses a post whose text is over the byte limit with a validation error', () => {
      const tooLong = post({ text: 'a'.repeat(MAX_TEXT_BYTES + 1) })

      expect(() => lexicons.assertValidRecord(POST, lexForm(tooLong))).toThrow(
        ValidationError,
      )
    })

    it('refuses a facet whose byte slice is missing with a validation error', () => {
      const broken = post({
        facets: [{ index: { byteStart: 0 }, features: [] }],
      })

      expect(() => lexicons.assertValidRecord(POST, lexForm(broken))).toThrow(
        ValidationError,
      )
    })

    it('refuses a reply whose parent is not a strong ref', () => {
      const broken = post({
        reply: { root: strongRef('eva00'), parent: { uri: 'nope' } },
      })

      expect(() => lexicons.assertValidRecord(POST, lexForm(broken))).toThrow(
        ValidationError,
      )
    })
  })

  it('leaves the provider without any definition of the vendored namespaces beyond the ten', () => {
    const vendoredNamespaces = [
      'app.bsky.',
      'com.atproto.label.',
      'com.atproto.repo.strongRef',
    ]
    const ids = stratosLexicons
      .map((doc) => doc.id)
      .filter((id) =>
        vendoredNamespaces.some((prefix) => id.startsWith(prefix)),
      )

    expect(ids.sort()).toEqual(fixture.docs.map((doc) => doc.nsid).sort())
  })
})
