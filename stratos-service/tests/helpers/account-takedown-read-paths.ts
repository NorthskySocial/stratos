import http from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt, Server as XrpcServer } from '@atproto/xrpc-server'
import {
  ACCOUNT_SUBJECT_TYPE,
  boundaryToSpaceUri,
  parseCid,
  RECORD_SUBJECT_TYPE,
  stratosLexicons,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../../src/context.js'
import { applyEnrollmentHolds } from '../../src/features/enrollment/holds.js'
import {
  CREATE_LABEL_METHOD,
  registerModerationHandlers,
} from '../../src/features/moderation/index.js'
import { createModerationServiceVerifier } from '../../src/infra/auth/verifiers.js'
import { HOSTED_SPACE_TYPE } from '../../src/shared/space-type-registry.js'
import { createSubscribeRecordsHandler } from '../../src/subscription/index.js'
import { createCid } from './test-env.js'
import {
  asMember,
  HARNESS_ENGINEERING,
  type CallAuth,
  type WriteHarness,
  withCredential,
} from './write-harness.js'

const BOUNDARY = HARNESS_ENGINEERING
const POST = 'zone.stratos.feed.post'
const AUTHOR = 'did:plc:shinji-ikari'
const OTHER_AUTHOR = 'did:plc:rei-ayanami'
const VIEWER = 'did:plc:misato-katsuragi'
const SYNC_SERVICE = 'did:web:magi.tokyo.jp'
const STREAM_IDLE_MS = 300
const CASE_TIMEOUT_MS = 120_000

/** Each author's posts; the first one carries an image. */
const POSTS: Record<string, string[]> = {
  [AUTHOR]: ['unit-01', 'unit-02'],
  [OTHER_AUTHOR]: ['unit-00', 'prototype-00'],
}

type Author = typeof AUTHOR | typeof OTHER_AUTHOR

type AuthClass = 'member' | 'space credential' | 'service' | 'anonymous'

/**
 * What a path answers before any takedown: the author's content, nothing of
 * it for this auth class, or repo metadata that no takedown changes.
 */
type Visibility = 'author content' | 'nothing' | 'metadata'

interface ReadPathCase {
  path: string
  auth: AuthClass
  visibility: Visibility
  probe: (author: Author) => Promise<string>
}

interface Fixture {
  harness: WriteHarness
  labels: LabelClient
  space: string
  credential: string
  syncKey: Secp256k1Keypair
  blobs: Map<string, { cid: string; base64: string }>
}

interface LabelClient {
  label(subject: unknown, extra?: Record<string, unknown>): Promise<number>
  close(): Promise<void>
}

const uriOf = (author: string, rkey: string) => `at://${author}/${POST}/${rkey}`

function postText(rkey: string) {
  return `Sortie report ${rkey}`
}

function didDocumentFor(did: string, keypair: Secp256k1Keypair) {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: keypair.did().slice('did:key:'.length),
      },
    ],
  }
}

/** The real createLabel route, called as a moderation service with a local key. */
async function startLabelClient(harness: WriteHarness): Promise<LabelClient> {
  const moderator = await Secp256k1Keypair.create({ exportable: true })
  const ctx: AppContext = {
    ...harness.ctx,
    authVerifier: {
      ...harness.ctx.authVerifier,
      moderationService: createModerationServiceVerifier({
        serviceDid: harness.ctx.serviceDid,
        idResolver: harness.ctx.idResolver,
        allowedIssuers: [moderator.did()],
      }),
    },
  }
  resolveLocally(harness, moderator.did(), moderator)
  const server = new XrpcServer(stratosLexicons)
  registerModerationHandlers(server, ctx)
  const app = express()
  app.use(server.router)
  const listening: http.Server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started))
  })
  const { port } = listening.address() as { port: number }
  return {
    async label(subject, extra = {}) {
      const jwt = await createServiceJwt({
        iss: moderator.did(),
        aud: harness.ctx.serviceDid,
        lxm: CREATE_LABEL_METHOD,
        keypair: moderator,
      })
      const response = await fetch(
        `http://127.0.0.1:${port}/xrpc/${CREATE_LABEL_METHOD}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ subject, val: '!takedown', ...extra }),
        },
      )
      await response.text()
      return response.status
    },
    close: () =>
      new Promise<void>((resolve) => {
        listening.close(() => resolve())
      }),
  }
}

const locallyResolved = new WeakMap<
  WriteHarness,
  Map<string, ReturnType<typeof didDocumentFor> | null>
>()

/**
 * Serves DID documents for local keys, and none for the test members, so no
 * test reaches a real directory. Every other DID goes to the real resolver.
 */
function resolveLocally(
  harness: WriteHarness,
  did: string,
  keypair: Secp256k1Keypair | null,
) {
  let documents = locallyResolved.get(harness)
  if (!documents) {
    const created = new Map<string, ReturnType<typeof didDocumentFor> | null>()
    documents = created
    locallyResolved.set(harness, created)
    const resolver = harness.ctx.idResolver.did
    const original = resolver.resolve.bind(resolver)
    resolver.resolve = async (requested: string, forceRefresh?: boolean) =>
      created.has(requested)
        ? (created.get(requested) ?? null)
        : original(requested, forceRefresh)
  }
  documents.set(did, keypair ? didDocumentFor(did, keypair) : null)
}

/** Stores an image the way the upload handler does, ready for a record to claim. */
async function storeUploadedImage(
  harness: WriteHarness,
  author: string,
  content: string,
): Promise<{ blob: unknown; cid: string; base64: string }> {
  const bytes = new TextEncoder().encode(content)
  const cid = await createCid(bytes)
  const tempKey = await harness.ctx.actorStore
    .getBlobStore(author)
    .putTemp(bytes)
  await harness.ctx.actorStore.transact(author, (store) =>
    store.blob.trackBlob({
      cid,
      mimeType: 'image/png',
      size: bytes.length,
      tempKey,
    }),
  )
  return {
    blob: {
      $type: 'blob',
      ref: { $link: cid.toString() },
      mimeType: 'image/png',
      size: bytes.length,
    },
    cid: cid.toString(),
    base64: Buffer.from(bytes).toString('base64'),
  }
}

async function seedPosts(fixture: Fixture, author: Author) {
  const [first, ...rest] = POSTS[author]
  const image = await storeUploadedImage(
    fixture.harness,
    author,
    `plugsuit telemetry of ${author}`,
  )
  fixture.blobs.set(author, { cid: image.cid, base64: image.base64 })
  for (const rkey of [first, ...rest]) {
    const embed =
      rkey === first
        ? {
            embed: {
              $type: 'zone.stratos.embed.images',
              images: [{ image: image.blob, alt: 'entry plug' }],
            },
          }
        : {}
    const created = await fixture.harness.call(
      'zone.stratos.repo.createRecord',
      asMember(author),
      {
        boundary: BOUNDARY,
        repo: author,
        collection: POST,
        rkey,
        record: {
          $type: POST,
          text: postText(rkey),
          createdAt: '1995-10-04T00:00:00.000Z',
          ...embed,
        },
      },
    )
    expect(created.status).toBe(200)
  }
}

/** Every string that betrays one of the author's records or blobs. */
function authorMarkers(fixture: Fixture, author: Author): string[] {
  const blob = fixture.blobs.get(author)!
  return [...POSTS[author].map(postText), blob.cid, blob.base64]
}

function carriesAuthorContent(
  fixture: Fixture,
  author: Author,
  snapshot: string,
): boolean {
  return authorMarkers(fixture, author).some((marker) =>
    snapshot.includes(marker),
  )
}

function serialize(status: number, body: unknown): string {
  return JSON.stringify({ status, body })
}

async function serviceToken(fixture: Fixture, lxm: string): Promise<CallAuth> {
  const jwt = await createServiceJwt({
    iss: SYNC_SERVICE,
    aud: fixture.harness.ctx.serviceDid,
    lxm,
    keypair: fixture.syncKey,
  })
  return `Bearer ${jwt}`
}

async function authFor(
  fixture: Fixture,
  auth: AuthClass,
  lxm: string,
): Promise<CallAuth> {
  switch (auth) {
    case 'member':
      return asMember(VIEWER)
    case 'space credential':
      return withCredential(fixture.credential)
    case 'service':
      return serviceToken(fixture, lxm)
    case 'anonymous':
      return null
  }
}

async function queryProbe(
  fixture: Fixture,
  nsid: string,
  auth: AuthClass,
  params: Record<string, string>,
): Promise<string> {
  const result = await fixture.harness.query(
    nsid,
    await authFor(fixture, auth, nsid),
    params,
  )
  return serialize(result.status, result.body)
}

async function blobProbe(
  fixture: Fixture,
  nsid: string,
  auth: AuthClass,
  author: Author,
): Promise<string> {
  const header = await authFor(fixture, auth, nsid)
  const params = new URLSearchParams({
    did: author,
    cid: fixture.blobs.get(author)!.cid,
  })
  const response = await fetch(
    `${fixture.harness.baseUrl}/xrpc/${nsid}?${params}`,
    { headers: header ? { authorization: header } : {} },
  )
  const bytes = Buffer.from(await response.arrayBuffer())
  return JSON.stringify({
    status: response.status,
    type: response.headers.get('content-type'),
    body: bytes.toString('base64'),
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reads a sync service's stream of one author until it parks idle. */
async function streamProbe(
  fixture: Fixture,
  author: Author,
  cursor: number,
): Promise<string> {
  const abort = new AbortController()
  const handler = createSubscribeRecordsHandler(fixture.harness.ctx)
  const messages = handler(
    { did: author, cursor },
    { credentials: { type: 'service', iss: SYNC_SERVICE, did: SYNC_SERVICE } },
    abort.signal,
  )
  const frames: unknown[] = []
  for (;;) {
    const pending = messages.next()
    const outcome = await Promise.race([
      pending,
      sleep(STREAM_IDLE_MS).then(() => 'idle' as const),
    ])
    if (outcome === 'idle') {
      abort.abort()
      await pending
      break
    }
    if (outcome.done) break
    frames.push(outcome.value)
  }
  return JSON.stringify(frames, (_key, value: unknown) =>
    value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value,
  )
}

async function firstSequence(fixture: Fixture, author: Author) {
  const ops = await fixture.harness.sequencedOps(author)
  return ops[0].seq
}

function readPathCases(fixture: () => Fixture): ReadPathCase[] {
  const hydrationAuth: AuthClass[] = [
    'member',
    'space credential',
    'service',
    'anonymous',
  ]
  const visibleTo = (auth: AuthClass): Visibility =>
    auth === 'member' || auth === 'space credential'
      ? 'author content'
      : 'nothing'
  return [
    ...hydrationAuth.map((auth): ReadPathCase => ({
      path: 'zone.stratos.repo.hydrateRecord',
      auth,
      visibility: visibleTo(auth),
      probe: (author) =>
        queryProbe(fixture(), 'zone.stratos.repo.hydrateRecord', auth, {
          uri: uriOf(author, POSTS[author][0]),
        }),
    })),
    ...hydrationAuth.map((auth): ReadPathCase => ({
      path: 'zone.stratos.repo.hydrateRecords',
      auth,
      visibility: visibleTo(auth),
      probe: async (author) => {
        const nsid = 'zone.stratos.repo.hydrateRecords'
        const result = await fixture().harness.call(
          nsid,
          await authFor(fixture(), auth, nsid),
          { uris: POSTS[author].map((rkey) => uriOf(author, rkey)) },
        )
        return serialize(result.status, result.body)
      },
    })),
    ...(['member', 'space credential'] as const).map((auth): ReadPathCase => ({
      path: 'zone.stratos.space.getRecord',
      auth,
      visibility: 'author content',
      probe: (author) =>
        queryProbe(fixture(), 'zone.stratos.space.getRecord', auth, {
          space: fixture().space,
          repo: author,
          collection: POST,
          rkey: POSTS[author][0],
        }),
    })),
    ...(['member', 'space credential'] as const).map((auth): ReadPathCase => ({
      path: 'zone.stratos.space.listBlobs',
      auth,
      visibility: 'author content',
      probe: (author) =>
        queryProbe(fixture(), 'zone.stratos.space.listBlobs', auth, {
          space: fixture().space,
          repo: author,
        }),
    })),
    ...['zone.stratos.sync.getBlob', 'com.atproto.sync.getBlob'].flatMap(
      (nsid) =>
        (['member', 'anonymous'] as const).map((auth): ReadPathCase => ({
          path: nsid,
          auth,
          visibility: visibleTo(auth),
          probe: (author) => blobProbe(fixture(), nsid, auth, author),
        })),
    ),
    ...[
      'zone.stratos.sync.listRepoOps',
      'zone.stratos.sync.listRecordPaths',
    ].flatMap((nsid) =>
      (['service', 'space credential'] as const).map((auth): ReadPathCase => ({
        path: nsid,
        auth,
        visibility: 'author content',
        probe: (author) => queryProbe(fixture(), nsid, auth, { did: author }),
      })),
    ),
    {
      path: 'zone.stratos.sync.subscribeRecords from the start',
      auth: 'service',
      visibility: 'author content',
      probe: (author) => streamProbe(fixture(), author, 0),
    },
    {
      path: 'zone.stratos.sync.subscribeRecords from a cursor',
      auth: 'service',
      visibility: 'author content',
      probe: async (author) =>
        streamProbe(fixture(), author, await firstSequence(fixture(), author)),
    },
    ...(['member', 'anonymous'] as const).map((auth): ReadPathCase => ({
      path: 'com.atproto.repo.getRecord',
      auth,
      visibility: visibleTo(auth),
      probe: (author) =>
        queryProbe(fixture(), 'com.atproto.repo.getRecord', auth, {
          repo: author,
          collection: POST,
          rkey: POSTS[author][0],
        }),
    })),
    ...(['member', 'anonymous'] as const).map((auth): ReadPathCase => ({
      path: 'com.atproto.repo.listRecords',
      auth,
      visibility: visibleTo(auth),
      probe: (author) =>
        queryProbe(fixture(), 'com.atproto.repo.listRecords', auth, {
          repo: author,
          collection: POST,
        }),
    })),
    {
      path: 'com.atproto.repo.describeRepo',
      auth: 'anonymous',
      visibility: 'metadata',
      probe: (author) =>
        queryProbe(fixture(), 'com.atproto.repo.describeRepo', 'anonymous', {
          repo: author,
        }),
    },
  ]
}

/**
 * The read-path matrix for an account takedown. On every path and auth class
 * a takedown of the author's account must answer exactly as takedowns of
 * every one of the author's records do, a negation must restore the first
 * answer, an operator hold alone must change nothing, and another author in
 * the same boundary must be untouched throughout.
 */
export function defineAccountTakedownReadPathScenarios(
  backend: string,
  open: () => Promise<WriteHarness>,
  close: () => Promise<void> = async () => {},
) {
  describe(`read paths after an account takedown on ${backend}`, () => {
    let fixture: Fixture

    beforeAll(async () => {
      const harness = await open()
      const syncKey = await Secp256k1Keypair.create({ exportable: true })
      resolveLocally(harness, SYNC_SERVICE, syncKey)
      for (const did of [AUTHOR, OTHER_AUTHOR, VIEWER]) {
        resolveLocally(harness, did, null)
      }
      await harness.enrollMember(AUTHOR, [BOUNDARY])
      await harness.enrollMember(OTHER_AUTHOR, [BOUNDARY])
      await harness.enrollMember(VIEWER, [BOUNDARY])
      await harness.enrollServiceIdentity(SYNC_SERVICE, [BOUNDARY])
      const space = boundaryToSpaceUri(BOUNDARY, HOSTED_SPACE_TYPE)
      if (!space.ok) throw new Error(space.error.message)
      fixture = {
        harness,
        labels: await startLabelClient(harness),
        space: space.value,
        credential: await harness.mintSpaceCredential(VIEWER, BOUNDARY),
        syncKey,
        blobs: new Map(),
      }
      await seedPosts(fixture, AUTHOR)
      await seedPosts(fixture, OTHER_AUTHOR)
    }, CASE_TIMEOUT_MS)

    afterAll(async () => {
      await fixture?.labels.close()
      await fixture?.harness.close()
      await close()
    }, CASE_TIMEOUT_MS)

    // A failed case must not leave the author taken down or held for the next.
    afterEach(async () => {
      await releaseOperatorHold(AUTHOR)
      await negateAccount(AUTHOR)
      await negateRecords(AUTHOR)
    }, CASE_TIMEOUT_MS)

    const recordSubject = (author: Author, rkey: string) => ({
      $type: RECORD_SUBJECT_TYPE,
      uri: uriOf(author, rkey),
    })
    const accountSubject = (author: Author) => ({
      $type: ACCOUNT_SUBJECT_TYPE,
      did: author,
    })

    async function takeDownRecords(author: Author) {
      for (const rkey of POSTS[author]) {
        expect(
          await fixture.labels.label(recordSubject(author, rkey), {
            ref: `case-${rkey}`,
          }),
        ).toBe(200)
      }
    }

    async function negateRecords(author: Author) {
      for (const rkey of POSTS[author]) {
        expect(
          await fixture.labels.label(recordSubject(author, rkey), {
            neg: true,
          }),
        ).toBe(200)
      }
    }

    async function takeDownAccount(author: Author) {
      expect(
        await fixture.labels.label(accountSubject(author), {
          ref: 'case-third-impact',
        }),
      ).toBe(200)
    }

    async function negateAccount(author: Author) {
      expect(
        await fixture.labels.label(accountSubject(author), { neg: true }),
      ).toBe(200)
    }

    async function holdByOperator(author: Author) {
      await applyEnrollmentHolds(fixture.harness.ctx, author, {
        operatorHold: true,
      })
    }

    async function releaseOperatorHold(author: Author) {
      await applyEnrollmentHolds(fixture.harness.ctx, author, {
        operatorHold: false,
      })
    }

    const cases = readPathCases(() => fixture)

    describe.each(cases)('$path as $auth', (readPath) => {
      it(
        'hides the author exactly as record takedowns do, and restores everything after the negation',
        async () => {
          const before = await readPath.probe(AUTHOR)
          const otherBefore = await readPath.probe(OTHER_AUTHOR)
          const expectOtherAuthorUnchanged = async () =>
            expect(await readPath.probe(OTHER_AUTHOR)).toBe(otherBefore)

          await takeDownRecords(AUTHOR)
          const recordTakedown = await readPath.probe(AUTHOR)
          await expectOtherAuthorUnchanged()
          await negateRecords(AUTHOR)
          expect(await readPath.probe(AUTHOR)).toBe(before)

          await takeDownAccount(AUTHOR)
          const accountTakedown = await readPath.probe(AUTHOR)
          await expectOtherAuthorUnchanged()
          expect(accountTakedown).toBe(recordTakedown)

          await negateAccount(AUTHOR)
          expect(await readPath.probe(AUTHOR)).toBe(before)
          await expectOtherAuthorUnchanged()

          switch (readPath.visibility) {
            case 'author content':
              expect(carriesAuthorContent(fixture, AUTHOR, before)).toBe(true)
              expect(
                carriesAuthorContent(fixture, AUTHOR, accountTakedown),
              ).toBe(false)
              expect(
                carriesAuthorContent(fixture, OTHER_AUTHOR, otherBefore),
              ).toBe(true)
              break
            case 'nothing':
              expect(carriesAuthorContent(fixture, AUTHOR, before)).toBe(false)
              break
            case 'metadata':
              expect(accountTakedown).toBe(before)
              break
          }
        },
        CASE_TIMEOUT_MS,
      )

      it(
        'hides nothing while only an operator hold stands',
        async () => {
          const before = await readPath.probe(AUTHOR)
          const otherBefore = await readPath.probe(OTHER_AUTHOR)

          await holdByOperator(AUTHOR)

          expect(await readPath.probe(AUTHOR)).toBe(before)
          expect(await readPath.probe(OTHER_AUTHOR)).toBe(otherBefore)
        },
        CASE_TIMEOUT_MS,
      )
    })

    it(
      'keeps the other author in a batch that also names the taken-down author',
      async () => {
        const nsid = 'zone.stratos.repo.hydrateRecords'
        const uris = [
          ...POSTS[AUTHOR].map((rkey) => uriOf(AUTHOR, rkey)),
          uriOf(OTHER_AUTHOR, POSTS[OTHER_AUTHOR][0]),
        ]
        const batch = async () => {
          const result = await fixture.harness.call(nsid, asMember(VIEWER), {
            uris,
          })
          return serialize(result.status, result.body)
        }

        await takeDownRecords(AUTHOR)
        const recordTakedown = await batch()
        await negateRecords(AUTHOR)
        await takeDownAccount(AUTHOR)
        const accountTakedown = await batch()

        expect(accountTakedown).toBe(recordTakedown)
        expect(
          carriesAuthorContent(fixture, OTHER_AUTHOR, accountTakedown),
        ).toBe(true)
        expect(carriesAuthorContent(fixture, AUTHOR, accountTakedown)).toBe(
          false,
        )
      },
      CASE_TIMEOUT_MS,
    )

    it(
      'refuses a batch blob check for the taken-down author as for one whose records are all taken down',
      async () => {
        const batchAccess = async (author: Author) =>
          Object.fromEntries(
            await fixture.harness.ctx.blobAuth.canAccessBlobs(VIEWER, author, [
              parseCid(fixture.blobs.get(author)!.cid),
            ]),
          )
        const before = await batchAccess(AUTHOR)
        const otherBefore = await batchAccess(OTHER_AUTHOR)

        await takeDownRecords(AUTHOR)
        const recordTakedown = await batchAccess(AUTHOR)
        await negateRecords(AUTHOR)
        await takeDownAccount(AUTHOR)
        const accountTakedown = await batchAccess(AUTHOR)
        const otherDuringTakedown = await batchAccess(OTHER_AUTHOR)
        await negateAccount(AUTHOR)

        expect(Object.values(before)).toEqual([true])
        expect(accountTakedown).toEqual(recordTakedown)
        expect(Object.values(accountTakedown)).toEqual([false])
        expect(otherDuringTakedown).toEqual(otherBefore)
        expect(await batchAccess(AUTHOR)).toEqual(before)
      },
      CASE_TIMEOUT_MS,
    )

    describe.each(['service', 'space credential'] as const)(
      'zone.stratos.space.listRepos as %s',
      (auth) => {
        const listedRepos = async () => {
          const nsid = 'zone.stratos.space.listRepos'
          const result = await fixture.harness.query(
            nsid,
            await authFor(fixture, auth, nsid),
            { space: fixture.space },
          )
          expect(result.status).toBe(200)
          return (result.body as { repos: Array<{ did: string }> }).repos
            .map((repo) => repo.did)
            .sort()
        }

        it(
          'lists only active members, so a taken-down or operator-held author drops out and returns',
          async () => {
            const everyone = await listedRepos()
            expect(everyone).toEqual(
              expect.arrayContaining([AUTHOR, OTHER_AUTHOR]),
            )
            const withoutAuthor = everyone.filter((did) => did !== AUTHOR)

            await takeDownRecords(AUTHOR)
            expect(await listedRepos()).toEqual(everyone)
            await negateRecords(AUTHOR)

            await takeDownAccount(AUTHOR)
            expect(await listedRepos()).toEqual(withoutAuthor)
            await negateAccount(AUTHOR)
            expect(await listedRepos()).toEqual(everyone)

            await holdByOperator(AUTHOR)
            expect(await listedRepos()).toEqual(withoutAuthor)
            await releaseOperatorHold(AUTHOR)
            expect(await listedRepos()).toEqual(everyone)
          },
          CASE_TIMEOUT_MS,
        )
      },
    )

    describe('zone.stratos.sync.getRepo', () => {
      const exportAs = async (caller: string) => {
        const response = await fetch(
          `${fixture.harness.baseUrl}/xrpc/zone.stratos.sync.getRepo?did=${encodeURIComponent(AUTHOR)}`,
          { headers: { authorization: asMember(caller) as string } },
        )
        const body = Buffer.from(await response.arrayBuffer())
        return { status: response.status, body }
      }

      it(
        'refuses a held owner under a takedown and an operator hold alike, and never serves another member',
        async () => {
          const ownExport = await exportAs(AUTHOR)
          expect(ownExport.status).toBe(200)
          expect((await exportAs(VIEWER)).status).toBe(400)

          // The dev-mode verifier lets the held owner's enrollment error
          // escape as a 500; DPoP maps it to NotEnrolled. Either way no CAR.
          await takeDownAccount(AUTHOR)
          const takenDown = await exportAs(AUTHOR)
          expect(takenDown.status).not.toBe(200)
          expect(takenDown.body).not.toEqual(ownExport.body)
          expect((await exportAs(VIEWER)).status).toBe(400)
          await negateAccount(AUTHOR)
          expect((await exportAs(AUTHOR)).body).toEqual(ownExport.body)

          await holdByOperator(AUTHOR)
          expect((await exportAs(AUTHOR)).body).toEqual(takenDown.body)
        },
        CASE_TIMEOUT_MS,
      )
    })
  })
}
