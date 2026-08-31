import { describe, expect, it, vi } from 'vitest'
import {
  MembershipCursorStalledError,
  MembershipPageLimitError,
  MembershipTracker,
  type BoundaryPassOutcome,
  type MembershipPassLogEvent,
} from '../src/space-sync/index.js'
import type {
  ListSpaceReposOptions,
  ListSpaceReposResult,
} from '../src/upstream/index.js'

// 90s-anime crew DIDs and boundaries — `{serviceDid}/{domainName}`.
const STRATOS_DID = 'did:web:stratos.test'
const BEBOP_BOUNDARY = `${STRATOS_DID}/bebop-crew`
const NERV_BOUNDARY = `${STRATOS_DID}/nerv-pilots`
const SPIKE = 'did:plc:spikespiegel'
const FAYE = 'did:plc:fayevalentine'

function spaceUriFor(boundary: string): string {
  return `at://${STRATOS_DID}/space/zone.stratos.space.feed/${boundary.split('/')[1]}`
}

function fakeCredentialManager() {
  return {
    getCredential: vi.fn(async (boundary: string) => ({
      boundary,
      spaceUri: spaceUriFor(boundary),
      credential: `cred-${boundary}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      createPresentationProof: async () => 'proof',
    })),
  }
}

function fakePurger() {
  const counts = {
    posts: 0,
    cursors: 0,
    spaceCursors: 0,
    enrolledActors: 0,
    boundaryCache: 0,
  }
  return {
    purgeSpaceActor: vi.fn(async () => counts),
    purgeSpaceDeparture: vi.fn(async () => counts),
  }
}

function outcomeFor(
  outcomes: BoundaryPassOutcome[],
  boundary: string,
): BoundaryPassOutcome {
  const found = outcomes.find((o) => o.boundary === boundary)
  if (!found) throw new Error(`no outcome for boundary ${boundary}`)
  return found
}

function expectSuccess(outcome: BoundaryPassOutcome) {
  if (!outcome.ok)
    throw new Error(`expected success, got error: ${outcome.error}`)
  return outcome
}

describe('MembershipTracker', () => {
  describe('custody partition', () => {
    it('turns a pds-custody row with a host into a poll target', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              { did: SPIKE, custody: 'pds', host: 'https://spike.example' },
            ],
          }),
        ),
      }
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.polls).toEqual([
        {
          spaceUri: spaceUriFor(BEBOP_BOUNDARY),
          boundary: BEBOP_BOUNDARY,
          did: SPIKE,
          host: 'https://spike.example',
        },
      ])
      expect(outcome.skippedNoHost).toBe(0)
    })

    it('does not poll a row with absent custody', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [{ did: SPIKE, host: 'https://spike.example' } as never],
          }),
        ),
      }
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.polls).toEqual([])
    })

    it('does not poll a row with an unrecognized custody value', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              {
                did: SPIKE,
                custody: 'quantum-entangled' as never,
                host: 'https://spike.example',
              },
            ],
          }),
        ),
      }
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.polls).toEqual([])
    })

    it('ignores stratos-custody rows — the subscription arm owns them', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              {
                did: SPIKE,
                custody: 'stratos',
                host: 'https://spike.example',
              },
            ],
          }),
        ),
      }
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.polls).toEqual([])
    })

    it('logs and skips a pds-custody row with no resolvable host', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [{ did: SPIKE, custody: 'pds' }],
          }),
        ),
      }
      const log = vi.fn<(event: MembershipPassLogEvent) => void>()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
        log,
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.polls).toEqual([])
      expect(outcome.skippedNoHost).toBe(1)
      expect(log).toHaveBeenCalledExactlyOnceWith({
        successfulBoundaries: 1,
        failedBoundaries: 0,
        pollTargets: 0,
        skippedNoHost: 1,
        removed: 0,
      })
    })
  })

  describe('first pass', () => {
    it('computes no removals and purges nothing on the first pass', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              { did: SPIKE, custody: 'pds', host: 'https://spike.example' },
            ],
          }),
        ),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])
      expect(outcomes).toHaveLength(1)
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.removed).toEqual([])
      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
    })
  })

  describe('member removal', () => {
    it('purges via purgeSpaceDeparture when a member leaves one boundary but still holds another', async () => {
      const bebopSpace = spaceUriFor(BEBOP_BOUNDARY)
      const nervSpace = spaceUriFor(NERV_BOUNDARY)
      const bebopCalls = { n: 0 }
      const client = {
        listSpaceRepos: vi.fn(
          async (
            opts: ListSpaceReposOptions,
          ): Promise<ListSpaceReposResult> => {
            if (opts.space === nervSpace) {
              return {
                repos: [
                  {
                    did: SPIKE,
                    custody: 'pds',
                    host: 'https://spike.example',
                  },
                ],
              }
            }
            bebopCalls.n += 1
            // Present on pass 1, gone on pass 2.
            return bebopCalls.n === 1
              ? {
                  repos: [
                    {
                      did: SPIKE,
                      custody: 'pds',
                      host: 'https://spike.example',
                    },
                  ],
                }
              : { repos: [] }
          },
        ),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])

      expect(purger.purgeSpaceDeparture).toHaveBeenCalledWith(
        SPIKE,
        BEBOP_BOUNDARY,
        bebopSpace,
      )
      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      const bebopOutcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(bebopOutcome.removed).toEqual([{ did: SPIKE, scope: 'boundary' }])
      const nervOutcome = expectSuccess(outcomeFor(outcomes, NERV_BOUNDARY))
      expect(nervOutcome.removed).toEqual([])
    })

    it('falls back to purgeSpaceActor when a member leaves every tracked boundary', async () => {
      let calls = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          calls += 1
          return calls === 1
            ? {
                repos: [
                  {
                    did: SPIKE,
                    custody: 'pds',
                    host: 'https://spike.example',
                  },
                ],
              }
            : { repos: [] }
        }),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      expect(purger.purgeSpaceActor).toHaveBeenCalledWith(SPIKE)
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.removed).toEqual([{ did: SPIKE, scope: 'actor' }])
    })

    it('falls back to purgeSpaceActor even when another boundary still has an unrelated member', async () => {
      const bebopSpace = spaceUriFor(BEBOP_BOUNDARY)
      let bebopCalls = 0
      const client = {
        listSpaceRepos: vi.fn(
          async (
            opts: ListSpaceReposOptions,
          ): Promise<ListSpaceReposResult> => {
            if (opts.space !== bebopSpace) {
              // NERV always has FAYE — never SPIKE — on either pass.
              return {
                repos: [
                  { did: FAYE, custody: 'pds', host: 'https://faye.example' },
                ],
              }
            }
            bebopCalls += 1
            // SPIKE present on pass 1, gone (not merely boundary-shrunk) by pass 2.
            return bebopCalls === 1
              ? {
                  repos: [
                    {
                      did: SPIKE,
                      custody: 'pds',
                      host: 'https://spike.example',
                    },
                  ],
                }
              : { repos: [] }
          },
        ),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])
      await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])

      expect(purger.purgeSpaceActor).toHaveBeenCalledWith(SPIKE)
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
    })

    it('purges a departed member only once even when they leave two boundaries in the same pass', async () => {
      let calls = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          calls += 1
          // First two calls (pass 1, both boundaries) see FAYE; later calls
          // (pass 2) see nobody.
          return calls <= 2
            ? {
                repos: [
                  { did: FAYE, custody: 'pds', host: 'https://faye.example' },
                ],
              }
            : { repos: [] }
        }),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])
      await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])

      expect(purger.purgeSpaceActor).toHaveBeenCalledTimes(1)
      expect(purger.purgeSpaceActor).toHaveBeenCalledWith(FAYE)
    })

    it('retries a departure when its purge fails', async () => {
      let calls = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          calls += 1
          return calls === 1
            ? {
                repos: [
                  {
                    did: SPIKE,
                    custody: 'pds',
                    host: 'https://spike.example',
                  },
                ],
              }
            : { repos: [] }
        }),
      }
      const purgeError = new Error('database unavailable')
      const purger = fakePurger()
      purger.purgeSpaceActor.mockRejectedValueOnce(purgeError)
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY])
      await expect(tracker.runPass([BEBOP_BOUNDARY])).rejects.toBe(purgeError)
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      expect(purger.purgeSpaceActor).toHaveBeenCalledTimes(2)
      expect(purger.purgeSpaceActor).toHaveBeenNthCalledWith(1, SPIKE)
      expect(purger.purgeSpaceActor).toHaveBeenNthCalledWith(2, SPIKE)
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.removed).toEqual([{ did: SPIKE, scope: 'actor' }])
    })

    it('does not actor-purge while another boundary has never completed', async () => {
      const bebopSpace = spaceUriFor(BEBOP_BOUNDARY)
      let bebopCalls = 0
      const client = {
        listSpaceRepos: vi.fn(
          async (
            opts: ListSpaceReposOptions,
          ): Promise<ListSpaceReposResult> => {
            if (opts.space !== bebopSpace) {
              throw new Error('nerv membership unavailable')
            }
            bebopCalls += 1
            return bebopCalls === 1
              ? {
                  repos: [
                    {
                      did: SPIKE,
                      custody: 'pds',
                      host: 'https://spike.example',
                    },
                  ],
                }
              : { repos: [] }
          },
        ),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
        onError: vi.fn(),
      })

      await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])

      expect(purger.purgeSpaceDeparture).toHaveBeenCalledExactlyOnceWith(
        SPIKE,
        BEBOP_BOUNDARY,
        bebopSpace,
      )
      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.removed).toEqual([{ did: SPIKE, scope: 'boundary' }])
    })
  })

  describe('presence without a poll target', () => {
    it('does not purge a member who stays enrolled but turns hostless', async () => {
      let calls = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          calls += 1
          return calls === 1
            ? {
                repos: [
                  {
                    did: SPIKE,
                    custody: 'pds',
                    host: 'https://spike.example',
                  },
                ],
              }
            : { repos: [{ did: SPIKE, custody: 'pds' }] }
        }),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.polls).toEqual([])
      expect(outcome.skippedNoHost).toBe(1)
      expect(outcome.removed).toEqual([])
    })

    it('purges a hostless member once a later complete pass confirms departure', async () => {
      let calls = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          calls += 1
          if (calls === 1) {
            return {
              repos: [
                {
                  did: SPIKE,
                  custody: 'pds',
                  host: 'https://spike.example',
                },
              ],
            }
          }
          if (calls === 2) {
            return { repos: [{ did: SPIKE, custody: 'pds' }] }
          }
          return { repos: [] }
        }),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY])
      await tracker.runPass([BEBOP_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      expect(purger.purgeSpaceActor).toHaveBeenCalledWith(SPIKE)
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.removed).toEqual([{ did: SPIKE, scope: 'actor' }])
    })

    it('does not purge a member whose custody flips away from pds', async () => {
      let calls = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          calls += 1
          return calls === 1
            ? {
                repos: [
                  {
                    did: SPIKE,
                    custody: 'pds',
                    host: 'https://spike.example',
                  },
                ],
              }
            : {
                repos: [
                  {
                    did: SPIKE,
                    custody: 'stratos',
                    host: 'https://spike.example',
                  },
                ],
              }
        }),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.polls).toEqual([])
      expect(outcome.removed).toEqual([])
    })

    it('purges a custody-changed member once a later complete pass confirms departure', async () => {
      let calls = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          calls += 1
          if (calls === 1) {
            return {
              repos: [
                {
                  did: SPIKE,
                  custody: 'pds',
                  host: 'https://spike.example',
                },
              ],
            }
          }
          if (calls === 2) {
            return {
              repos: [
                {
                  did: SPIKE,
                  custody: 'stratos',
                  host: 'https://spike.example',
                },
              ],
            }
          }
          return { repos: [] }
        }),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY])
      await tracker.runPass([BEBOP_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      expect(purger.purgeSpaceActor).toHaveBeenCalledWith(SPIKE)
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(outcome.removed).toEqual([{ did: SPIKE, scope: 'actor' }])
    })

    it('boundary-purges a departed member still present but not pollable elsewhere', async () => {
      const bebopSpace = spaceUriFor(BEBOP_BOUNDARY)
      let bebopCalls = 0
      const client = {
        listSpaceRepos: vi.fn(
          async (
            opts: ListSpaceReposOptions,
          ): Promise<ListSpaceReposResult> => {
            if (opts.space !== bebopSpace) {
              return { repos: [{ did: SPIKE, custody: 'stratos' }] }
            }
            bebopCalls += 1
            return bebopCalls === 1
              ? {
                  repos: [
                    {
                      did: SPIKE,
                      custody: 'pds',
                      host: 'https://spike.example',
                    },
                  ],
                }
              : { repos: [] }
          },
        ),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])
      const outcomes = await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])

      expect(purger.purgeSpaceDeparture).toHaveBeenCalledWith(
        SPIKE,
        BEBOP_BOUNDARY,
        bebopSpace,
      )
      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      const bebopOutcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(bebopOutcome.removed).toEqual([{ did: SPIKE, scope: 'boundary' }])
    })
  })

  describe('fault isolation', () => {
    it('does not let one failing boundary stop the others', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              { did: FAYE, custody: 'pds', host: 'https://faye.example' },
            ],
          }),
        ),
      }
      const credentialManager = {
        getCredential: vi.fn(async (boundary: string) => {
          if (boundary === BEBOP_BOUNDARY) {
            throw new Error('mint failed')
          }
          return {
            boundary,
            spaceUri: spaceUriFor(boundary),
            credential: `cred-${boundary}`,
            expiresAt: new Date(Date.now() + 3_600_000),
            createPresentationProof: async () => 'proof',
          }
        }),
      }
      const onError = vi.fn()
      const tracker = new MembershipTracker({
        client,
        credentialManager,
        purger: fakePurger(),
        onError,
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY, NERV_BOUNDARY])
      const failed = outcomeFor(outcomes, BEBOP_BOUNDARY)
      const ok = expectSuccess(outcomeFor(outcomes, NERV_BOUNDARY))
      expect(failed.ok).toBe(false)
      expect(ok.polls).toHaveLength(1)
      expect(onError).toHaveBeenCalledWith(BEBOP_BOUNDARY, expect.any(Error))
    })
  })

  describe('complete-enumeration guard', () => {
    it('purges nothing and keeps last pass poll targets when the mirror fails on page two', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              { did: SPIKE, custody: 'pds', host: 'https://spike.example' },
            ],
          }),
        ),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      const first = await tracker.runPass([BEBOP_BOUNDARY])
      const firstOutcome = expectSuccess(outcomeFor(first, BEBOP_BOUNDARY))
      expect(firstOutcome.polls).toHaveLength(1)

      // Pass 2: page one comes back empty with a cursor (member list looks
      // like it changed), but page two 500s before enumeration completes.
      client.listSpaceRepos
        .mockImplementationOnce(async () => ({
          repos: [],
          cursor: 'page-2',
        }))
        .mockImplementationOnce(async () => {
          throw new Error('mirror 500')
        })

      const second = await tracker.runPass([BEBOP_BOUNDARY])
      const secondOutcome = outcomeFor(second, BEBOP_BOUNDARY)
      expect(secondOutcome.ok).toBe(false)
      expect(secondOutcome.polls).toEqual(firstOutcome.polls)
      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
    })
  })

  describe('default logging', () => {
    it('logs a structured summary to console.log when no log override is given', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              { did: SPIKE, custody: 'pds', host: 'https://spike.example' },
            ],
          }),
        ),
      }
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
      })

      await tracker.runPass([BEBOP_BOUNDARY])

      expect(consoleLog).toHaveBeenCalledWith(
        JSON.stringify({
          msg: 'feedgen.space-membership-pass',
          successfulBoundaries: 1,
          failedBoundaries: 0,
          pollTargets: 1,
          skippedNoHost: 0,
          removed: 0,
        }),
      )
      consoleLog.mockRestore()
    })

    it('logs the failed boundary to console.error when no onError override is given', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          throw new Error('mirror unreachable')
        }),
      }
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
      })

      await tracker.runPass([BEBOP_BOUNDARY])

      expect(consoleError).toHaveBeenCalledWith(
        `space membership pass failed for boundary ${BEBOP_BOUNDARY}:`,
        expect.any(Error),
      )
      consoleError.mockRestore()
    })
  })

  describe('pagination', () => {
    it('pages through listSpaceRepos until the cursor is exhausted', async () => {
      const client = {
        listSpaceRepos: vi
          .fn<(opts: ListSpaceReposOptions) => Promise<ListSpaceReposResult>>()
          .mockResolvedValueOnce({
            repos: [
              { did: SPIKE, custody: 'pds', host: 'https://spike.example' },
            ],
            cursor: 'page-2',
          })
          .mockResolvedValueOnce({
            repos: [
              { did: FAYE, custody: 'pds', host: 'https://faye.example' },
            ],
          }),
      }
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger: fakePurger(),
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])
      const outcome = expectSuccess(outcomeFor(outcomes, BEBOP_BOUNDARY))
      expect(client.listSpaceRepos).toHaveBeenCalledTimes(2)
      expect(outcome.polls.map((p) => p.did).sort()).toEqual(
        [FAYE, SPIKE].sort(),
      )
      expect(client.listSpaceRepos).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'page-2' }),
        expect.anything(),
      )
    })
  })

  describe('enumeration limits', () => {
    it('treats an enumeration exceeding the page ceiling as a failed pass', async () => {
      let page = 0
      const client = {
        listSpaceRepos: vi.fn(async (): Promise<ListSpaceReposResult> => {
          page += 1
          return {
            repos: [
              { did: SPIKE, custody: 'pds', host: 'https://spike.example' },
            ],
            cursor: `page-${page + 1}`,
          }
        }),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
        maxEnumerationPages: 2,
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      const outcome = outcomeFor(outcomes, BEBOP_BOUNDARY)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(MembershipPageLimitError)
        expect(outcome.error).toMatchObject({
          code: 'MembershipPageLimit',
          boundary: BEBOP_BOUNDARY,
          limit: 2,
        })
      }
      expect(outcome.polls).toEqual([])
      expect(client.listSpaceRepos).toHaveBeenCalledTimes(2)
      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
    })

    it('treats a non-advancing cursor as a failed pass', async () => {
      const client = {
        listSpaceRepos: vi.fn(
          async (): Promise<ListSpaceReposResult> => ({
            repos: [
              { did: SPIKE, custody: 'pds', host: 'https://spike.example' },
            ],
            cursor: 'stuck',
          }),
        ),
      }
      const purger = fakePurger()
      const tracker = new MembershipTracker({
        client,
        credentialManager: fakeCredentialManager(),
        purger,
      })

      const outcomes = await tracker.runPass([BEBOP_BOUNDARY])

      const outcome = outcomeFor(outcomes, BEBOP_BOUNDARY)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(MembershipCursorStalledError)
        expect(outcome.error).toMatchObject({
          code: 'MembershipCursorStalled',
          boundary: BEBOP_BOUNDARY,
          cursor: 'stuck',
        })
      }
      expect(client.listSpaceRepos).toHaveBeenCalledTimes(2)
      expect(purger.purgeSpaceActor).not.toHaveBeenCalled()
      expect(purger.purgeSpaceDeparture).not.toHaveBeenCalled()
    })
  })
})
