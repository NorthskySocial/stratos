import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  formatRecordUri,
  RECORD_SUBJECT_TYPE,
} from '@northskysocial/stratos-core'
import { resolveHiddenUris } from '../src/subscription/takedown-filter.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  HARNESS_ENGINEERING,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  startModerationRoute,
  type ModerationRoute,
} from './helpers/moderation-route.js'

const POST = 'zone.stratos.feed.post'
const MISATO = 'did:plc:misato-katsuragi'
const ASUKA = 'did:plc:asuka-langley'
const LABELLER = 'did:plc:gendo-ikari'
const CREATED_AT = '1998-10-24T00:00:00.000Z'

const spaceRecordUri = (() => {
  const formatted = formatRecordUri({
    spaceDid: HARNESS_SERVICE_DID,
    spaceType: HOSTED_SPACE_TYPE,
    skey: 'engineering',
    authorDid: ASUKA,
    collection: POST,
    rkey: 'swordfish',
  })
  if (!formatted.ok) throw new Error(formatted.error.message)
  return formatted.value
})()

const LEGACY_SPACE_RECORD_URI = `at://${HARNESS_SERVICE_DID}/space/${HOSTED_SPACE_TYPE}/engineering/${ASUKA}/${POST}/swordfish`

const recordSubject = (uri: string) => ({ $type: RECORD_SUBJECT_TYPE, uri })

describe('moderation of a space record by its spelling', () => {
  let harness: WriteHarness
  let route: ModerationRoute

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    await harness.enrollPdsCustodyMember(ASUKA, [HARNESS_ENGINEERING])
    route = await startModerationRoute(harness)
  })

  afterAll(async () => {
    await route.close()
    await harness.close()
  })

  describe('createLabel', () => {
    it('refuses a record subject in the old spelling', async () => {
      const response = await route.createLabel(
        recordSubject(LEGACY_SPACE_RECORD_URI),
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRequest' })
      expect(
        await harness.ctx.labelStore.latestForSubject(LEGACY_SPACE_RECORD_URI),
      ).toBeUndefined()
    })

    it('labels a record subject in the new form under the submitted string', async () => {
      const response = await route.createLabel(recordSubject(spaceRecordUri))

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        label: { subject: { uri: spaceRecordUri } },
      })
      expect(
        (await harness.ctx.labelStore.latestForSubject(spaceRecordUri))
          ?.subjectKey,
      ).toBe(spaceRecordUri)
    })
  })

  describe('queryLabels', () => {
    it('refuses the old spelling as a subject filter', async () => {
      const response = await route.queryLabels(
        new URLSearchParams({ subjects: LEGACY_SPACE_RECORD_URI }),
      )

      expect(response.status).toBe(400)
      expect(response.body).toMatchObject({ error: 'InvalidRequest' })
    })
  })

  describe('a label log row keyed by the old spelling', () => {
    const newFormOf = (rkey: string) =>
      spaceRecordUri.replace('swordfish', rkey)
    const legacyFormOf = (rkey: string) =>
      LEGACY_SPACE_RECORD_URI.replace('swordfish', rkey)

    async function appendRow(subjectKey: string): Promise<void> {
      const appended = await harness.ctx.labelStore.appendIfLatest(null, {
        subjectKey,
        subjectKind: 'record',
        val: '!takedown',
        neg: false,
        boundaries: [HARNESS_ENGINEERING],
        createdBy: LABELLER,
        createdAt: CREATED_AT,
      })
      expect(appended.kind).toBe('appended')
    }

    it('is returned as stored by a log query, without an error', async () => {
      await appendRow(legacyFormOf('bebop'))

      const response = await route.queryLabels(new URLSearchParams())

      expect(response.status).toBe(200)
      const { labels } = response.body as {
        labels: Array<{ subject: { uri?: string } }>
      }
      expect(
        labels.find((label) => label.subject.uri === legacyFormOf('bebop')),
      ).toMatchObject({
        subject: { $type: RECORD_SUBJECT_TYPE, uri: legacyFormOf('bebop') },
        val: '!takedown',
        neg: false,
        createdAt: CREATED_AT,
      })
    })

    it('is not returned for the same record in the new form', async () => {
      await appendRow(legacyFormOf('hammerhead'))

      const latest = await harness.ctx.labelStore.latestForSubject(
        newFormOf('hammerhead'),
      )
      const filtered = await route.queryLabels(
        new URLSearchParams({ subjects: newFormOf('hammerhead') }),
      )

      expect(latest).toBeUndefined()
      expect(filtered.status).toBe(200)
      expect((filtered.body as { labels: unknown[] }).labels).toEqual([])
    })

    it('hides only the key it is stored under from the takedown filter', async () => {
      await appendRow(legacyFormOf('tank'))

      const hidden = await resolveHiddenUris(
        harness.ctx,
        MISATO,
        new Set([newFormOf('tank'), legacyFormOf('tank')]),
      )

      expect([...hidden]).toEqual([legacyFormOf('tank')])
    })
  })
})
