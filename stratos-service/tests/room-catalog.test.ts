import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InvalidRoomCatalogError,
  loadRoomCatalog,
} from '../src/oauth/room-catalog.js'
import { handleRooms } from '../src/oauth/handlers/rooms.js'
import type { OAuthRoutesConfig } from '../src/oauth/routes.js'

const ALLOWED = [
  'did:web:stratos.example/general',
  'did:web:stratos.example/nebula',
  'did:web:stratos.example/after-school',
]
let temporaryDirectories: string[] = []

function catalogFile(contents: string, extension = 'yaml'): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratos-room-catalog-'))
  temporaryDirectories.push(dir)
  const path = join(dir, `rooms.${extension}`)
  writeFileSync(path, contents)
  return path
}

describe('room catalogue', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
    temporaryDirectories = []
  })

  it('loads complete canonical operator rooms', () => {
    const catalog = loadRoomCatalog(
      catalogFile(`feeds:
  - id: nebula
    boundary: did:web:stratos.example/nebula
    displayName: Nebula
    description: Cowboy Bebop night shift.
`),
      ALLOWED,
    )

    expect(catalog.get('nebula')).toEqual({
      id: 'nebula',
      boundary: 'did:web:stratos.example/nebula',
      displayName: 'Nebula',
      description: 'Cowboy Bebop night shift.',
      available: true,
    })
  })

  it('loads JSON and keeps its public snapshots isolated', () => {
    const catalog = loadRoomCatalog(
      catalogFile(
        JSON.stringify({
          feeds: [
            {
              id: 'after-school',
              boundary: 'did:web:stratos.example/after-school',
              displayName: 'After School',
              description: 'Utena discussion club.',
            },
          ],
        }),
        'json',
      ),
      ALLOWED,
    )

    const firstSnapshot = catalog.list()
    const listedRoom = firstSnapshot[0]
    firstSnapshot.pop()

    expect(catalog.list()).toHaveLength(1)
    expect(catalog.get('after-school')).toEqual(listedRoom)
  })

  it('keeps unavailable rooms visible in the public catalogue', () => {
    const catalog = loadRoomCatalog(
      catalogFile(`feeds:
  - id: unavailable
    boundary: did:web:stratos.example/after-school
    displayName: Unavailable
    description: Temporarily closed.
    available: false
`),
      ALLOWED,
    )

    expect(catalog.get('unavailable')).toEqual(
      expect.objectContaining({ available: false }),
    )
  })

  it('rejects incomplete, duplicate, and non-canonical rooms', () => {
    expect(() =>
      loadRoomCatalog(
        catalogFile(`feeds:
  - id: rei
    boundary: did:web:stratos.example/nebula
    displayName: ''
    description: Eva pilots
`),
        ALLOWED,
      ),
    ).toThrow(/displayName is required/)

    expect(() =>
      loadRoomCatalog(
        catalogFile(`feeds:
  - id: rei
    boundary: did:web:stratos.example/nebula
    displayName: Rei
    description: Eva pilots
  - id: asuka
    boundary: did:web:stratos.example/nebula
    displayName: Asuka
    description: Eva pilots
`),
        ALLOWED,
      ),
    ).toThrow(/Duplicate room boundary/)

    expect(() =>
      loadRoomCatalog(
        catalogFile(`feeds:
  - id: rei
    boundary: did:web:stratos.example/nebula
    displayName: Rei
    description: Eva pilots
  - id: rei
    boundary: did:web:stratos.example/after-school
    displayName: Rei Again
    description: Another Eva club
`),
        ALLOWED,
      ),
    ).toThrow(/Duplicate room id/)

    expect(() =>
      loadRoomCatalog(
        catalogFile(`feeds:
  - id: lupin
    boundary: example.com/not-canonical
    displayName: Lupin
    description: The third.
`),
        ALLOWED,
      ),
    ).toThrow(/not an allowed Stratos boundary/)

    expect(() =>
      loadRoomCatalog(catalogFile('{ not yaml', 'txt'), ALLOWED),
    ).toThrow(/Unsupported room catalog extension/)

    expect(() => loadRoomCatalog(catalogFile('rooms: []'), ALLOWED)).toThrow(
      /must be an object with a "feeds" array/,
    )

    expect(() =>
      loadRoomCatalog(
        catalogFile(`feeds:
  - id: invalid
    boundary: did:web:stratos.example/nebula
    displayName: Invalid
    description: Invalid availability.
    available: sometimes
`),
        ALLOWED,
      ),
    ).toThrow(/available must be a boolean/)
  })

  it('reports an unreadable operator catalogue as a typed configuration error', () => {
    const missingFile = catalogFile('feeds: []')
    rmSync(missingFile)

    expect(() => loadRoomCatalog(missingFile, ALLOWED)).toThrow(
      InvalidRoomCatalogError,
    )
  })

  it('returns the public approved catalogue from GET /oauth/boundaries', () => {
    const catalog = loadRoomCatalog(
      catalogFile(`feeds:
  - id: bebop
    boundary: did:web:stratos.example/nebula
    displayName: Bebop
    description: Space westerns.
`),
      ALLOWED,
    )
    const json = vi.fn()
    const config = { roomCatalog: catalog } as OAuthRoutesConfig
    const handler = handleRooms(config) as unknown as (
      request: object,
      response: { json: (body: unknown) => void },
    ) => void
    handler({}, { json })
    expect(json).toHaveBeenCalledWith({
      rooms: [
        {
          id: 'bebop',
          displayName: 'Bebop',
          description: 'Space westerns.',
          available: true,
        },
      ],
    })
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('boundary')
  })

  it('fails closed when GET /oauth/boundaries has no operator catalogue', () => {
    const status = vi.fn()
    status.mockReturnThis()
    const json = vi.fn()
    const config = { roomCatalog: undefined } as OAuthRoutesConfig
    const handler = handleRooms(config) as unknown as (
      request: object,
      response: {
        status: (code: number) => unknown
        json: (body: unknown) => void
      },
    ) => void

    handler({}, { status, json })

    expect(status).toHaveBeenCalledWith(503)
    expect(json).toHaveBeenCalledWith({
      error: 'RoomCatalogUnavailable',
      message: 'Room listing is not configured for this service',
    })
  })
})
