import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import * as syntax from '@atproto/syntax'
import {
  formatRecordUri,
  getStratosBacklinks,
  parseRecordUri,
} from '../src/index.js'

const LIKE_URI = 'at://did:plc:misato-katsuragi/app.bsky.feed.like/eva-like'
const SHINJI = 'did:plc:shinji-ikari'
const ASUKA = 'did:plc:asuka-langley'
const SPACE_POST = `at:space/did:web:nerv.tokyo.jp/zone.stratos.space.feed/engineering/${ASUKA}/zone.stratos.feed.post/eva02`
const REPO_POST = `at://${SHINJI}/zone.stratos.feed.post/eva01`

type Backlink = ReturnType<typeof getStratosBacklinks>[number]

/** The extraction as it was before space-form subjects were indexed. */
function backlinksBeforeSpaceForms(
  uri: string,
  record: Record<string, unknown>,
): Backlink[] {
  const links: Backlink[] = []
  const subject = record['subject']
  if (typeof subject === 'string') {
    try {
      syntax.ensureValidDid(subject)
      links.push({ uri, path: 'subject', linkTo: subject })
    } catch {
      try {
        syntax.ensureValidAtUri(subject)
        links.push({ uri, path: 'subject', linkTo: subject })
      } catch {
        // not a reference
      }
    }
  } else if (
    subject &&
    typeof (subject as Record<string, unknown>)['uri'] === 'string'
  ) {
    try {
      const subjectUri = (subject as Record<string, unknown>)['uri'] as string
      syntax.ensureValidAtUri(subjectUri)
      links.push({ uri, path: 'subject.uri', linkTo: subjectUri })
    } catch {
      // not a reference
    }
  }
  return links
}

describe('getStratosBacklinks', () => {
  it('indexes a repo-form subject uri under its own string', () => {
    expect(
      getStratosBacklinks(LIKE_URI, { subject: { uri: REPO_POST } }),
    ).toEqual([{ uri: LIKE_URI, path: 'subject.uri', linkTo: REPO_POST }])
  })

  it('indexes a space-form subject uri under its canonical string', () => {
    expect(
      getStratosBacklinks(LIKE_URI, { subject: { uri: SPACE_POST } }),
    ).toEqual([{ uri: LIKE_URI, path: 'subject.uri', linkTo: SPACE_POST }])
  })

  it('indexes nothing for a uri that is neither form, and never throws', () => {
    const subjects = [
      { uri: `${SPACE_POST}/extra` },
      { uri: 'at:space/did:web:nerv.tokyo.jp/zone.stratos.space.feed' },
      { uri: 7 },
      { uri: null },
      { uri: '' },
      null,
      7,
      [],
    ]

    for (const subject of subjects) {
      expect(getStratosBacklinks(LIKE_URI, { subject })).toEqual([])
    }
  })

  it('adds only space-form subjects to what was indexed before', () => {
    fc.assert(
      fc.property(
        fc.record({
          subject: fc.oneof(
            fc.jsonValue(),
            fc.record({ uri: fc.oneof(fc.string(), fc.jsonValue()) }),
            fc.record({
              uri: fc.constantFrom(REPO_POST, SPACE_POST, `${REPO_POST}/x`),
            }),
          ),
        }),
        (record) => {
          const before = backlinksBeforeSpaceForms(LIKE_URI, record)
          const after = getStratosBacklinks(LIKE_URI, record)
          const added = after.filter(
            (link) =>
              !before.some(
                (old) => old.path === link.path && old.linkTo === link.linkTo,
              ),
          )

          expect(after.slice(0, before.length)).toEqual(before)
          for (const link of added) {
            const parsed = parseRecordUri(link.linkTo)
            expect(parsed.ok).toBe(true)
            if (parsed.ok) {
              const formatted = formatRecordUri(parsed.value)
              expect(formatted.ok && formatted.value).toBe(link.linkTo)
            }
          }
        },
      ),
    )
  })
})
