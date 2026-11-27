/**
 * Who may mint a space credential, on the real mint route: the in-process
 * service with real stores and real auth verifiers, driven over HTTP with a
 * signed delegation. A member under an operator hold, under an account
 * takedown or under both is refused `NotEnrolled`, and minting works again
 * once the holds are lifted. A service enrollment mints exactly as a member
 * does. A mint refused for membership spends neither the delegation nor the client
 * attestation. A credential minted before a hold stays accepted on a read
 * route until it expires: presentation checks the credential, not the member.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto'
import type { Keypair } from '@atproto/crypto'
import { boundaryToSpaceUri } from '@northskysocial/stratos-core'
import { DELEGATION_TYP } from '../src/infra/auth/delegation-verifier.js'
import type { NxExStore } from '../src/infra/auth/replay-store.js'
import { ADMIN_SESSION_COOKIE } from '../src/oauth/admin-routes.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  buildAccountLabelHarness,
  catalogDefinition,
  type AccountLabelHarness,
  type HoldsBackend,
} from './helpers/enrollment-holds.js'
import {
  makeClient,
  mintAttestation,
  resolverFor,
} from './helpers/attestation.js'
import { signPresentation } from './helpers/space-presentation.js'
import {
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_LEADERSHIP,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  type WriteHarness,
} from './helpers/write-harness.js'

const MINT_NSID = 'zone.stratos.space.getSpaceCredential'
const LIST_REPOS_NSID = 'zone.stratos.space.listRepos'
const ADMIN_DID = 'did:plc:gendo-ikari'
const ADMIN_SESSION_LIFETIME_MS = 600_000
const FROZEN_NOW = new Date('1998-10-24T09:00:00.000Z')

function spaceUriOf(boundary: string): string {
  const space = boundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)
  if (!space.ok) throw new Error(space.error.message)
  return space.value
}

const ENGINEERING_SPACE = spaceUriOf(HARNESS_ENGINEERING)
const LEADERSHIP_SPACE = spaceUriOf(HARNESS_LEADERSHIP)

class MemoryNxExStore implements NxExStore {
  private readonly seen = new Set<string>()
  async setNxEx(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}

interface Identity {
  did: string
  key: Keypair
}

interface MintAnswer {
  status: number
  error?: string
  credential?: string
}

describe('minting a space credential: who may mint', () => {
  let harness: WriteHarness
  let accountLabels: AccountLabelHarness
  let resolveSpy: ReturnType<typeof vi.spyOn>
  const identities = new Map<string, Identity>()
  let identityCount = 0

  beforeAll(async () => {
    harness = await startSqliteWriteHarness()
    Object.assign(harness.ctx, { cache: new MemoryNxExStore() })
    for (const boundary of [HARNESS_ENGINEERING, HARNESS_DESIGN]) {
      await harness.ctx.boundaryStore!.create(catalogDefinition(boundary))
    }
    resolveSpy = vi
      .spyOn(harness.ctx.idResolver.did, 'resolve')
      .mockImplementation(async (did: string) => {
        const identity = identities.get(did)
        if (!identity) return null
        return {
          id: did,
          verificationMethod: [
            {
              id: `${did}#atproto`,
              type: 'Multikey',
              controller: did,
              publicKeyMultibase: identity.key.did().slice('did:key:'.length),
            },
          ],
        } as never
      })
    accountLabels = await buildAccountLabelHarness({
      enrollmentStore: harness.ctx.enrollmentStore,
      labelStore: harness.ctx.labelStore,
    } as HoldsBackend)
  }, 60_000)

  afterAll(async () => {
    resolveSpy.mockRestore()
    await accountLabels.close()
    await harness.close()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function newIdentity(name: string): Promise<Identity> {
    const identity = {
      did: `did:plc:${name}-${identityCount++}`,
      key: await Secp256k1Keypair.create(),
    }
    identities.set(identity.did, identity)
    return identity
  }

  async function enrolledMember(boundaries: string[]): Promise<Identity> {
    const member = await newIdentity('spike')
    await harness.enrollBoundaryHolder(member.did, boundaries)
    return member
  }

  let jtiCount = 0
  async function delegationFor(
    identity: Identity,
    space: string,
  ): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000)
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url')
    const signingInput = `${encode({
      typ: DELEGATION_TYP,
      alg: identity.key.jwtAlg,
      kid: '#atproto',
    })}.${encode({
      iss: identity.did,
      sub: space,
      aud: `${HARNESS_SERVICE_DID}#atproto_pds`,
      iat: issuedAt,
      exp: issuedAt + 60,
      jti: `delegation-${jtiCount++}-${issuedAt}`,
    })}`
    const signature = await identity.key.sign(
      new TextEncoder().encode(signingInput),
    )
    return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
  }

  async function mint(input: {
    delegation: string
    space: string
    boundKey: P256Keypair
    clientAttestation?: string
  }): Promise<MintAnswer> {
    const authorization = `Bearer ${input.delegation}`
    const parameters = `("authorization");keyid="${input.boundKey.did()}"`
    const signature = await input.boundKey.sign(
      new TextEncoder().encode(
        `"authorization": ${authorization}\n"@signature-params": ${parameters}`,
      ),
    )
    const response = await fetch(`${harness.baseUrl}/xrpc/${MINT_NSID}`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'signature-input': `atproto-space=${parameters}`,
        signature: `atproto-space=:${Buffer.from(signature).toString('base64')}:`,
      },
      body: JSON.stringify({
        space: input.space,
        ...(input.clientAttestation
          ? { clientAttestation: input.clientAttestation }
          : {}),
      }),
    })
    const body = (await response.json()) as {
      error?: string
      credential?: string
    }
    return {
      status: response.status,
      error: body.error,
      credential: body.credential,
    }
  }

  async function mintFresh(identity: Identity): Promise<MintAnswer> {
    return mint({
      delegation: await delegationFor(identity, ENGINEERING_SPACE),
      space: ENGINEERING_SPACE,
      boundKey: await P256Keypair.create(),
    })
  }

  async function setOperatorHold(did: string, held: boolean) {
    const session = await harness.ctx.adminSessionStore.create(
      ADMIN_DID,
      ADMIN_SESSION_LIFETIME_MS,
    )
    const response = await fetch(
      `${harness.baseUrl}/xrpc/zone.stratos.admin.setActive`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${ADMIN_SESSION_COOKIE}=${session}`,
        },
        body: JSON.stringify({ did, active: !held }),
      },
    )
    expect(response.status).toBe(200)
  }

  async function takeDown(did: string) {
    expect((await accountLabels.takedown(did)).status).toBe(200)
  }

  async function liftTakedown(did: string) {
    expect((await accountLabels.negate(did)).status).toBe(200)
  }

  const notEnrolled: MintAnswer = { status: 400, error: 'NotEnrolled' }
  const refusedWith = (answer: MintAnswer) => ({
    status: answer.status,
    error: answer.error,
  })

  describe('a member under a hold', () => {
    it('is refused under an operator hold and mints again once it is lifted', async () => {
      const spike = await enrolledMember([HARNESS_ENGINEERING])
      expect((await mintFresh(spike)).status).toBe(200)

      await setOperatorHold(spike.did, true)
      expect(refusedWith(await mintFresh(spike))).toEqual(notEnrolled)

      await setOperatorHold(spike.did, false)
      expect((await mintFresh(spike)).status).toBe(200)
    })

    it('is refused under an account takedown and mints again once it is lifted', async () => {
      const faye = await enrolledMember([HARNESS_ENGINEERING])
      expect((await mintFresh(faye)).status).toBe(200)

      await takeDown(faye.did)
      expect(refusedWith(await mintFresh(faye))).toEqual(notEnrolled)

      await liftTakedown(faye.did)
      expect((await mintFresh(faye)).status).toBe(200)
    })

    it('is refused under both holds until both are lifted', async () => {
      const jet = await enrolledMember([HARNESS_ENGINEERING])

      await setOperatorHold(jet.did, true)
      await takeDown(jet.did)
      expect(refusedWith(await mintFresh(jet))).toEqual(notEnrolled)

      await liftTakedown(jet.did)
      expect(refusedWith(await mintFresh(jet))).toEqual(notEnrolled)

      await setOperatorHold(jet.did, false)
      expect((await mintFresh(jet)).status).toBe(200)
    })
  })

  describe('a service enrollment', () => {
    it('mints through a delegation as a member does while active and holding the boundary', async () => {
      const feedgen = await newIdentity('feedgen-tokyo')
      await harness.enrollServiceIdentity(feedgen.did, [HARNESS_ENGINEERING])
      const answer = await mintFresh(feedgen)
      expect(answer.status).toBe(200)
      expect(answer.credential).toBeTruthy()
    })

    it('is refused under a hold and mints again once the hold is lifted', async () => {
      const feedgen = await newIdentity('feedgen-bebop')
      await harness.enrollServiceIdentity(feedgen.did, [HARNESS_ENGINEERING])

      await setOperatorHold(feedgen.did, true)
      expect(refusedWith(await mintFresh(feedgen))).toEqual(notEnrolled)

      await setOperatorHold(feedgen.did, false)
      expect((await mintFresh(feedgen)).status).toBe(200)
    })

    it('is refused for a boundary it does not hold', async () => {
      const feedgen = await newIdentity('feedgen-nerv')
      await harness.enrollServiceIdentity(feedgen.did, [HARNESS_DESIGN])
      expect(refusedWith(await mintFresh(feedgen))).toEqual(notEnrolled)
    })
  })

  describe('single-use tokens', () => {
    it('a mint refused for membership spends neither the delegation nor the client attestation', async () => {
      const client = await makeClient()
      await harness.ctx.boundaryStore!.create({
        ...catalogDefinition(HARNESS_LEADERSHIP),
        appAccess: 'allowList',
        clientIds: [client.clientId],
      })
      Object.assign(harness.ctx, { jwksResolver: resolverFor([client]) })

      const ed = await enrolledMember([HARNESS_LEADERSHIP])
      const delegation = await delegationFor(ed, LEADERSHIP_SPACE)
      const clientAttestation = await mintAttestation({
        client,
        serviceDid: HARNESS_SERVICE_DID,
      })
      const boundKey = await P256Keypair.create()
      const attempt = () =>
        mint({
          delegation,
          space: LEADERSHIP_SPACE,
          boundKey,
          clientAttestation,
        })

      await setOperatorHold(ed.did, true)
      expect(refusedWith(await attempt())).toEqual(notEnrolled)

      await setOperatorHold(ed.did, false)
      expect((await attempt()).status).toBe(200)
    })

    it('a consumed delegation is refused on a second use', async () => {
      const spike = await enrolledMember([HARNESS_ENGINEERING])
      const delegation = await delegationFor(spike, ENGINEERING_SPACE)
      const boundKey = await P256Keypair.create()
      const attempt = () =>
        mint({ delegation, space: ENGINEERING_SPACE, boundKey })

      expect((await attempt()).status).toBe(200)
      expect(await attempt()).toMatchObject({
        status: 400,
        error: 'InvalidToken',
      })
    })
  })

  describe('a credential minted before a hold', () => {
    it('is still accepted on a read route until it expires, then is refused: it outlives the hold until expiry', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(FROZEN_NOW)

      const rei = await enrolledMember([HARNESS_ENGINEERING])
      const boundKey = await P256Keypair.create()
      const minted = await mint({
        delegation: await delegationFor(rei, ENGINEERING_SPACE),
        space: ENGINEERING_SPACE,
        boundKey,
      })
      expect(minted.status).toBe(200)
      const credential = minted.credential!
      const expiresAt = JSON.parse(
        Buffer.from(credential.split('.')[1], 'base64url').toString(),
      ).exp as number

      await setOperatorHold(rei.did, true)
      await takeDown(rei.did)
      expect(refusedWith(await mintFresh(rei))).toEqual(notEnrolled)

      const present = async () => {
        const headers = await signPresentation({
          key: boundKey,
          authorization: `Atproto-Space-Credential ${credential}`,
          audience: HARNESS_SERVICE_DID,
        })
        const response = await fetch(
          `${harness.baseUrl}/xrpc/${LIST_REPOS_NSID}?${new URLSearchParams({ space: ENGINEERING_SPACE })}`,
          { headers },
        )
        return response.status
      }

      vi.setSystemTime(FROZEN_NOW)
      expect(await present()).toBe(200)

      vi.setSystemTime((expiresAt - 1) * 1000)
      expect(await present()).toBe(200)

      vi.setSystemTime(expiresAt * 1000)
      expect(await present()).toBe(401)
    })
  })
})
