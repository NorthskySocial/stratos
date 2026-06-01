import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { StratosError } from '@northskysocial/stratos-core'
import type { AppContext } from '../context.js'
import type {
  HandlerAuth,
  HandlerContext,
  HandlerFn,
  HandlerInput,
  HandlerParams,
  HandlerResponse,
} from './types.js'

/**
 * Validates user authentication and returns their DID
 *
 * @param auth - Handler authentication context
 * @returns Object with DID property
 */
export function validateUserAuth(auth: HandlerAuth | undefined): {
  did: string
} {
  if (!auth?.credentials?.did) {
    throw new AuthRequiredError()
  }
  return { did: auth.credentials.did }
}

/**
 * Creates a unique request ID for a method
 *
 * @param method - Method name
 * @returns Unique request ID
 */
function makeRequestId(method: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${method}-${Date.now().toString(36)}-${rand}`
}

/**
 * Extracts DID from handler context
 *
 * @param handlerCtx - XRPC handler context
 * @returns DID if found
 */
function extractDid(handlerCtx: HandlerContext): string | undefined {
  const { auth } = handlerCtx
  if (auth?.credentials?.did) {
    return auth.credentials.did
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (handlerCtx.req?.auth?.credentials?.did) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return,@typescript-eslint/no-unsafe-member-access
    return handlerCtx.req.auth.credentials.did
  }
  return undefined
}

/**
 * Maps StratosError to XRPC errors and logs if necessary
 *
 * @param err - Error to handle
 * @param ctx - Application context
 * @param logInfo - Logging metadata
 * @throws InvalidRequestError if err is StratosError, otherwise rethrows err
 */
function handleRequestError(
  err: unknown,
  ctx: AppContext,
  logInfo: {
    requestId: string
    method: string
    did?: string
    durationMs: number
  },
): never {
  const { requestId, method, did, durationMs } = logInfo

  if (err instanceof StratosError) {
    ctx.logger?.warn(
      {
        requestId,
        method,
        did,
        code: err.code,
        durationMs,
      },
      err.message,
    )
    throw new InvalidRequestError(err.message, err.code)
  }

  // Handle XRPC errors by name if instanceof fails (common in monorepos/test envs)
  const errName = err?.constructor?.name
  if (errName === 'InvalidRequestError' || errName === 'AuthRequiredError') {
    throw err
  }

  // Log unexpected errors
  ctx.logger?.error(
    {
      requestId,
      method,
      did,
      durationMs,
      err:
        err instanceof Error
          ? { message: err.message, stack: err.stack }
          : String(err),
    },
    'request failed',
  )

  throw err
}

/**
 * Logs the start of an XRPC request
 *
 * @param ctx - Application context
 * @param logInfo - Logging metadata
 */
function logRequestStart(
  ctx: AppContext,
  logInfo: {
    requestId: string
    method: string
    did?: string
    params: HandlerParams
  },
): void {
  ctx.logger?.debug(logInfo, 'handling request')
}

/**
 * Logs the successful completion of an XRPC request
 *
 * @param ctx - Application context
 * @param logInfo - Logging metadata
 */
function logRequestSuccess(
  ctx: AppContext,
  logInfo: {
    requestId: string
    method: string
    did?: string
    durationMs: number
  },
): void {
  ctx.logger?.info(logInfo, 'request completed')
}

/**
 * Utility to create an XRPC handler with common logic (auth, logging, error handling)
 *
 * @param ctx - Application context
 * @param methodName - Method name
 * @param options - Handler options
 * @returns XRPC handler function
 */
export function createXrpcHandler<
  TInput = unknown,
  TParams = Record<string, unknown>,
>(
  ctx: AppContext,
  methodName: string,
  options: {
    handler: (args: {
      input: TInput
      params: TParams
      auth: HandlerAuth | undefined
      did: string | undefined
      requestId: string
      fullInput?: HandlerInput
    }) => Promise<unknown>
    requireAuth?: boolean
  },
): HandlerFn {
  return async (handlerCtx: HandlerContext): Promise<HandlerResponse> => {
    const requestId = makeRequestId(methodName.split('.').pop() || methodName)
    const start = Date.now()
    const { auth, input } = handlerCtx

    const params =
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      (handlerCtx as any).params || (handlerCtx as any).req?.query || {}
    const did = extractDid(handlerCtx)

    if (options.requireAuth !== false && !did) {
      throw new AuthRequiredError()
    }

    logRequestStart(ctx, {
      requestId,
      method: methodName,
      did,
      params,
    })

    try {
      const result = await options.handler({
        input: input?.body as TInput,
        params: params as TParams,
        auth,
        did,
        requestId,
        fullInput: input,
      })

      logRequestSuccess(ctx, {
        requestId,
        method: methodName,
        did,
        durationMs: Date.now() - start,
      })

      if (
        result &&
        typeof result === 'object' &&
        'encoding' in result &&
        'body' in result
      ) {
        return result as HandlerResponse
      }

      return {
        encoding: 'application/json',
        body: result,
      }
    } catch (err) {
      console.error(`Error in XRPC handler ${methodName}:`, err)
      handleRequestError(err, ctx, {
        requestId,
        method: methodName,
        did,
        durationMs: Date.now() - start,
      })
    }
  }
}
