import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  roomIdFromPath,
  roomPath,
  topicLinkIsRefused,
  topicPath,
  topicUriFromPath,
} from './route'

interface RecordCase {
  name: string
  uri: string
}

interface InvalidCase {
  name: string
  input: string
  as: 'space' | 'record' | 'both'
}

const CORPUS_PATH =
  '../../../test/spaces-alignment/november/fixtures/space-uri-conformance.json'

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, CORPUS_PATH), 'utf8'),
) as {
  records: RecordCase[]
  repoRecords: RecordCase[]
  invalid: InvalidCase[]
}

const SPIKE = 'did:plc:spikespiegel'
const CUSTODY_POST = `at://${SPIKE}/zone.stratos.feed.post/swordfish`

const LEGACY_SPACE_RECORD = `at://did:web:bebop.example/space/zone.stratos.space.feed/crew/did:plc:fayevalentine/zone.stratos.feed.post/swordfish`

describe('room routes', () => {
  it('uses only the room/feed ID in a durable URL', () => {
    expect(roomPath('open-orbit')).toBe('/rooms/open-orbit')
    expect(roomPath('room with spaces')).toBe('/rooms/room%20with%20spaces')
    expect(roomPath('open-orbit')).not.toContain('boundary')
  })

  it('reads IDs and rejects paths outside /rooms/:id', () => {
    expect(roomIdFromPath('/rooms/open-orbit')).toBe('open-orbit')
    expect(roomIdFromPath('/rooms/room%20with%20spaces/')).toBe(
      'room with spaces',
    )
    expect(roomIdFromPath('/rooms/open-orbit?topic=ignored')).toBe('open-orbit')
    expect(roomIdFromPath('/rooms/open-orbit/extra')).toBeNull()
    expect(roomIdFromPath('/')).toBeNull()
  })

  it('round-trips a custody topic in a shareable room URL', () => {
    const uri = 'at://did:plc:rei/zone.stratos.feed.post/3kabc'
    const path = topicPath('open-orbit', uri)
    expect(path).toBe(`/rooms/open-orbit?topic=${encodeURIComponent(uri)}`)
    expect(topicUriFromPath(path)).toBe(uri)
    expect(
      topicUriFromPath('/rooms/open-orbit?topic=https%3A%2F%2Fbad'),
    ).toBeNull()
  })
})

describe('topic links', () => {
  it.each(corpus.records.map((entry) => [entry.name, entry.uri] as const))(
    'round-trips a space record topic: %s',
    (_name, uri) => {
      const path = topicPath('bebop', uri)
      expect(path).toBe(`/rooms/bebop?topic=${encodeURIComponent(uri)}`)
      expect(topicUriFromPath(path)).toBe(uri)
      expect(topicLinkIsRefused(path)).toBe(false)
    },
  )

  it.each(corpus.repoRecords.map((entry) => [entry.name, entry.uri] as const))(
    'round-trips a custody topic: %s',
    (_name, uri) => {
      const path = topicPath('bebop', uri)
      expect(topicUriFromPath(path)).toBe(uri)
      expect(topicLinkIsRefused(path)).toBe(false)
    },
  )

  it('encodes the percent escape inside a did:web port a second time', () => {
    const uri = 'at://did:web:localhost%3A3100/zone.stratos.feed.post/eva01'
    const path = topicPath('nerv', uri)
    expect(path).toBe(
      '/rooms/nerv?topic=at%3A%2F%2Fdid%3Aweb%3Alocalhost%253A3100%2Fzone.stratos.feed.post%2Feva01',
    )
    expect(topicUriFromPath(path)).toBe(uri)
  })

  it.each(
    corpus.invalid
      .filter((entry) => entry.as !== 'space')
      .map((entry) => [entry.name, entry.input] as const),
  )('refuses a value the corpus rules out: %s', (_name, input) => {
    expect(() => topicPath('bebop', input)).toThrow(
      'A topic record address is required',
    )
    const path = `/rooms/bebop?topic=${encodeURIComponent(input)}`
    expect(topicUriFromPath(path)).toBeNull()
    expect(topicLinkIsRefused(path)).toBe(true)
  })

  it.each([
    [
      'a space URI that names no record',
      'at:space/did:web:bebop.example/zone.stratos.space.feed/crew',
    ],
    ['an earlier-spelling record', LEGACY_SPACE_RECORD],
    ['a handle author', 'at://spike.example/zone.stratos.feed.post/swordfish'],
    ['an empty value', ''],
  ])('refuses %s', (_label, value) => {
    expect(() => topicPath('bebop', value)).toThrow()
    const path = `/rooms/bebop?topic=${encodeURIComponent(value)}`
    expect(topicUriFromPath(path)).toBeNull()
    expect(topicLinkIsRefused(path)).toBe(true)
  })

  it('does not call a missing topic refused', () => {
    expect(topicLinkIsRefused('/rooms/bebop')).toBe(false)
    expect(topicLinkIsRefused('/rooms/bebop?other=1')).toBe(false)
    expect(topicLinkIsRefused('/')).toBe(false)
  })

  // The link text after `topic=` goes through URLSearchParams only. A plus
  // becomes a space and is refused; an encoded plus or slash is kept as the
  // character and refused by the classifier; a bad escape is kept as text and
  // refused.
  it.each([
    ['a plus in the record key', `${CUSTODY_POST}+2`],
    ['a leading plus', `+${CUSTODY_POST}`],
    ['an encoded plus', `${CUSTODY_POST}%2B2`],
    [
      'an encoded slash in the record key',
      `at://${SPIKE}/zone.stratos.feed.post/a%2Fb`,
    ],
    ['a bad escape', 'at://did:web:a%zz/zone.stratos.feed.post/swordfish'],
    ['a lone percent sign', `${CUSTODY_POST}%`],
    ['an encoded trailing space', `${CUSTODY_POST}%20`],
  ])('refuses a hand-written link with %s', (_label, raw) => {
    const path = `/rooms/bebop?topic=${raw}`
    expect(topicUriFromPath(path)).toBeNull()
    expect(topicLinkIsRefused(path)).toBe(true)
  })

  it('reads an unencoded custody value and an encoded port written once as the decoded string', () => {
    expect(topicUriFromPath(`/rooms/bebop?topic=${CUSTODY_POST}`)).toBe(
      CUSTODY_POST,
    )
    expect(
      topicUriFromPath(
        '/rooms/bebop?topic=at://did:web:localhost%3A3100/zone.stratos.feed.post/eva01',
      ),
    ).toBe('at://did:web:localhost:3100/zone.stratos.feed.post/eva01')
  })

  it('reads no topic outside a room route', () => {
    expect(
      topicUriFromPath(`/?topic=${encodeURIComponent(CUSTODY_POST)}`),
    ).toBeNull()
    expect(topicLinkIsRefused('/?topic=nonsense')).toBe(false)
  })
})
