import { Agent } from '@atproto/api'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { serviceDIDToRkey } from '../../../oauth/routes.js'
import type { EnrollmentStore } from '../../../oauth/routes.js'

/**
 * Dependencies for one PDS enrollment-record sync attempt.
 */
export interface PdsEnrollmentSyncDeps {
  enrollmentStore: Pick<EnrollmentStore, 'getEnrollment' | 'getBoundaries'>
  createAttestation(
    did: string,
    boundaries: string[],
    userDidKey: string,
  ): Promise<{ sig: Uint8Array; signingKey: string }>
  oauthClient: Pick<NodeOAuthClient, 'restore'>
  serviceDid: string
  publicUrl: string
}

/**
 * `'obsolete'` means the actor is no longer enrolled (or has no signing key),
 * so there is nothing to write and the job must be dropped.
 */
export type PdsEnrollmentSyncResult = 'ok' | 'obsolete'

/**
 * Rewrite the actor's `zone.stratos.actor.enrollment` PDS record from current
 * enrollment-store state. Boundaries are re-derived here (not passed in) so a
 * deferred job always writes the truth at execution time, and superseding
 * admin mutations converge on one final write.
 *
 * @param signal - Aborts the attempt; the PDS write receives it directly
 * @returns `'ok'` on success, `'obsolete'` when there is nothing to sync
 * @throws The underlying OAuth/PDS error; classify with
 *   {@link classifyPdsSyncError}
 */
export async function syncEnrollmentRecordToPds(
  deps: PdsEnrollmentSyncDeps,
  did: string,
  signal: AbortSignal,
): Promise<PdsEnrollmentSyncResult> {
  const enrollment = await deps.enrollmentStore.getEnrollment(did)
  if (!enrollment?.signingKeyDid) return 'obsolete'

  const boundaries = await deps.enrollmentStore.getBoundaries(did)
  const attestation = await deps.createAttestation(
    did,
    boundaries,
    enrollment.signingKeyDid,
  )

  const rkey = serviceDIDToRkey(deps.serviceDid)
  // `restore` accepts no signal, so race it against the deadline. That is
  // safe: it writes no PDS records, and the OAuth client serializes token
  // refreshes per subject, so an orphaned refresh cannot overlap a later
  // attempt's. The only write is `putRecord`, which carries the real signal
  // and is aborted on the wire.
  const oauthSession = await untilAborted(deps.oauthClient.restore(did), signal)
  const agent = new Agent(oauthSession)

  await agent.com.atproto.repo.putRecord(
    {
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey,
      record: {
        service: deps.publicUrl,
        boundaries: boundaries.map((value) => ({ value })),
        signingKey: enrollment.signingKeyDid,
        attestation: {
          sig: attestation.sig,
          signingKey: attestation.signingKey,
        },
        createdAt: new Date().toISOString(),
      },
    },
    { signal },
  )

  return 'ok'
}

/** Settle with the promise, or reject with the signal's reason on abort. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error)
      return
    }
    const onAbort = () => reject(signal.reason as Error)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * `'terminal'` failures cannot succeed on retry without operator/user action
 * (the user must re-authorize OAuth); everything else is `'transient'`.
 */
export type PdsSyncErrorClass = 'terminal' | 'transient'

const TERMINAL_ERROR_NAMES = new Set([
  // Missing stored session and refresh rejection both surface as
  // TokenRefreshError; revoked/invalid sessions have their own classes.
  'TokenRefreshError',
  'TokenRevokedError',
  'TokenInvalidError',
])

/**
 * Classify a PDS sync failure. Matches defensively on error/constructor names,
 * the OAuth `error` field, and HTTP status — the `@atproto/oauth-client-node`
 * error shapes are not a stable API, so unknown errors default to transient
 * and the worker's max-attempts cap is the terminal backstop.
 *
 * @param err - The error thrown by {@link syncEnrollmentRecordToPds}
 * @returns The failure class
 */
export function classifyPdsSyncError(err: unknown): PdsSyncErrorClass {
  if (!(err instanceof Error)) return 'transient'

  if (
    TERMINAL_ERROR_NAMES.has(err.name) ||
    TERMINAL_ERROR_NAMES.has(err.constructor.name)
  ) {
    return 'terminal'
  }

  const oauthError = (err as { error?: unknown }).error
  if (oauthError === 'invalid_grant') return 'terminal'

  const status = (err as { status?: unknown }).status
  if (status === 401 || status === 403) return 'terminal'

  return 'transient'
}
