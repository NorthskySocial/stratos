import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import {
  setup,
  type Harness,
  ENGINEERING,
  SERVICE,
  settings,
} from './helpers.js'
import { mintSpaceCredential } from '../../src/features/space-credential/minter.js'
import { verifySpaceCredential } from '../../src/infra/auth/space-credential-verifier.js'
import { requireActiveSpaceCredential } from '../../src/features/boundary/credential-access.js'
import { makeSpaceUri } from '../helpers/space-uri.js'

const spaceUri = makeSpaceUri(SERVICE, 'zone.stratos.space.feed', 'engineering')
describe('catalog credential revocation', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
  })
  afterEach(async () => {
    await h.cleanup()
  })
  it('preserves the legacy credential result shape when no revision was signed', async () => {
    const key = await Secp256k1Keypair.create()
    const minted = await mintSpaceCredential({
      signingKey: key,
      issuerDid: SERVICE,
      spaceUri,
      ttlSeconds: 3600,
    })
    expect(Object.hasOwn(minted.payload, 'stratosBoundaryRevision')).toBe(false)
    const verified = await verifySpaceCredential(minted.credential, {
      serviceKey: key,
      serviceDid: SERVICE,
    })
    expect(verified).toStrictEqual({ spaceUri })
  })
  it('binds signed credentials to a revision and rejects old credentials after edit and reactivation', async () => {
    const key = await Secp256k1Keypair.create()
    const minted = await mintSpaceCredential({
      signingKey: key,
      issuerDid: SERVICE,
      spaceUri,
      ttlSeconds: 3600,
      boundaryRevision: 1,
    })
    expect(minted.payload.stratosBoundaryRevision).toBe(1)
    const verified = await verifySpaceCredential(minted.credential, {
      serviceKey: key,
      serviceDid: SERVICE,
    })
    expect(verified).toEqual({ spaceUri, boundaryRevision: 1 })
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, verified),
    ).resolves.toBeUndefined()
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, { spaceUri }),
    ).resolves.toBeUndefined()
    await h.manager.update(ENGINEERING, settings, 1)
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, verified),
    ).rejects.toThrow('Authorization failed')
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, { spaceUri }),
    ).rejects.toThrow('Authorization failed')
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, {
        spaceUri,
        boundaryRevision: 2,
      }),
    ).resolves.toBeUndefined()
    await h.manager.deactivate(ENGINEERING, 2)
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, {
        spaceUri,
        boundaryRevision: 4,
      }),
    ).rejects.toThrow('Authorization failed')
    await h.manager.reactivate(ENGINEERING, 4)
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, verified),
    ).rejects.toThrow('Authorization failed')
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, {
        spaceUri,
        boundaryRevision: 5,
      }),
    ).resolves.toBeUndefined()
  })
  it.each([
    'broken',
    makeSpaceUri(
      'did:web:evil.example',
      'zone.stratos.space.feed',
      'engineering',
    ),
    makeSpaceUri(SERVICE, 'zone.stratos.space.feed', 'missing'),
  ])('rejects absent or foreign boundary %s', async (spaceUri) => {
    await expect(
      requireActiveSpaceCredential(h.store, SERVICE, { spaceUri }),
    ).rejects.toThrow('Authorization failed')
  })
  it.each([0, -1, 1.1, '1', null, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a signed malformed revision %s',
    async (revision) => {
      const key = await Secp256k1Keypair.create()
      const minted = await mintSpaceCredential({
        signingKey: key,
        issuerDid: SERVICE,
        spaceUri,
        ttlSeconds: 3600,
        boundaryRevision: revision as number,
      })
      await expect(
        verifySpaceCredential(minted.credential, {
          serviceKey: key,
          serviceDid: SERVICE,
        }),
      ).rejects.toThrow('Invalid boundary revision')
    },
  )
})
