import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import {
  boundaryToSpaceUri,
  stratosLexicons,
} from '@northskysocial/stratos-core'
import type { AppContext } from '../src/context.js'
import { registerSpaceCredentialHandlers } from '../src/features/space-credential/index.js'
import { mintSpaceCredential } from '../src/features/space-credential/minter.js'
import {
  DELEGATION_TYP,
  InvalidDelegationSubError,
  verifyDelegationToken,
} from '../src/infra/auth/delegation-verifier.js'
import type { NxExStore } from '../src/infra/auth/replay-store.js'
import {
  InvalidSpaceCredentialSignatureError,
  InvalidSpaceCredentialSubError,
  verifySpaceCredential,
} from '../src/infra/auth/space-credential-verifier.js'
import { ADMIN_SESSION_COOKIE } from '../src/oauth/admin-routes.js'
import { HOSTED_SPACE_TYPE } from '../src/shared/space-type-registry.js'
import {
  asMember,
  HARNESS_DESIGN,
  HARNESS_ENGINEERING,
  HARNESS_GENERAL,
  HARNESS_SERVICE_DID,
  startSqliteWriteHarness,
  withCredential,
  type WriteHarness,
} from './helpers/write-harness.js'

const MINT = 'zone.stratos.space.getSpaceCredential'
const GET_RECORD = 'zone.stratos.space.getRecord'
const POST = 'zone.stratos.feed.post'
const MISATO = 'did:plc:misato-katsuragi'
const REI = 'did:plc:rei-ayanami'
const ASUKA = 'did:plc:asuka-langley'
const ADMIN_DID = 'did:plc:gendo-ikari'
const UNKNOWN_SPACE = { error: 'UnknownSpace' }

function spaceUriOf(boundary: string): string {
  const space = boundaryToSpaceUri(boundary, HOSTED_SPACE_TYPE)
  if (!space.ok) throw new Error(space.error.message)
  return space.value
}

const ENGINEERING_SPACE = spaceUriOf(HARNESS_ENGINEERING)
const DESIGN_SPACE = spaceUriOf(HARNESS_DESIGN)
const GENERAL_SPACE = spaceUriOf(HARNESS_GENERAL)
const LEGACY_ENGINEERING_SPACE = `at://${HARNESS_SERVICE_DID}/space/${HOSTED_SPACE_TYPE}/engineering`

class MemoryNxExStore implements NxExStore {
  private readonly seen = new Set<string>()
  async setNxEx(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}

/** A mint-time DPoP proof, which the delegation path requires outside the session key. */
async function mintProofFor(htu: string): Promise<string> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const jwk = await exportJWK(publicKey)
  return new SignJWT({ htm: 'POST', htu, jti: randomUUID() })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk })
    .setIssuedAt()
    .sign(privateKey)
}

const base64Url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

async function signedDelegation(
  userKey: Secp256k1Keypair,
  userDid: string,
  sub: string,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = { typ: DELEGATION_TYP, alg: userKey.jwtAlg, kid: '#atproto' }
  const payload = {
    iss: userDid,
    sub,
    aud: `${HARNESS_SERVICE_DID}#atproto_space_host`,
    iat: issuedAt,
    exp: issuedAt + 60,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  }
  const signingInput = `${base64Url(header)}.${base64Url(payload)}`
  const signature = await userKey.sign(new TextEncoder().encode(signingInput))
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`
}

describe('space URIs in credentials, space reads and repo-host answers', () => {
  let harness: WriteHarness

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
  }, 60_000)

  afterAll(async () => {
    await harness.close()
  })

  const mintFor = (space: string) =>
    harness.call(MINT, asMember(MISATO), { space })

  const readIn = (space: string, credential: string) =>
    harness.query(GET_RECORD, withCredential(credential), {
      space,
      repo: MISATO,
      collection: POST,
      rkey: 'eva01',
    })

  async function mintedCredential(space: string): Promise<string> {
    const minted = await mintFor(space)
    expect(minted.status).toBe(200)
    return (minted.body as { credential: string }).credential
  }

  describe('minting and reading', () => {
    it('mints for a space and admits that credential to a read of the same space string', async () => {
      const credential = await mintedCredential(ENGINEERING_SPACE)

      const payload = JSON.parse(
        Buffer.from(credential.split('.')[1], 'base64url').toString(),
      )
      const read = await readIn(ENGINEERING_SPACE, credential)

      expect(payload.sub).toBe(ENGINEERING_SPACE)
      expect(read.status).toBe(200)
      expect(read.body).toMatchObject({ value: { text: 'sortie' } })
    })

    it('refuses that credential at a read of a different space', async () => {
      const credential = await mintedCredential(ENGINEERING_SPACE)

      const read = await readIn(DESIGN_SPACE, credential)

      expect(read.status).toBe(401)
      expect(read.body).toMatchObject({ error: 'AuthRequired' })
    })

    it('refuses that credential at a read whose space differs only in the case of its skey', async () => {
      const credential = await mintedCredential(ENGINEERING_SPACE)

      const read = await readIn(
        ENGINEERING_SPACE.replace('/engineering', '/Engineering'),
        credential,
      )

      expect(read.status).toBe(401)
      expect(read.body).toMatchObject({ error: 'AuthRequired' })
    })

    it('answers UnknownSpace to a read of a space with a trailing slash', async () => {
      const credential = await mintedCredential(ENGINEERING_SPACE)

      const read = await readIn(`${ENGINEERING_SPACE}/`, credential)

      expect(read.status).toBe(400)
      expect(read.body).toMatchObject(UNKNOWN_SPACE)
    })

    it.each([
      ['the old spelling of a space', LEGACY_ENGINEERING_SPACE],
      [
        'a record URI in place of a space',
        `${ENGINEERING_SPACE}/${MISATO}/${POST}/eva01`,
      ],
      ['a space with a trailing slash', `${ENGINEERING_SPACE}/`],
    ])('refuses a mint request that names %s', async (_name, space) => {
      const minted = await mintFor(space)

      expect(minted.status).toBe(400)
      expect(minted.body).toMatchObject(UNKNOWN_SPACE)
    })

    it('refuses to read a space in the old spelling with a credential of the same space', async () => {
      const credential = await mintedCredential(ENGINEERING_SPACE)

      const read = await readIn(LEGACY_ENGINEERING_SPACE, credential)

      expect(read.status).toBe(400)
      expect(read.body).toMatchObject(UNKNOWN_SPACE)
    })
  })

  describe('a credential signed over the old spelling of a space', () => {
    const verifierDeps = () => ({
      serviceKey: harness.ctx.signingKey,
      serviceDid: HARNESS_SERVICE_DID,
    })

    const signedOver = async (spaceUri: string) =>
      (
        await mintSpaceCredential({
          signingKey: harness.ctx.signingKey,
          issuerDid: HARNESS_SERVICE_DID,
          spaceUri,
          ttlSeconds: 600,
        })
      ).credential

    it('has a signature the service key made, and is refused for its subject', async () => {
      const credential = await signedOver(LEGACY_ENGINEERING_SPACE)

      const refusal = await verifySpaceCredential(
        credential,
        verifierDeps(),
      ).catch((err: unknown) => err)

      expect(refusal).toBeInstanceOf(InvalidSpaceCredentialSubError)
      expect(refusal).not.toBeInstanceOf(InvalidSpaceCredentialSignatureError)
    })

    it('verifies once only its subject is respelled and signed again by the same key', async () => {
      const credential = await signedOver(ENGINEERING_SPACE)

      await expect(
        verifySpaceCredential(credential, verifierDeps()),
      ).resolves.toMatchObject({ spaceUri: ENGINEERING_SPACE })
    })

    it.each([
      ['the space of the credential', ENGINEERING_SPACE],
      ['the old spelling', LEGACY_ENGINEERING_SPACE],
    ])('admits the caller to no read of %s', async (_name, requested) => {
      const credential = await signedOver(LEGACY_ENGINEERING_SPACE)

      const read = await readIn(requested, credential)

      expect(read.status).not.toBe(200)
      expect(read.body).not.toHaveProperty('value')
    })
  })

  describe('a delegation signed over the old spelling of a space', () => {
    let userKey: Secp256k1Keypair
    let server: http.Server
    let mintUrl: string
    let resolver: IdResolver

    beforeAll(async () => {
      userKey = await Secp256k1Keypair.create()
      await harness.enrollMember(REI, [HARNESS_ENGINEERING])
      resolver = {
        did: {
          resolve: async (did: string) =>
            did === REI
              ? {
                  id: REI,
                  verificationMethod: [
                    {
                      id: `${REI}#atproto`,
                      type: 'Multikey',
                      controller: REI,
                      publicKeyMultibase: userKey
                        .did()
                        .slice('did:key:'.length),
                    },
                  ],
                }
              : null,
        },
      } as unknown as IdResolver
      const ctx: AppContext = {
        ...harness.ctx,
        idResolver: resolver,
        cache: new MemoryNxExStore() as unknown as AppContext['cache'],
      }
      const xrpc = new XrpcServer(stratosLexicons)
      registerSpaceCredentialHandlers(xrpc, ctx)
      const app = express()
      app.use(xrpc.router)
      server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
      })
      mintUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/xrpc/${MINT}`
    })

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve))
    })

    const mintWith = async (delegationToken: string) => {
      const response = await fetch(mintUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          dpop: await mintProofFor(
            `${harness.ctx.cfg.service.publicUrl}/xrpc/${MINT}`,
          ),
        },
        body: JSON.stringify({ space: ENGINEERING_SPACE, delegationToken }),
      })
      return { status: response.status, body: await response.json() }
    }

    it('mints for the same delegation when its subject is the space', async () => {
      const token = await signedDelegation(userKey, REI, ENGINEERING_SPACE)

      const minted = await mintWith(token)

      expect(minted.status).toBe(200)
      expect(minted.body).toHaveProperty('credential')
    })

    it('is refused at the mint route', async () => {
      const token = await signedDelegation(
        userKey,
        REI,
        LEGACY_ENGINEERING_SPACE,
      )

      const minted = await mintWith(token)

      expect(minted.status).toBe(400)
      expect(minted.body).toMatchObject({ error: 'InvalidToken' })
    })

    it('is refused for its subject, not its signature', async () => {
      const token = await signedDelegation(
        userKey,
        REI,
        LEGACY_ENGINEERING_SPACE,
      )

      const refusal = await verifyDelegationToken(token, {
        serviceDid: HARNESS_SERVICE_DID,
        idResolver: resolver,
      }).catch((err: unknown) => err)

      expect(refusal).toBeInstanceOf(InvalidDelegationSubError)
    })
  })

  describe('the repo-host answer', () => {
    it('gives the space URI of each boundary of a pds-custody member', async () => {
      await harness.enrollPdsCustodyMember(ASUKA, [
        HARNESS_ENGINEERING,
        HARNESS_DESIGN,
      ])
      const session = await harness.ctx.adminSessionStore.create(
        ADMIN_DID,
        60_000,
      )

      const response = await fetch(
        `${harness.baseUrl}/xrpc/zone.stratos.admin.getRepoHost?did=${ASUKA}`,
        { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session}` } },
      )

      expect(response.status).toBe(200)
      const { resolutions } = (await response.json()) as {
        resolutions: Array<{ boundary: string; spaceUri: string }>
      }
      expect(
        Object.fromEntries(resolutions.map((r) => [r.boundary, r.spaceUri])),
      ).toEqual({
        [HARNESS_ENGINEERING]: ENGINEERING_SPACE,
        [HARNESS_DESIGN]: DESIGN_SPACE,
        [HARNESS_GENERAL]: GENERAL_SPACE,
      })
      expect(ENGINEERING_SPACE).toBe(
        `at:space/${HARNESS_SERVICE_DID}/${HOSTED_SPACE_TYPE}/engineering`,
      )
    })
  })
})
