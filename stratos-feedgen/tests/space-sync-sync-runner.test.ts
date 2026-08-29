import { describe, expect, it, vi } from 'vitest'
import type { PurgeCounts } from '../src/purge/index.js'
import {
  SpaceSyncRunner,
  type CommitVerifyResult,
  type PollTarget,
  type SpaceCommitConsecutiveFailureLogEvent,
  type SpaceCommitVerifyLogEvent,
  type SpaceSyncRunnerDeps,
  type SpaceSyncResult,
  type SpaceSyncSuccess,
} from '../src/space-sync/index.js'

// 90s-anime crew DIDs and boundaries, matching the other space-sync fixtures.
const STRATOS_DID = 'did:web:stratos.test'
const BEBOP_BOUNDARY = `${STRATOS_DID}/bebop-crew`
const SPACE_URI = `at://${STRATOS_DID}/space/zone.stratos.space.feed/bebop-crew`
const SPIKE_DID = 'did:plc:spikespiegel'
const FAYE_DID = 'did:plc:fayevalentine'
const HOST = 'https://spike.example'

function makeTarget(overrides: Partial<PollTarget> = {}): PollTarget {
  return {
    spaceUri: SPACE_URI,
    boundary: BEBOP_BOUNDARY,
    did: SPIKE_DID,
    host: HOST,
    ...overrides,
  }
}

function makeSyncSuccess(
  overrides: Partial<SpaceSyncSuccess> = {},
): SpaceSyncSuccess {
  return {
    target: makeTarget(),
    ok: true,
    pagesFetched: 1,
    recordsIndexed: 1,
    recordsDeleted: 0,
    skippedOversized: 0,
    skippedMalformed: 0,
    stopReason: 'complete',
    ...overrides,
  }
}

function zeroCounts(): PurgeCounts {
  return { posts: 0, cursors: 0, enrolledActors: 0, boundaryCache: 0 }
}

function fakeSyncer() {
  return {
    syncTarget: vi.fn<(target: PollTarget) => Promise<SpaceSyncResult>>(
      async () => makeSyncSuccess(),
    ),
  }
}

function fakeVerifier() {
  return {
    verify: vi.fn<
      (
        spaceUri: string,
        authorDid: string,
        commit: Record<string, unknown> | undefined,
      ) => Promise<CommitVerifyResult>
    >(async () => ({ ok: true })),
  }
}

function fakeStore() {
  return {
    deleteSpaceCursor: vi.fn(
      async (_spaceUri: string, _did: string): Promise<number> => 1,
    ),
  }
}

function fakePurger() {
  return {
    purgeActorBoundary: vi.fn(
      async (
        _did: string,
        _boundary: string,
        _trigger?: string,
      ): Promise<PurgeCounts> => zeroCounts(),
    ),
  }
}

interface BuildRunnerOptions {
  syncer?: ReturnType<typeof fakeSyncer>
  verifier?: ReturnType<typeof fakeVerifier>
  store?: ReturnType<typeof fakeStore>
  purger?: ReturnType<typeof fakePurger>
  onVerifyFailure?: SpaceSyncRunnerDeps['onVerifyFailure']
  onVerifyTransient?: SpaceSyncRunnerDeps['onVerifyTransient']
  onConsecutiveFailure?: SpaceSyncRunnerDeps['onConsecutiveFailure']
  onError?: SpaceSyncRunnerDeps['onError']
}

function buildRunner(opts: BuildRunnerOptions = {}): {
  runner: SpaceSyncRunner
  syncer: ReturnType<typeof fakeSyncer>
  verifier: ReturnType<typeof fakeVerifier>
  store: ReturnType<typeof fakeStore>
  purger: ReturnType<typeof fakePurger>
} {
  const syncer = opts.syncer ?? fakeSyncer()
  const verifier = opts.verifier ?? fakeVerifier()
  const store = opts.store ?? fakeStore()
  const purger = opts.purger ?? fakePurger()
  const runner = new SpaceSyncRunner({
    syncer,
    verifier,
    store,
    purger,
    onVerifyFailure: opts.onVerifyFailure,
    onVerifyTransient: opts.onVerifyTransient,
    onConsecutiveFailure: opts.onConsecutiveFailure,
    onError: opts.onError,
  })
  return { runner, syncer, store, purger, verifier }
}

describe('SpaceSyncRunner', () => {
  describe('terminal success', () => {
    it('passes the sync result through unchanged on a verified commit', async () => {
      const success = makeSyncSuccess({ finalCommit: { sig: 'abc' } })
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(success)
      const verifier = fakeVerifier()
      const { runner, purger, store } = buildRunner({ syncer, verifier })

      const result = await runner.runTarget(makeTarget())

      expect(result).toBe(success)
      expect(verifier.verify).toHaveBeenCalledWith(SPACE_URI, SPIKE_DID, {
        sig: 'abc',
      })
      expect(purger.purgeActorBoundary).not.toHaveBeenCalled()
      expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
    })
  })

  describe('non-terminal stops', () => {
    it.each(['max-pages', 'per-member-cap'] as const)(
      'skips verification entirely when the pass stops for %s',
      async (stopReason) => {
        const success = makeSyncSuccess({ stopReason })
        const syncer = fakeSyncer()
        syncer.syncTarget.mockResolvedValue(success)
        const verifier = fakeVerifier()
        const { runner, purger, store } = buildRunner({ syncer, verifier })

        const result = await runner.runTarget(makeTarget())

        expect(result).toBe(success)
        expect(verifier.verify).not.toHaveBeenCalled()
        expect(purger.purgeActorBoundary).not.toHaveBeenCalled()
        expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
      },
    )
  })

  describe('sync failure', () => {
    it('passes a sync failure through without attempting verification', async () => {
      const failure: SpaceSyncResult = {
        target: makeTarget(),
        ok: false,
        reason: 'member-skip',
        error: new Error('host unreachable'),
      }
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(failure)
      const verifier = fakeVerifier()
      const { runner, purger, store } = buildRunner({ syncer, verifier })

      const result = await runner.runTarget(makeTarget())

      expect(result).toBe(failure)
      expect(verifier.verify).not.toHaveBeenCalled()
      expect(purger.purgeActorBoundary).not.toHaveBeenCalled()
      expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
    })
  })

  describe('non-transient verification failure', () => {
    it('purges the boundary, drops the cursor, and reports commit-verify-failed', async () => {
      const success = makeSyncSuccess({ finalCommit: { sig: 'abc' } })
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(success)
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const onVerifyFailure = vi.fn<(event: SpaceCommitVerifyLogEvent) => void>()
      const { runner, purger, store } = buildRunner({
        syncer,
        verifier,
        onVerifyFailure,
      })

      const result = await runner.runTarget(makeTarget())

      expect(purger.purgeActorBoundary).toHaveBeenCalledWith(
        SPIKE_DID,
        BEBOP_BOUNDARY,
        'space-commit-invalid',
      )
      expect(store.deleteSpaceCursor).toHaveBeenCalledWith(
        SPACE_URI,
        SPIKE_DID,
      )
      expect(onVerifyFailure).toHaveBeenCalledWith({
        target: makeTarget(),
        reason: 'mac-mismatch',
      })
      expect(result).toEqual({
        target: makeTarget(),
        ok: false,
        reason: 'commit-verify-failed',
        commitVerifyReason: 'mac-mismatch',
      })
    })

    it('treats a commit-less terminal page as a verification failure', async () => {
      const success = makeSyncSuccess({ finalCommit: undefined })
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(success)
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'missing-commit',
        transient: false,
      })
      const { runner, purger, store } = buildRunner({ syncer, verifier })

      const result = await runner.runTarget(makeTarget())

      expect(verifier.verify).toHaveBeenCalledWith(
        SPACE_URI,
        SPIKE_DID,
        undefined,
      )
      expect(purger.purgeActorBoundary).toHaveBeenCalledTimes(1)
      expect(store.deleteSpaceCursor).toHaveBeenCalledTimes(1)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('commit-verify-failed')
    })
  })

  describe('transient verification failure', () => {
    it('does not purge or drop the cursor, and passes the sync result through', async () => {
      const success = makeSyncSuccess({ finalCommit: { sig: 'abc' } })
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(success)
      const verifier = fakeVerifier()
      const resolveError = new Error('plc directory unreachable')
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'key-unresolvable',
        transient: true,
        error: resolveError,
      })
      const onVerifyTransient = vi.fn<
        (event: SpaceCommitVerifyLogEvent, error: unknown) => void
      >()
      const { runner, purger, store } = buildRunner({
        syncer,
        verifier,
        onVerifyTransient,
      })

      const result = await runner.runTarget(makeTarget())

      expect(result).toBe(success)
      expect(purger.purgeActorBoundary).not.toHaveBeenCalled()
      expect(store.deleteSpaceCursor).not.toHaveBeenCalled()
      expect(onVerifyTransient).toHaveBeenCalledWith(
        { target: makeTarget(), reason: 'key-unresolvable' },
        resolveError,
      )
    })
  })

  describe('consecutive-failure streak', () => {
    it('does not warn after a single non-transient failure', async () => {
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const onConsecutiveFailure = vi.fn<
        (event: SpaceCommitConsecutiveFailureLogEvent) => void
      >()
      const { runner } = buildRunner({ syncer, verifier, onConsecutiveFailure })

      await runner.runTarget(makeTarget())

      expect(onConsecutiveFailure).not.toHaveBeenCalled()
    })

    it('warns on the second consecutive non-transient failure for the same target', async () => {
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const onConsecutiveFailure = vi.fn<
        (event: SpaceCommitConsecutiveFailureLogEvent) => void
      >()
      const { runner } = buildRunner({ syncer, verifier, onConsecutiveFailure })

      await runner.runTarget(makeTarget())
      await runner.runTarget(makeTarget())

      expect(onConsecutiveFailure).toHaveBeenCalledTimes(1)
      expect(onConsecutiveFailure).toHaveBeenCalledWith({
        target: makeTarget(),
        streak: 2,
      })
    })

    it('resets the streak after an intervening success', async () => {
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify
        .mockResolvedValueOnce({
          ok: false,
          reason: 'mac-mismatch',
          transient: false,
        })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: false,
          reason: 'mac-mismatch',
          transient: false,
        })
      const onConsecutiveFailure = vi.fn<
        (event: SpaceCommitConsecutiveFailureLogEvent) => void
      >()
      const { runner } = buildRunner({ syncer, verifier, onConsecutiveFailure })

      await runner.runTarget(makeTarget())
      await runner.runTarget(makeTarget())
      await runner.runTarget(makeTarget())

      expect(onConsecutiveFailure).not.toHaveBeenCalled()
    })

    it('tracks the streak independently per member', async () => {
      const syncer = fakeSyncer()
      syncer.syncTarget.mockImplementation(async (target) =>
        makeSyncSuccess({ target, finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const onConsecutiveFailure = vi.fn<
        (event: SpaceCommitConsecutiveFailureLogEvent) => void
      >()
      const { runner } = buildRunner({ syncer, verifier, onConsecutiveFailure })

      await runner.runTarget(makeTarget({ did: SPIKE_DID }))
      await runner.runTarget(makeTarget({ did: FAYE_DID }))

      expect(onConsecutiveFailure).not.toHaveBeenCalled()
    })
  })

  describe('settlement failure', () => {
    it('recovers when purging a bad commit itself throws', async () => {
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const purger = fakePurger()
      const purgeError = new Error('database unreachable')
      purger.purgeActorBoundary.mockRejectedValue(purgeError)
      const onError = vi.fn()
      const { runner } = buildRunner({ syncer, verifier, purger, onError })

      const result = await runner.runTarget(makeTarget())

      expect(result).toEqual({
        target: makeTarget(),
        ok: false,
        reason: 'member-skip',
        error: purgeError,
      })
      expect(onError).toHaveBeenCalledWith(makeTarget(), purgeError)
    })
  })

  describe('default logging', () => {
    it('logs a non-transient verification failure to console.error by default', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const { runner } = buildRunner({ syncer, verifier })

      await runner.runTarget(makeTarget())

      expect(consoleError).toHaveBeenCalledWith(
        `space commit verification failed for ${SPIKE_DID} in ${SPACE_URI}: mac-mismatch`,
      )
      consoleError.mockRestore()
    })

    it('warns on a consecutive failure to console.warn by default', async () => {
      const consoleWarn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {})
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const { runner } = buildRunner({ syncer, verifier })

      await runner.runTarget(makeTarget())
      await runner.runTarget(makeTarget())

      expect(consoleWarn).toHaveBeenCalledWith(
        `space commit verification has failed 2 consecutive passes for ${SPIKE_DID} in ${SPACE_URI}`,
      )
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    })

    it('warns on a transient verification failure to console.warn by default', async () => {
      const consoleWarn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {})
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      const resolveError = new Error('plc directory unreachable')
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'key-unresolvable',
        transient: true,
        error: resolveError,
      })
      const { runner } = buildRunner({ syncer, verifier })

      await runner.runTarget(makeTarget())

      expect(consoleWarn).toHaveBeenCalledWith(
        `space commit verification could not resolve a key for ${SPIKE_DID} in ${SPACE_URI}, skipping this pass:`,
        resolveError,
      )
      consoleWarn.mockRestore()
    })

    it('logs a settlement failure to console.error by default', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const syncer = fakeSyncer()
      syncer.syncTarget.mockResolvedValue(
        makeSyncSuccess({ finalCommit: { sig: 'abc' } }),
      )
      const verifier = fakeVerifier()
      verifier.verify.mockResolvedValue({
        ok: false,
        reason: 'mac-mismatch',
        transient: false,
      })
      const purger = fakePurger()
      const purgeError = new Error('database unreachable')
      purger.purgeActorBoundary.mockRejectedValue(purgeError)
      const { runner } = buildRunner({ syncer, verifier, purger })

      await runner.runTarget(makeTarget())

      expect(consoleError).toHaveBeenCalledWith(
        `failed to settle a space commit verification failure for ${SPIKE_DID} in ${SPACE_URI}:`,
        purgeError,
      )
      consoleError.mockRestore()
    })
  })
})
