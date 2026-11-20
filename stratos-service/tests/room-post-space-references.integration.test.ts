import http from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { formatRecordUri } from '@northskysocial/stratos-core'
import { createRecord, deleteRecord } from '../src/api/records/index.js'
import {
  handleRoomPost,
  handleRoomPostDelete,
} from '../src/oauth/handlers/room-post.js'
import { buildRoomCatalog } from '../src/oauth/room-catalog.js'
import type { OAuthRoutesConfig } from '../src/oauth/routes.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const POST = 'zone.stratos.feed.post'
const MISATO = 'did:plc:misato-katsuragi'
const ASUKA = 'did:plc:asuka-langley'
const SHINJI = 'did:plc:shinji-ikari'
const POST_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const ROOM_ID = 'nerv-hq'

function spaceRecordUri(author: string, rkey: string): string {
  const formatted = formatRecordUri({
    spaceDid: HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    skey: 'engineering',
    authorDid: author,
    collection: POST,
    rkey,
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
}

const LEGACY_SPACE_PREFIX = `at://${HARNESS_SERVICE_DID}/space/${HOSTED_SPACE_TYPE}/engineering`

const legacySpellingOf = (author: string, rkey: string) =>
  `${LEGACY_SPACE_PREFIX}/${author}/${POST}/${rkey}`

const custodyUriOf = (author: string, rkey: string) =>
  `at://${author}/${POST}/${rkey}`

const reference = (uri: string) => ({ uri, cid: POST_CID })

describe('room posts that reference space records', () => {
  let harness: WriteHarness
  let server: http.Server
  let baseUrl: string
  let caller = MISATO

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    await harness.enrollMember(SHINJI, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
    const { ctx } = harness
    const config = {
      roomCatalog: buildRoomCatalog([
        {
          id: ROOM_ID,
          boundary: HARNESS_ENGINEERING,
          displayName: 'NERV HQ',
          description: 'Operational reports.',
          available: true,
        },
      ]),
      enrollmentStore: ctx.enrollmentStore,
      createApprovedRoomPost: async ({
        did,
        boundary,
        text,
        reply,
      }: {
        did: string
        boundary: string
        text: string
        reply?: unknown
      }) => {
        const result = await createRecord(
          ctx,
          {
            repo: did,
            collection: POST,
            record: {
              $type: POST,
              text,
              ...(reply ? { reply } : {}),
              boundary: {
                $type: 'zone.stratos.boundary.defs#Domains',
                values: [{ value: boundary }],
              },
              createdAt: '1998-10-24T00:00:00.000Z',
            },
          },
          did,
        )
        return { uri: result.uri, cid: result.cid }
      },
      deleteApprovedRoomPost: async ({
        did,
        rkey,
        cid,
      }: {
        did: string
        rkey: string
        cid: string
      }) => {
        await deleteRecord(
          ctx,
          { repo: did, collection: POST, rkey, swapRecord: cid },
          did,
        )
      },
    } as unknown as OAuthRoutesConfig
    const authenticate = async () => caller
    const app = express()
    app.use(express.json())
    app.post('/room-post', handleRoomPost(config, authenticate))
    app.post('/room-post/delete', handleRoomPostDelete(config, authenticate))
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await harness.close()
  })

  afterEach(() => {
    caller = MISATO
  })

  async function send(path: string, body: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  const post = (reply: unknown) =>
    send('/room-post', { roomId: ROOM_ID, text: 'Checking in.', reply })

  const storedReplyOf = async (uri: string) =>
    (await harness.recordRows(uri)).record?.value as {
      reply?: { parent: { uri: string }; root: { uri: string } }
    }

  describe('a reply', () => {
    it('is accepted with space record URIs for root and parent, and stores them as sent', async () => {
      const root = spaceRecordUri(ASUKA, 'bebop')
      const parent = spaceRecordUri(ASUKA, 'swordfish')

      const response = await post({
        root: reference(root),
        parent: reference(parent),
      })

      expect(response.status).toBe(201)
      const stored = await storedReplyOf(response.body.uri)
      expect(stored.reply?.root.uri).toBe(root)
      expect(stored.reply?.parent.uri).toBe(parent)
    })

    it('is accepted with custody record URIs, as before', async () => {
      const root = custodyUriOf(SHINJI, 'eva01')
      const created = await post(undefined)
      expect(created.status).toBe(201)
      const parent = created.body.uri as string

      const response = await post({
        root: reference(root),
        parent: reference(parent),
      })

      expect(response.status).toBe(201)
      const stored = await storedReplyOf(response.body.uri)
      expect(stored.reply?.parent.uri).toBe(parent)
    })

    it.each([
      ['a root in the old spelling', 'root'],
      ['a parent in the old spelling', 'parent'],
    ])('is refused with %s', async (_name, side) => {
      const legacy = reference(legacySpellingOf(ASUKA, 'swordfish'))
      const valid = reference(spaceRecordUri(ASUKA, 'bebop'))

      const response = await post(
        side === 'root'
          ? { root: legacy, parent: valid }
          : { root: valid, parent: legacy },
      )

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRoomPost',
        message: 'A room ID and non-empty text are required',
      })
    })

    it.each([
      ['a space record of another collection', 'zone.stratos.feed.like'],
      ['a space record of a bsky collection', 'app.bsky.feed.post'],
    ])('is refused with %s', async (_name, collection) => {
      const formatted = formatRecordUri({
        spaceDid: HARNESS_SERVICE_DID,
        spaceType: HOSTED_SPACE_TYPE,
        skey: 'engineering',
        authorDid: ASUKA,
        collection,
        rkey: 'swordfish',
      })
      if (!formatted.ok) throw new Error(formatted.error.message)
      const wrong = reference(formatted.value)

      const response = await post({
        root: wrong,
        parent: reference(spaceRecordUri(ASUKA, 'bebop')),
      })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRoomPost' })
    })

    it.each([
      [
        'a custody URI with a fourth part',
        `${custodyUriOf(SHINJI, 'eva01')}/x`,
      ],
      ['a bare string', 'spike spiegel'],
      [
        'a space URI with a fragment',
        `${spaceRecordUri(ASUKA, 'swordfish')}#/text`,
      ],
    ])('is refused with %s', async (_name, uri) => {
      const response = await post({
        root: reference(uri),
        parent: reference(spaceRecordUri(ASUKA, 'bebop')),
      })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRoomPost' })
    })
  })

  describe('a delete', () => {
    it('answers InvalidRoomPostDelete for a space record URI', async () => {
      const response = await send('/room-post/delete', {
        uri: spaceRecordUri(MISATO, 'swordfish'),
        cid: POST_CID,
      })

      expect(response.status).toBe(400)
      expect(response.body).toEqual({
        error: 'InvalidRoomPostDelete',
        message: 'A valid room post URI is required',
      })
    })

    it('answers InvalidRoomPostDelete for the old spelling of a space record', async () => {
      const response = await send('/room-post/delete', {
        uri: legacySpellingOf(MISATO, 'swordfish'),
        cid: POST_CID,
      })

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRoomPostDelete' })
    })

    it('deletes a custody post of the caller, as before', async () => {
      const created = await post(undefined)
      expect(created.status).toBe(201)

      const response = await send('/room-post/delete', {
        uri: created.body.uri,
        cid: created.body.cid,
      })

      expect(response.status).toBe(200)
      expect((await harness.recordRows(created.body.uri)).record).toBeNull()
    })
  })
})
