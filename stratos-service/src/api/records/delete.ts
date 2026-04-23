import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { RepoWrite } from '@northskysocial/stratos-core'
import { AtUri as AtUriSyntax } from '@atproto/syntax'
import type { AppContext } from '../../context.js'
import { createRepoManager } from './util.js'
import { type SequenceTrace, type WritePhases } from './types.js'
import { withConcurrencyRetry } from './validation.js'

/**
 * Input parameters for record deletion
 */
export interface DeleteRecordInput {
  repo: string
  collection: string
  rkey: string
  swapRecord?: string
  swapCommit?: string
  requestId?: string
}

/**
 * Delete a record from the stratos store
 *
 * @param ctx - Application context
 * @param input - Input parameters for record deletion
 * @param callerDid - DID of the caller
 * @returns Output containing commit information
 */
export async function deleteRecord(
  ctx: AppContext,
  input: DeleteRecordInput,
  callerDid: string,
): Promise<{ commit?: { cid: string; rev: string }; phases?: WritePhases }> {
  const phases: WritePhases = {}
  const { repo, collection, rkey } = input
  const sequenceTrace: SequenceTrace = {
    requestId: input.requestId,
    queuedAtMs: Date.now(),
  }

  // Must be deleting own record
  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot delete record for another user')
  }

  ctx.writeRateLimiter.assertWriteAllowed(callerDid)

  // Validate collection
  if (!collection.startsWith('zone.stratos.')) {
    throw new InvalidRequestError(
      'Only zone.stratos.* collections are supported',
      'InvalidCollection',
    )
  }

  const uriStr = `at://${callerDid}/${collection}/${rkey}`
  const uri = new AtUriSyntax(uriStr)

  const actorSigningKey = await ctx.getActorSigningKey(callerDid)

  const t0 = performance.now()
  const unlock = await ctx.repoWriteLocks.acquire(callerDid)
  let result: { commit: { cid: string; rev: string } }
  let retries: number
  try {
    const retry = await withConcurrencyRetry(async () => {
      const attemptT0 = performance.now()
      // See create.ts for why we use transact() and pass store.repo directly.
      return ctx.actorStore.transact(callerDid, async (store) => {
        phases.connAcquire = performance.now() - attemptT0
        const manager = createRepoManager(
          ctx.logger,
          store,
          actorSigningKey,
          sequenceTrace,
        )

        const repoWrites: RepoWrite[] = [{ action: 'delete', collection, rkey }]

        const writeResult = await manager.applyWrites(
          callerDid,
          repoWrites,
          store.repo,
        )

        const ti = performance.now()
        await store.record.deleteRecord(uri.toString())
        phases.transactPersist = performance.now() - ti

        return {
          commit: {
            cid: writeResult.commitCid.toString(),
            rev: writeResult.rev,
          },
        }
      })
    }, ctx.logger)
    result = retry.result
    retries = retry.retries
  } finally {
    unlock()
  }
  phases.transact = performance.now() - t0
  phases.retries = retries

  // Notify subscribers
  ctx.sequenceEvents.emit(callerDid)

  // Delete stub from user's PDS (background, non-blocking)
  ctx.stubQueue.enqueueDelete(callerDid, collection, rkey)

  return { ...result, phases }
}
