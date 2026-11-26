import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AppContext } from '../src/context.js'
import {
  authorizeRecordBoundary,
  createRecord,
  updateRecord,
} from '../src/api/records/index.js'
import {
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

describe('Legacy writes with validate: false still apply the Stratos rules', () => {
  let harness: WriteHarness
  let ctx: AppContext

  const testDid = 'did:plc:shinji-ikari'
  const heldDomain = 'did:web:nerv.tokyo.jp/engineering'
  const leadershipDomain = 'did:web:nerv.tokyo.jp/leadership'
  const unlistedDomain = 'did:web:nerv.tokyo.jp/instrumentality'
  const foreignDomain = 'did:web:seele.example/instrumentality'
  const collection = 'zone.stratos.feed.post'
  const ownedRkey = 'unit-01-sortie'
  const ownedPostUri = `at://${testDid}/${collection}/${ownedRkey}`
  const publicPostUri =
    'at://did:plc:misato-katsuragi/app.bsky.feed.post/cross-namespace'
  // A parent in an existing repo, so parent resolution succeeds and the
  // namespace rule is the one that rejects.
  const publicPostInOwnRepoUri = `at://${testDid}/app.bsky.feed.post/cross-namespace`

  function postWith(values: string[] | undefined, extra = {}) {
    return {
      $type: collection,
      text: 'Get in the robot.',
      createdAt: new Date().toISOString(),
      ...(values && {
        boundary: {
          $type: 'zone.stratos.boundary.defs#Domains',
          values: values.map((value) => ({ value })),
        },
      }),
      ...extra,
    }
  }

  function replyTo(parentUri: string) {
    return {
      reply: {
        parent: { uri: parentUri, cid: 'bafyparent' },
        root: { uri: parentUri, cid: 'bafyparent' },
      },
    }
  }

  const publicEmbed = {
    embed: {
      $type: 'app.bsky.embed.record',
      record: { uri: publicPostUri, cid: 'bafyembedded' },
    },
  }

  const writePaths = {
    create: (record: unknown, validate: boolean) =>
      createRecord(
        ctx,
        { repo: testDid, collection, rkey: 'new-post', record, validate },
        testDid,
      ),
    update: (record: unknown, validate: boolean) =>
      updateRecord(
        ctx,
        { repo: testDid, collection, rkey: ownedRkey, record, validate },
        testDid,
      ),
  }

  beforeEach(async () => {
    harness = await startSqliteWriteHarness()
    ctx = harness.ctx
    await harness.enrollMember(testDid, [heldDomain, leadershipDomain])
    await createRecord(
      ctx,
      {
        repo: testDid,
        collection,
        rkey: ownedRkey,
        record: postWith([heldDomain]),
      },
      testDid,
    )
  })

  afterEach(async () => {
    await harness.close()
  })

  describe.each(Object.entries(writePaths))('%s', (_path, write) => {
    it('rejects a domain outside allowedDomains', async () => {
      await expect(
        write(postWith([unlistedDomain]), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects a reply whose boundary is not a subset of its parent boundary', async () => {
      await expect(
        write(postWith([leadershipDomain], replyTo(ownedPostUri)), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects a reply that crosses namespaces', async () => {
      await expect(
        write(postWith([heldDomain], replyTo(publicPostInOwnRepoUri)), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects an embed that crosses namespaces', async () => {
      await expect(
        write(postWith([heldDomain], publicEmbed), false),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it('rejects the same records with the same code when validate is true', async () => {
      await expect(
        write(postWith([unlistedDomain]), true),
      ).rejects.toMatchObject({ error: 'InvalidRecord' })
    })

    it.each([true, false])(
      'accepts a record that fails only lexicon validation (validate: %s)',
      async (validate) => {
        const lexiconInvalid = postWith([heldDomain], {
          createdAt: 'not-a-datetime',
        })

        await expect(write(lexiconInvalid, validate)).resolves.toMatchObject({
          uri: expect.stringContaining(collection),
        })
      },
    )

    it('accepts a valid record with validate: false', async () => {
      await expect(write(postWith([heldDomain]), false)).resolves.toMatchObject(
        { uri: expect.stringContaining(collection) },
      )
    })
  })

  describe('authorizeRecordBoundary error codes', () => {
    it('rejects a boundary of another service with ServiceMismatch', async () => {
      await expect(
        authorizeRecordBoundary(
          ctx,
          testDid,
          collection,
          postWith([foreignDomain]),
        ),
      ).rejects.toMatchObject({ error: 'ServiceMismatch' })
    })
  })
})
