/**
 * Credential presentation on the real routes: the in-process service with real
 * stores and real auth verifiers, driven over HTTP. Each route that accepts a
 * space credential takes the tagged `Atproto-Space-Credential` presentation
 * for the right audience, and refuses a wrong audience, a wrong key, the old
 * scheme, a missing tag, an exchange proof and a presentation that carries a
 * DPoP header. The mint route refuses a presentation proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { P256Keypair } from '@atproto/crypto'
import { boundaryToSpaceUri } from '@northskysocial/stratos-core'
import { mintSpaceHttpCredential } from '../src/features/space-credential/minter.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_LEADERSHIP,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'
import {
  PRESENTATION_COMPONENTS,
  signPresentation,
} from './helpers/space-presentation.js'

const POST = 'zone.stratos.feed.post'
const MISATO = 'did:plc:misato-katsuragi'
const REI = 'did:plc:rei-ayanami'
const MINT = 'zone.stratos.space.getSpaceCredential'

function spaceUriOf(boundary: string): string {
  const space = boundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)
  if (!space.ok) throw new Error(space.error.message)
  return space.value
}

const ENGINEERING_SPACE = spaceUriOf(HARNESS_ENGINEERING)
const DESIGN_SPACE = spaceUriOf(HARNESS_DESIGN)
const LEADERSHIP_SPACE = spaceUriOf(HARNESS_LEADERSHIP)

interface ReadRoute {
  name: string
  nsid: string
  query: Record<string, string>
  audience: string
  /** Pull-sync routes answer a foreign-space credential with a filtered page. */
  foreignSpace: 'refused' | 'filtered'
}

const READ_ROUTES: ReadRoute[] = [
  {
    name: 'getRecord (standardOrSpaceCredential)',
    nsid: 'zone.stratos.space.getRecord',
    query: {
      space: ENGINEERING_SPACE,
      repo: MISATO,
      collection: POST,
      rkey: 'eva01',
    },
    audience: MISATO,
    foreignSpace: 'refused',
  },
  {
    name: 'listBlobs (standardOrSpaceCredential)',
    nsid: 'zone.stratos.space.listBlobs',
    query: { space: ENGINEERING_SPACE, repo: MISATO },
    audience: MISATO,
    foreignSpace: 'refused',
  },
  {
    name: 'listRepos (serviceOrSpaceCredential)',
    nsid: 'zone.stratos.space.listRepos',
    query: { space: ENGINEERING_SPACE },
    audience: HARNESS_SERVICE_DID,
    foreignSpace: 'refused',
  },
  {
    name: 'listRepoOps (serviceOrSpaceCredential)',
    nsid: 'zone.stratos.sync.listRepoOps',
    query: { did: MISATO },
    audience: MISATO,
    foreignSpace: 'filtered',
  },
  {
    name: 'listRecordPaths (serviceOrSpaceCredential)',
    nsid: 'zone.stratos.sync.listRecordPaths',
    query: { did: MISATO },
    audience: MISATO,
    foreignSpace: 'filtered',
  },
]

describe('space credential presentation on the routes', () => {
  let harness: WriteHarness
  let key: P256Keypair

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    await harness.enrollMember(MISATO, [HARNESS_ENGINEERING])
    const created = await harness.call(
      'zone.stratos.repo.createRecord',
      asMember(MISATO),
      {
        boundary: HARNESS_ENGINEERING,
        repo: MISATO,
        collection: POST,
        rkey: 'eva01',
        record: {
          $type: POST,
          text: 'sortie',
          createdAt: '1998-10-24T00:00:00.000Z',
        },
      },
    )
    expect(created.status).toBe(200)
    key = await P256Keypair.create()
  }, 60_000)

  afterAll(async () => {
    await harness.close()
  })

  async function credentialFor(
    boundary: string,
    space: string,
    boundKey: P256Keypair = key,
  ): Promise<string> {
    const definition = await harness.ctx.boundaryStore?.get(boundary)
    const { credential } = await mintSpaceHttpCredential({
      signingKey: harness.ctx.signingKey,
      issuerDid: harness.ctx.serviceDid,
      spaceUri: space,
      keyId: boundKey.did(),
      ttlSeconds: 600,
      boundaryRevision: definition?.revision,
    })
    return credential
  }

  async function read(
    route: ReadRoute,
    headers: Record<string, string>,
    query: Record<string, string> = route.query,
  ) {
    const response = await fetch(
      `${harness.baseUrl}/xrpc/${route.nsid}?${new URLSearchParams(query)}`,
      { headers },
    )
    return { status: response.status, body: await response.text() }
  }

  describe.each(READ_ROUTES)('$name', (route) => {
    const presented = async (audience = route.audience) =>
      signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience,
      })

    it('accepts a tagged presentation for the right audience', async () => {
      const result = await read(route, await presented())
      expect(result.status).toBe(200)
    })

    it('accepts the presentation under another label', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: route.audience,
        label: 'faye',
      })
      expect((await read(route, headers)).status).toBe(200)
    })

    it('refuses the wrong audience', async () => {
      const result = await read(route, await presented(REI))
      expect(result.status).toBe(401)
    })

    it('refuses a signature by a key the credential is not bound to', async () => {
      const other = await P256Keypair.create()
      const headers = await signPresentation({
        key: other,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: route.audience,
      })
      expect((await read(route, headers)).status).toBe(401)
    })

    it('refuses the old scheme beside an otherwise valid tagged signature', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: route.audience,
      })
      expect((await read(route, headers)).status).toBe(401)
    })

    it('refuses the old scheme even when it is signed as the old profile did', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: route.audience,
        label: 'atproto-space',
        parameters: PRESENTATION_COMPONENTS,
      })
      expect((await read(route, headers)).status).toBe(401)
    })

    it('refuses a signature with no tag', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: route.audience,
        parameters: PRESENTATION_COMPONENTS,
      })
      expect((await read(route, headers)).status).toBe(401)
    })

    it('refuses an exchange proof carrying the credential', async () => {
      const authorization = `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`
      const parameters = `("authorization");keyid="${key.did()}"`
      const signature = await key.sign(
        new TextEncoder().encode(
          `"authorization": ${authorization}\n"@signature-params": ${parameters}`,
        ),
      )
      const headers = {
        authorization,
        'atproto-space-audience': route.audience,
        'signature-input': `atproto-space=${parameters}`,
        signature: `atproto-space=:${Buffer.from(signature).toString('base64')}:`,
      }
      expect((await read(route, headers)).status).toBe(401)
    })

    it('refuses an exchange proof under the Bearer scheme', async () => {
      const authorization = `Bearer ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`
      const parameters = `("authorization");keyid="${key.did()}"`
      const signature = await key.sign(
        new TextEncoder().encode(
          `"authorization": ${authorization}\n"@signature-params": ${parameters}`,
        ),
      )
      const headers = {
        authorization,
        'signature-input': `atproto-space=${parameters}`,
        signature: `atproto-space=:${Buffer.from(signature).toString('base64')}:`,
      }
      expect((await read(route, headers)).status).toBe(401)
    })

    it('refuses a presentation that also carries a DPoP header', async () => {
      const headers = { ...(await presented()), dpop: 'eyJ.rei.nerv' }
      expect((await read(route, headers)).status).toBe(401)
    })

    it('refuses a credential signed by a key that is not the service key', async () => {
      const impostor = await P256Keypair.create()
      const definition =
        await harness.ctx.boundaryStore?.get(HARNESS_ENGINEERING)
      const { credential } = await mintSpaceHttpCredential({
        signingKey: impostor,
        issuerDid: harness.ctx.serviceDid,
        spaceUri: ENGINEERING_SPACE,
        keyId: key.did(),
        ttlSeconds: 600,
        boundaryRevision: definition?.revision,
      })
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${credential}`,
        audience: route.audience,
      })
      expect((await read(route, headers)).status).toBe(401)
    })

    it('accepts a scheme written in mixed case when signed as written', async () => {
      const headers = await signPresentation({
        key,
        authorization: `aTpRoTo-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: route.audience,
      })
      expect((await read(route, headers)).status).toBe(200)
    })

    it('refuses an authorization value changed after signing', async () => {
      const credential = await credentialFor(
        HARNESS_ENGINEERING,
        ENGINEERING_SPACE,
      )
      const signed = await presented()
      const last = credential.slice(-1)
      const swapped = credential.slice(0, -1) + (last === 'A' ? 'B' : 'A')
      expect(
        (
          await read(route, {
            ...signed,
            authorization: `Atproto-Space-Credential ${swapped}`,
          })
        ).status,
      ).toBe(401)
    })

    it('refuses a scheme whose case was changed after signing', async () => {
      const credential = await credentialFor(
        HARNESS_ENGINEERING,
        ENGINEERING_SPACE,
      )
      const signed = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${credential}`,
        audience: route.audience,
      })
      expect((await read(route, signed)).status).toBe(200)
      expect(
        (
          await read(route, {
            ...signed,
            authorization: `atproto-space-credential ${credential}`,
          })
        ).status,
      ).toBe(401)
    })

    it('gives a credential for another space nothing of this one', async () => {
      await harness.enrollBoundaryHolder(REI, [HARNESS_DESIGN])
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_DESIGN, DESIGN_SPACE)}`,
        audience: route.audience,
      })
      const result = await read(route, headers)
      if (route.foreignSpace === 'refused') {
        expect(result.status).not.toBe(200)
      } else {
        expect(result.status).toBe(200)
        expect(result.body).not.toContain('eva01')
        expect((await read(route, await presented())).body).toContain('eva01')
      }
    })
  })

  describe('a boundary that is no longer active', () => {
    it('refuses a presentation for it on every route', async () => {
      await harness.enrollBoundaryHolder(REI, [HARNESS_LEADERSHIP])
      const credential = await credentialFor(
        HARNESS_LEADERSHIP,
        LEADERSHIP_SPACE,
      )
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${credential}`,
        audience: HARNESS_SERVICE_DID,
      })
      const listRepos = READ_ROUTES[2]
      const query = { space: LEADERSHIP_SPACE }
      expect((await read(listRepos, headers, query)).status).toBe(200)

      const definition =
        await harness.ctx.boundaryStore!.get(HARNESS_LEADERSHIP)
      await harness.ctx.boundaryStore!.beginDeactivation(
        HARNESS_LEADERSHIP,
        definition!.revision,
      )

      expect((await read(listRepos, headers, query)).status).toBe(401)
    })
  })

  describe('the hydration routes', () => {
    it('refuse a standard presentation, as before: they offer no repo audience', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: MISATO,
      })
      const single = await fetch(
        `${harness.baseUrl}/xrpc/zone.stratos.repo.hydrateRecord?uri=${encodeURIComponent(`at://${MISATO}/${POST}/eva01`)}`,
        { headers },
      )
      expect(single.status).toBe(401)
      const batch = await fetch(
        `${harness.baseUrl}/xrpc/zone.stratos.repo.hydrateRecords`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ uris: [`at://${MISATO}/${POST}/eva01`] }),
        },
      )
      expect(batch.status).toBe(401)
    })
  })

  describe('the hydration routes with an optional verifier', () => {
    const PRIVATE_URI = `at://${MISATO}/${POST}/eva01`
    const SINGLE = `${'zone.stratos.repo.hydrateRecord'}?uri=${encodeURIComponent(PRIVATE_URI)}`
    const BATCH = 'zone.stratos.repo.hydrateRecords'

    async function hydrate(headers: Record<string, string>) {
      const single = await fetch(`${harness.baseUrl}/xrpc/${SINGLE}`, {
        headers,
      })
      const batch = await fetch(`${harness.baseUrl}/xrpc/${BATCH}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ uris: [PRIVATE_URI] }),
      })
      return {
        single: { status: single.status, body: await single.text() },
        batch: { status: batch.status, body: await batch.text() },
      }
    }

    function expectNothingPrivate(result: Awaited<ReturnType<typeof hydrate>>) {
      expect(result.single.body).not.toContain('sortie')
      expect(result.batch.body).not.toContain('sortie')
      const records = (JSON.parse(result.batch.body) as { records?: unknown[] })
        .records
      expect(records ?? []).toHaveLength(0)
      expect(result.single.body).toContain('RecordBlocked')
      expect(result.batch.body).toContain('"blocked":["' + PRIVATE_URI + '"]')
    }

    it('(a) answers an anonymous request with nothing private', async () => {
      const result = await hydrate({})
      expect(result.single.status).toBe(400)
      expect(result.batch.status).toBe(200)
      expectNothingPrivate(result)
    })

    it('(b) treats an unknown scheme as anonymous', async () => {
      const result = await hydrate({ authorization: 'Nerv rei' })
      expect(result.single.status).toBe(400)
      expect(result.batch.status).toBe(200)
      expectNothingPrivate(result)
    })

    it('(c) treats the old scheme as anonymous, signed as the old profile did', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: MISATO,
        label: 'atproto-space',
        parameters: PRESENTATION_COMPONENTS,
      })
      const result = await hydrate(headers)
      expect(result.single.status).toBe(400)
      expect(result.batch.status).toBe(200)
      expectNothingPrivate(result)
    })

    it('(d) refuses the new scheme with a valid tagged signature', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: MISATO,
      })
      const result = await hydrate(headers)
      expect(result.single.status).toBe(401)
      expect(result.batch.status).toBe(401)
    })
  })

  describe(`the mint route ${MINT}`, () => {
    it('refuses a presentation proof', async () => {
      const headers = await signPresentation({
        key,
        authorization: `Atproto-Space-Credential ${await credentialFor(HARNESS_ENGINEERING, ENGINEERING_SPACE)}`,
        audience: HARNESS_SERVICE_DID,
      })
      const response = await fetch(`${harness.baseUrl}/xrpc/${MINT}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ space: ENGINEERING_SPACE }),
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(await response.text()).not.toContain('"credential"')
    })
  })
})
