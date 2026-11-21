import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  feedgenServiceId,
  loadClubhouseConfig,
  roomCatalogEndpoint,
  roomPostEndpoint,
  roomStatusEndpoint,
} from './config'

describe('Clubhouse service endpoints', () => {
  it('loads the local PLC directory when configured', () => {
    const config = loadClubhouseConfig({
      VITE_PLC_DIRECTORY: 'https://plc.atmosbox.test/',
    })

    expect(config.plcDirectoryUrl).toBe('https://plc.atmosbox.test')
  })

  it('identifies the Feedgen service for OAuth scopes and PDS proxy routing', () => {
    expect(feedgenServiceId('did:web:feed.example')).toBe(
      'did:web:feed.example#stratos_feedgen',
    )
    expect(feedgenServiceId('did:web:feed.example#custom')).toBe(
      'did:web:feed.example#custom',
    )
  })

  it('derives all room endpoints from the configured Stratos service', () => {
    const config = {
      serviceUrl: 'https://stratos.example/service',
      pdsSpaceUriByRoom: {},
    }
    expect(roomCatalogEndpoint(config)).toBe(
      'https://stratos.example/service/oauth/boundaries',
    )
    expect(roomStatusEndpoint(config)).toBe(
      'https://stratos.example/service/oauth/boundaries/status',
    )
    expect(roomPostEndpoint(config)).toBe(
      'https://stratos.example/service/oauth/boundaries/post',
    )
  })

  it('preserves an explicit room status override', () => {
    expect(
      roomStatusEndpoint({
        serviceUrl: 'https://stratos.example',
        roomStatusEndpoint: 'https://status.example/rooms',
        pdsSpaceUriByRoom: {},
      }),
    ).toBe('https://status.example/rooms')
  })
})

const CORPUS_PATH =
  '../../../test/spaces-alignment/november/fixtures/space-uri-conformance.json'

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, CORPUS_PATH), 'utf8'),
) as {
  spaces: Array<{ name: string; uri: string }>
  invalid: Array<{ name: string; input: string; as: string }>
}

const LEGACY_ROOM_SPACE = `at://did:web:nerv.example/space/zone.stratos.space.feed/tokyo-3`

function configFor(spaces: Record<string, unknown>) {
  return loadClubhouseConfig({
    VITE_CLUBHOUSE_PDS_SPACE_URIS_JSON: JSON.stringify(spaces),
  })
}

describe('Clubhouse room space configuration', () => {
  it.each(corpus.spaces.map((entry) => [entry.name, entry.uri] as const))(
    'keeps a configured space: %s',
    (_name, uri) => {
      const config = configFor({ 'tokyo-3': uri })
      expect(config.pdsSpaceUriByRoom).toEqual({ 'tokyo-3': uri })
      expect(config.pdsSpaceProblemByRoom ?? {}).toEqual({})
    },
  )

  it.each([
    [
      'a custody URI',
      'at://did:web:nerv.example/zone.stratos.space.feed/tokyo-3',
    ],
    ['an earlier-spelling string', LEGACY_ROOM_SPACE],
    ['an empty string', ''],
    [
      'a space record URI',
      'at:space/did:web:nerv.example/zone.stratos.space.feed/tokyo-3/did:plc:rei/zone.stratos.feed.post/eva01',
    ],
    ['a number', 3],
    ['null', null],
  ])(
    'makes the room invalid and names it when the value is %s',
    (_label, value) => {
      const config = configFor({
        'tokyo-3': value,
        bebop: 'at:space/did:web:nerv.example/zone.stratos.space.feed/bebop',
      })
      expect(config.pdsSpaceUriByRoom).toEqual({
        bebop: 'at:space/did:web:nerv.example/zone.stratos.space.feed/bebop',
      })
      expect(config.pdsSpaceProblemByRoom).toEqual({
        'tokyo-3':
          'Posting is not set up for the room "tokyo-3": the space it was given is not a valid space address. Ask whoever runs this Clubhouse to correct it.',
      })
    },
  )

  it.each(
    corpus.invalid
      .filter((entry) => entry.as !== 'record')
      .map((entry) => [entry.name, entry.input] as const),
  )(
    'never keeps a value the corpus rules out as a space: %s',
    (_name, input) => {
      const config = configFor({ 'tokyo-3': input })
      expect(config.pdsSpaceUriByRoom).toEqual({})
      expect(Object.keys(config.pdsSpaceProblemByRoom ?? {})).toEqual([
        'tokyo-3',
      ])
    },
  )

  it('reports nothing when no space map is configured', () => {
    expect(loadClubhouseConfig({}).pdsSpaceUriByRoom).toEqual({})
    expect(loadClubhouseConfig({}).pdsSpaceProblemByRoom ?? {}).toEqual({})
  })
})
