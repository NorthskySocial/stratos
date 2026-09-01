import { describe, expect, it, vi } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { boundaryToSpaceUri, StratosError } from '@northskysocial/stratos-core'
import {
  DEFAULT_REFRESH_MARGIN_MS,
  SpaceCredentialManager,
} from '../src/space-credential/manager.js'
import { generateDpopKeyPair } from '../src/space-credential/dpop.js'
import type { GetSpaceCredentialResult } from '../src/upstream/index.js'

function makeClock(initial = 0) {
  let now = initial
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function decodeJwt(token: string): Record<string, unknown> {
  const [, payloadB64] = token.split('.')
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'))
}

function decodeJwtHeader(token: string): Record<string, unknown> {
  const [headerB64] = token.split('.')
  return JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'))
}

const FEEDGEN_DID = 'did:web:feedgen.test'
const STRATOS_DID = 'did:web:stratos.test'
const SPACE_TYPE = 'zone.stratos.space.feed'

// 90s-anime crew boundaries — `{serviceDid}/{domainName}`.
const BEBOP_BOUNDARY = `${STRATOS_DID}/bebop-crew`
const NERV_BOUNDARY = `${STRATOS_DID}/nerv-pilots`

function expectedSpaceUri(boundary: string): string {
  const result = boundaryToSpaceUri(boundary, SPACE_TYPE)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

async function makeManager(overrides: {
  getSpaceCredential: (opts: {
    space: string
    delegationToken: string
    buildMintProof: (htu: string) => Promise<string>
  }) => Promise<GetSpaceCredentialResult>
  now?: () => number
  refreshMarginMs?: number
  random?: () => number
}) {
  const signingKey = await Secp256k1Keypair.create({ exportable: true })
  const client = { getSpaceCredential: vi.fn(overrides.getSpaceCredential) }
  const manager = new SpaceCredentialManager({
    client,
    signingKey,
    feedgenDid: FEEDGEN_DID,
    authorityDid: STRATOS_DID,
    now: overrides.now,
    refreshMarginMs: overrides.refreshMarginMs,
    random: overrides.random,
  })
  return { manager, client, signingKey }
}

describe('SpaceCredentialManager', () => {
  describe('mint-and-exchange', () => {
    it('mints a delegation token, presents a mint-time proof, and holds the returned credential', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
      const { manager, client } = await makeManager({
        getSpaceCredential: async (opts) => {
          expect(opts.space).toBe(expectedSpaceUri(BEBOP_BOUNDARY))
          const delegation = decodeJwt(opts.delegationToken)
          expect(delegation.iss).toBe(FEEDGEN_DID)
          expect(delegation.sub).toBe(opts.space)
          expect(delegation.aud).toBe(`${STRATOS_DID}#atproto_space_host`)

          const mintProof = await opts.buildMintProof(
            'https://stratos.test/xrpc/zone.stratos.space.getSpaceCredential',
          )
          const proofClaims = decodeJwt(mintProof)
          expect(proofClaims.htm).toBe('POST')
          expect(proofClaims.htu).toBe(
            'https://stratos.test/xrpc/zone.stratos.space.getSpaceCredential',
          )
          expect(proofClaims.ath).toBeUndefined()

          return { credential: 'space-credential-jwt', expiresAt }
        },
      })

      const held = await manager.getCredential(BEBOP_BOUNDARY)
      expect(held.credential).toBe('space-credential-jwt')
      expect(held.boundary).toBe(BEBOP_BOUNDARY)
      expect(held.expiresAt.toISOString()).toBe(expiresAt)
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1)
    })

    it('binds the presentation proof to the held credential via ath', async () => {
      const dpopKeyPair = await generateDpopKeyPair()
      const signingKey = await Secp256k1Keypair.create({ exportable: true })
      const client = {
        getSpaceCredential: vi.fn(async () => ({
          credential: 'the-credential',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })),
      }
      const manager = new SpaceCredentialManager({
        client,
        signingKey,
        feedgenDid: FEEDGEN_DID,
        authorityDid: STRATOS_DID,
        dpopKeyPair,
      })

      const held = await manager.getCredential(NERV_BOUNDARY)
      const proof = await held.createPresentationProof(
        'GET',
        'https://spaces-pds.test/xrpc/com.atproto.space.listRepoOps',
      )
      const claims = decodeJwt(proof)
      expect(claims.htm).toBe('GET')
      expect(typeof claims.ath).toBe('string')
      // The injected key, not a freshly generated one, must sign the proof —
      // otherwise the credential's `cnf.jkt` binding would not match.
      expect(decodeJwtHeader(proof).jwk).toEqual(dpopKeyPair.jwk)
    })

    it('does not mint a second credential for a second call before the refresh margin', async () => {
      const { manager, client } = await makeManager({
        getSpaceCredential: async () => ({
          credential: 'cred-1',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      })
      await manager.getCredential(BEBOP_BOUNDARY)
      await manager.getCredential(BEBOP_BOUNDARY)
      await manager.getCredential(BEBOP_BOUNDARY)
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1)
    })

    it('coalesces concurrent misses for the same boundary (single-flight)', async () => {
      let resolveCall: (v: GetSpaceCredentialResult) => void = () => {}
      const pending = new Promise<GetSpaceCredentialResult>((resolve) => {
        resolveCall = resolve
      })
      const { manager, client } = await makeManager({
        getSpaceCredential: async () => pending,
      })

      const p1 = manager.getCredential(BEBOP_BOUNDARY)
      const p2 = manager.getCredential(BEBOP_BOUNDARY)
      // Minting crosses several real async boundaries (DPoP key generation,
      // token signing) before it reaches the client call, so wait for it
      // rather than asserting synchronously.
      await vi.waitFor(() =>
        expect(client.getSpaceCredential).toHaveBeenCalledTimes(1),
      )

      resolveCall({
        credential: 'shared-cred',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      const [held1, held2] = await Promise.all([p1, p2])
      expect(held1.credential).toBe('shared-cred')
      expect(held2.credential).toBe('shared-cred')
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1)
    })

    it('cancels one waiter without cancelling or detaching the shared mint', async () => {
      let resolveCall!: (value: GetSpaceCredentialResult) => void
      const pending = new Promise<GetSpaceCredentialResult>((resolve) => {
        resolveCall = resolve
      })
      const { manager, client } = await makeManager({
        getSpaceCredential: async () => pending,
      })
      const controller = new AbortController()

      const cancelled = manager
        .getCredential(BEBOP_BOUNDARY, controller.signal)
        .catch((cause: unknown) => cause)
      await vi.waitFor(() =>
        expect(client.getSpaceCredential).toHaveBeenCalledOnce(),
      )
      controller.abort()
      await expect(cancelled).resolves.toMatchObject({ name: 'AbortError' })

      const survivingWaiter = manager.getCredential(BEBOP_BOUNDARY)
      expect(client.getSpaceCredential).toHaveBeenCalledOnce()
      resolveCall({
        credential: 'shared-after-cancel',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })

      await expect(survivingWaiter).resolves.toMatchObject({
        credential: 'shared-after-cancel',
      })
      await expect(
        manager.getCredential(BEBOP_BOUNDARY),
      ).resolves.toMatchObject({ credential: 'shared-after-cancel' })
      expect(client.getSpaceCredential).toHaveBeenCalledOnce()
    })
  })

  describe('refresh before expiry', () => {
    it('defaults the refresh margin to 5 minutes', () => {
      expect(DEFAULT_REFRESH_MARGIN_MS).toBe(5 * 60_000)
    })

    it('treats exactly the refresh margin as due for refresh, not just inside it', async () => {
      const clock = makeClock()
      let mintCount = 0
      const { manager } = await makeManager({
        now: clock.now,
        refreshMarginMs: 60_000,
        getSpaceCredential: async () => {
          mintCount += 1
          return {
            credential: `cred-${mintCount}`,
            expiresAt: new Date(clock.now() + 600_000).toISOString(),
          }
        },
      })

      await manager.getCredential(BEBOP_BOUNDARY)
      expect(mintCount).toBe(1)

      clock.advance(600_000 - 60_000) // now === expiresAtMs - refreshMarginMs
      const refreshed = await manager.getCredential(BEBOP_BOUNDARY)
      expect(refreshed.credential).toBe('cred-2')
      expect(mintCount).toBe(2)
    })

    it('refreshes once the held credential is within the margin, and reuses it otherwise', async () => {
      const clock = makeClock()
      let mintCount = 0
      const { manager, client } = await makeManager({
        now: clock.now,
        refreshMarginMs: 60_000, // 1 minute
        getSpaceCredential: async () => {
          mintCount += 1
          // Each mint is valid for 10 minutes from "now".
          return {
            credential: `cred-${mintCount}`,
            expiresAt: new Date(clock.now() + 600_000).toISOString(),
          }
        },
      })

      const first = await manager.getCredential(BEBOP_BOUNDARY)
      expect(first.credential).toBe('cred-1')
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1)

      clock.advance(500_000) // still > 60s from the 600_000 ms expiry
      const stillCached = await manager.getCredential(BEBOP_BOUNDARY)
      expect(stillCached.credential).toBe('cred-1')
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1)

      clock.advance(45_000) // now within the 60s refresh margin
      const refreshed = await manager.getCredential(BEBOP_BOUNDARY)
      expect(refreshed.credential).toBe('cred-2')
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(2)
    })

    it('draws jitter once at mint time, ahead of the plain refresh margin', async () => {
      // A max-draw random source (jitter = 10% of the margin) must pull the
      // refresh instant earlier than the margin alone would.
      const clock = makeClock()
      let mintCount = 0
      const { manager } = await makeManager({
        now: clock.now,
        refreshMarginMs: 60_000,
        random: () => 1, // maximal jitter draw
        getSpaceCredential: async () => {
          mintCount += 1
          return {
            credential: `cred-${mintCount}`,
            expiresAt: new Date(clock.now() + 600_000).toISOString(),
          }
        },
      })

      await manager.getCredential(BEBOP_BOUNDARY)
      expect(mintCount).toBe(1)

      // Plain margin alone would not be due until 540_000; jitter (6_000 at
      // this margin) pulls the threshold to 534_000. Just short of it, the
      // credential is still cached -- a maximal draw is a small nudge, never
      // an immediate refresh.
      clock.advance(533_999)
      const stillCached = await manager.getCredential(BEBOP_BOUNDARY)
      expect(stillCached.credential).toBe('cred-1')
      expect(mintCount).toBe(1)

      clock.advance(1)
      const refreshed = await manager.getCredential(BEBOP_BOUNDARY)
      expect(refreshed.credential).toBe('cred-2')
      expect(mintCount).toBe(2)
    })

    it('draws no jitter when the random source returns zero', async () => {
      const clock = makeClock()
      let mintCount = 0
      const { manager } = await makeManager({
        now: clock.now,
        refreshMarginMs: 60_000,
        random: () => 0,
        getSpaceCredential: async () => {
          mintCount += 1
          return {
            credential: `cred-${mintCount}`,
            expiresAt: new Date(clock.now() + 600_000).toISOString(),
          }
        },
      })

      await manager.getCredential(BEBOP_BOUNDARY)
      clock.advance(539_000) // just short of the plain 540_000 margin instant
      const stillCached = await manager.getCredential(BEBOP_BOUNDARY)
      expect(stillCached.credential).toBe('cred-1')
      expect(mintCount).toBe(1)
    })
  })

  describe('rejected delegation token', () => {
    it('propagates a mint rejection when no credential is already held', async () => {
      const { manager, client } = await makeManager({
        getSpaceCredential: async () => {
          throw Object.assign(new Error('delegation token rejected'), {
            name: 'StratosClientError',
            status: 400,
          })
        },
      })

      await expect(manager.getCredential(BEBOP_BOUNDARY)).rejects.toThrow(
        'delegation token rejected',
      )
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(1)
    })
  })

  describe('failure does not crash and does not serve unverifiable data', () => {
    it('keeps serving a still-valid held credential when a refresh attempt fails', async () => {
      const clock = makeClock()
      let call = 0
      const { manager, client } = await makeManager({
        now: clock.now,
        refreshMarginMs: 60_000,
        getSpaceCredential: async () => {
          call += 1
          if (call === 1) {
            return {
              credential: 'still-good',
              expiresAt: new Date(clock.now() + 600_000).toISOString(),
            }
          }
          throw new Error('upstream unavailable')
        },
      })

      const first = await manager.getCredential(BEBOP_BOUNDARY)
      expect(first.credential).toBe('still-good')

      clock.advance(560_000) // within the refresh margin, not yet expired
      const duringOutage = await manager.getCredential(BEBOP_BOUNDARY)
      expect(duringOutage.credential).toBe('still-good')
      expect(client.getSpaceCredential).toHaveBeenCalledTimes(2)
    })

    it('rejects rather than fabricate access once the held credential has actually expired', async () => {
      const clock = makeClock()
      let call = 0
      const { manager } = await makeManager({
        now: clock.now,
        refreshMarginMs: 60_000,
        getSpaceCredential: async () => {
          call += 1
          if (call === 1) {
            return {
              credential: 'expiring-soon',
              expiresAt: new Date(clock.now() + 600_000).toISOString(),
            }
          }
          throw new Error('upstream unavailable')
        },
      })

      await manager.getCredential(BEBOP_BOUNDARY)
      clock.advance(600_001) // now genuinely expired
      await expect(manager.getCredential(BEBOP_BOUNDARY)).rejects.toThrow(
        'upstream unavailable',
      )
    })

    it('treats a credential as expired at the exact expiry instant, not just after', async () => {
      const clock = makeClock()
      let call = 0
      const { manager } = await makeManager({
        now: clock.now,
        refreshMarginMs: 60_000,
        getSpaceCredential: async () => {
          call += 1
          if (call === 1) {
            return {
              credential: 'expiring-soon',
              expiresAt: new Date(clock.now() + 600_000).toISOString(),
            }
          }
          throw new Error('upstream unavailable')
        },
      })

      await manager.getCredential(BEBOP_BOUNDARY)
      clock.advance(600_000) // now === expiresAtMs exactly
      await expect(manager.getCredential(BEBOP_BOUNDARY)).rejects.toThrow(
        'upstream unavailable',
      )
    })

    it('rejects when the boundary cannot be mapped to a space URI, without throwing synchronously', async () => {
      const { manager } = await makeManager({
        getSpaceCredential: async () => ({
          credential: 'unused',
          expiresAt: new Date(3_600_000).toISOString(),
        }),
      })
      await expect(
        manager.getCredential('not-a-valid-boundary-no-slash'),
      ).rejects.toThrow(/cannot map boundary/)
    })
  })

  it('rejects a credential whose expiry cannot be parsed', async () => {
    // NaN compares false against everything, so an unparsed expiry would look
    // neither due for refresh nor expired, and be served forever.
    const { manager } = await makeManager({
      getSpaceCredential: async () => ({
        credential: 'cred-shinji',
        expiresAt: 'not-a-date',
      }),
    })

    // A domain error, so callers can classify credential-validation failures
    // apart from unexpected ones.
    const err = await manager.getCredential(BEBOP_BOUNDARY).catch((e) => e)
    expect(err).toBeInstanceOf(StratosError)
    expect(err.code).toBe('InvalidCredentialExpiry')
    expect(err.message).toMatch(/unusable expiry/)
  })

  it('rejects a credential that arrives already expired', async () => {
    // The mint response is the server's claim. An expiry at or before now
    // means the credential is dead on arrival; holding it would hand the
    // caller access that no longer exists.
    const clock = makeClock(1_000_000)
    const { manager } = await makeManager({
      now: clock.now,
      getSpaceCredential: async () => ({
        credential: 'cred-rei',
        expiresAt: new Date(clock.now()).toISOString(),
      }),
    })

    await expect(manager.getCredential(BEBOP_BOUNDARY)).rejects.toThrow(
      /unusable expiry/,
    )
  })

  it('re-attempts a mint after an earlier failure', async () => {
    // Guards the single-flight map: a cached rejection would make the second
    // call return without touching the client.
    let calls = 0
    const { manager, client } = await makeManager({
      getSpaceCredential: async () => {
        calls += 1
        if (calls === 1) throw new Error('rejected')
        return {
          credential: 'cred-asuka',
          expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        }
      },
    })

    await expect(manager.getCredential(BEBOP_BOUNDARY)).rejects.toThrow(
      'rejected',
    )
    await expect(manager.getCredential(BEBOP_BOUNDARY)).resolves.toMatchObject({
      credential: 'cred-asuka',
    })
    expect(client.getSpaceCredential).toHaveBeenCalledTimes(2)
  })
})
