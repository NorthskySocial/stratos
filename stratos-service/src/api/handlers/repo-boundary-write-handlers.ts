import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import type { AppContext } from '../../context-types.js'
import {
  applyBoundaryWrites,
  type BatchWriteResult,
  type BoundaryWrite,
  deleteRecordInBoundary,
} from '../records/index.js'
import {
  type LexiconCheck,
  requireLexiconValidation,
  skipLexiconValidation,
  validateIfKnown,
} from '../records/lexicon-validation.js'
import { createXrpcHandler } from '../util.js'
import { HANDLER_METHOD } from '../handlers.js'
import { observeRecordOperation } from './repo-write-handlers.js'

interface BoundaryRecordInput {
  boundary: string
  repo: string
  collection: string
  rkey?: string
  validate?: boolean
  record: unknown
}

interface RecordWriteOutput {
  uri: string
  cid: string
  validationStatus?: 'valid' | 'unknown'
}

interface BoundaryDeleteInput {
  boundary: string
  repo: string
  collection: string
  rkey: string
}

// A literal: HANDLER_METHOD is not initialised yet while this module loads.
const APPLY_WRITES_TYPE_PREFIX = 'zone.stratos.repo.applyWrites#'

interface BoundaryApplyWritesInput {
  boundary: string
  repo: string
  validate?: boolean
  writes: Array<{
    $type: string
    collection: string
    rkey?: string
    value?: unknown
  }>
}

type ApplyWritesResult =
  | ({ $type: string } & RecordWriteOutput)
  | { $type: string }

export const createBoundaryRecordHandler = (ctx: AppContext) =>
  createXrpcHandler<BoundaryRecordInput>(
    ctx,
    HANDLER_METHOD.CREATE_BOUNDARY_RECORD,
    {
      handler: async ({ input, did, requestId }) => {
        assertRepoIsCaller(input.repo, did!)
        const { collection, rkey, record } = input
        return writeOne(
          ctx,
          { operation: 'create', logMessage: 'record created', requestId },
          did!,
          input.boundary,
          { kind: 'create', collection, rkey, record },
          lexiconCheckFor(input.validate),
        )
      },
    },
  )

export const putBoundaryRecordHandler = (ctx: AppContext) =>
  createXrpcHandler<BoundaryRecordInput & { rkey: string }>(
    ctx,
    HANDLER_METHOD.PUT_BOUNDARY_RECORD,
    {
      handler: async ({ input, did, requestId }) => {
        assertRepoIsCaller(input.repo, did!)
        const { collection, rkey, record } = input
        return writeOne(
          ctx,
          { operation: 'update', logMessage: 'record written', requestId },
          did!,
          input.boundary,
          { kind: 'put', collection, rkey, record },
          lexiconCheckFor(input.validate),
        )
      },
    },
  )

/** A record that is not in the boundary answers like one that does not exist. */
export const deleteBoundaryRecordHandler = (ctx: AppContext) =>
  createXrpcHandler<BoundaryDeleteInput>(
    ctx,
    HANDLER_METHOD.DELETE_BOUNDARY_RECORD,
    {
      handler: async ({ input, did, requestId }) => {
        assertRepoIsCaller(input.repo, did!)
        const startedAt = Date.now()
        const outcome = await observeRecordOperation(ctx, 'delete', () =>
          deleteRecordInBoundary(
            ctx,
            did!,
            input.boundary,
            input.collection,
            input.rkey,
          ),
        )
        if (outcome.deleted) {
          ctx.logger?.info(
            {
              requestId,
              repo: input.repo,
              collection: input.collection,
              rkey: input.rkey,
              durationMs: Date.now() - startedAt,
            },
            'record deleted',
          )
        }
        return {}
      },
    },
  )

export const applyBoundaryWritesHandler = (ctx: AppContext) =>
  createXrpcHandler<BoundaryApplyWritesInput>(
    ctx,
    HANDLER_METHOD.APPLY_BOUNDARY_WRITES,
    {
      handler: async ({ input, did, requestId }) => {
        assertRepoIsCaller(input.repo, did!)
        const writes = input.writes.map(toBoundaryWrite)
        const startedAt = Date.now()
        const { results } = await observeRecordOperation(ctx, 'batch', () =>
          applyBoundaryWrites(
            ctx,
            did!,
            input.boundary,
            writes,
            lexiconCheckFor(input.validate),
          ),
        )
        ctx.logger?.info(
          {
            requestId,
            count: writes.length,
            durationMs: Date.now() - startedAt,
          },
          'records applied',
        )
        return {
          results: results.map(
            (result, index): ApplyWritesResult =>
              toTypedResult(writes[index], result),
          ),
        }
      },
    },
  )

/** Reads the wire `validate` field once per request: false skips, absent checks what is known, true requires a known lexicon. */
function lexiconCheckFor(validate: boolean | undefined): LexiconCheck {
  if (validate === false) return skipLexiconValidation
  if (validate === true) return requireLexiconValidation
  return validateIfKnown
}

function assertRepoIsCaller(repo: string, callerDid: string): void {
  if (repo !== callerDid) {
    throw new AuthRequiredError('Cannot write a record for another user')
  }
}

interface SingleWriteTelemetry {
  operation: 'create' | 'update'
  logMessage: string
  requestId: string
}

async function writeOne(
  ctx: AppContext,
  telemetry: SingleWriteTelemetry,
  callerDid: string,
  boundary: string,
  write: BoundaryWrite,
  lexiconCheck: LexiconCheck,
): Promise<RecordWriteOutput> {
  const startedAt = Date.now()
  const { results } = await observeRecordOperation(
    ctx,
    telemetry.operation,
    () => applyBoundaryWrites(ctx, callerDid, boundary, [write], lexiconCheck),
  )
  const output = toRecordOutput(results[0])
  ctx.logger?.info(
    {
      requestId: telemetry.requestId,
      uri: output.uri,
      durationMs: Date.now() - startedAt,
    },
    telemetry.logMessage,
  )
  return output
}

function toBoundaryWrite(
  write: BoundaryApplyWritesInput['writes'][number],
): BoundaryWrite {
  const { collection, rkey, value } = write
  switch (write.$type) {
    case `${APPLY_WRITES_TYPE_PREFIX}create`:
      return { kind: 'create', collection, rkey, record: value }
    case `${APPLY_WRITES_TYPE_PREFIX}update`:
      return { kind: 'update', collection, rkey: rkey!, record: value }
    case `${APPLY_WRITES_TYPE_PREFIX}delete`:
      return { kind: 'delete', collection, rkey: rkey! }
    default:
      throw new InvalidRequestError(`Unknown write type ${write.$type}`)
  }
}

function toTypedResult(
  write: BoundaryWrite,
  result: BatchWriteResult,
): ApplyWritesResult {
  if (write.kind === 'delete') {
    return { $type: `${APPLY_WRITES_TYPE_PREFIX}deleteResult` }
  }
  const resultType = write.kind === 'create' ? 'createResult' : 'updateResult'
  return {
    $type: `${APPLY_WRITES_TYPE_PREFIX}${resultType}`,
    ...toRecordOutput(result),
  }
}

/** A create or update result always names the record it wrote. */
function toRecordOutput(result: BatchWriteResult): RecordWriteOutput {
  if (result.uri === undefined || result.cid === undefined) {
    throw new Error('A record write returned no uri and cid')
  }
  return {
    uri: result.uri,
    cid: result.cid,
    ...(result.validationStatus && {
      validationStatus: result.validationStatus,
    }),
  }
}
