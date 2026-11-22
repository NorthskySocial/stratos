import type { Logger } from '@northskysocial/stratos-core'
import type { PdsEnrollmentSyncWorker } from './pds-sync-worker.js'

export interface RepublishEnrollmentRecordDeps {
  pdsSyncWorker: Pick<PdsEnrollmentSyncWorker, 'enqueue' | 'kick'>
  logger?: Logger
}

/**
 * Puts back the PDS enrollment record of a member whose unenrollment deleted it
 * and was then refused by a hold. The refusal stands whatever happens here; a
 * failed attempt stays queued for the worker.
 */
export async function republishEnrollmentRecord(
  deps: RepublishEnrollmentRecordDeps,
  did: string,
): Promise<void> {
  try {
    const generation = await deps.pdsSyncWorker.enqueue(did)
    await deps.pdsSyncWorker.kick(did, generation)
  } catch (err) {
    deps.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), did },
      'failed to republish PDS enrollment record after a refused unenrollment',
    )
  }
}
