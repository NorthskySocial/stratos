import { AuthRequiredError, InvalidRequestError } from '@atproto/xrpc-server'
import { StratosError } from '@northskysocial/stratos-core'
import type { AppContext } from '../context.js'
import type {
  HandlerAuth,
  HandlerContext,
  HandlerFn,
  HandlerInput,
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
export function makeRequestId(method: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${method}-${Date.now().toString(36)}-${rand}`
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
    const { auth, input, params } = handlerCtx

    let did: string | undefined
    if (auth?.credentials?.did) {
      did = auth.credentials.did
    }

    if (options.requireAuth !== false && !did) {
      throw new AuthRequiredError()
    }

    ctx.logger?.debug(
      {
        requestId,
        method: methodName,
        did,
        params,
      },
      'handling request',
    )

    try {
      const result = await options.handler({
        input: input?.body as TInput,
        params: params as TParams,
        auth,
        did,
        requestId,
        fullInput: input,
      })

      const durationMs = Date.now() - start
      ctx.logger?.info(
        {
          requestId,
          method: methodName,
          did,
          durationMs,
        },
        'request completed',
      )

      return {
        encoding: 'application/json',
        body: result,
      }
    } catch (err) {
      const durationMs = Date.now() - start

      // Map StratosError to XRPC errors
      if (err instanceof StratosError) {
        ctx.logger?.warn(
          {
            requestId,
            method: methodName,
            did,
            code: err.code,
            durationMs,
          },
          err.message,
        )
        throw new InvalidRequestError(err.message, err.code)
      }

      // Log unexpected errors
      ctx.logger?.error(
        {
          requestId,
          method: methodName,
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
  }
}
