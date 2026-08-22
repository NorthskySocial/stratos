import { Server as XrpcServer } from '@atproto/xrpc-server'

export interface HandlerAuth {
  credentials: {
    type: string
    did?: string
    iss?: string
    /**
     * Present ONLY for space-credential auth. The space's `at://` URI the
     * credential admits the caller to. When set, the
     * caller has NO `did` — visibility is scoped to this space's boundary and
     * still filtered per-record by the existing boundary gate.
     */
    spaceUri?: string
    /**
     * Present for DPoP user auth: the SHA-256 JWK thumbprint of the caller's
     * DPoP key (RFC 9449 `jkt`). Used to bind minted space credentials to the
     * requesting key via `cnf.jkt`.
     */
    jkt?: string
  }
}

export interface HandlerInput {
  encoding?: string
  body?: unknown
}

export type HandlerParams = Record<string, unknown>

/**
 * Minimal view of the underlying HTTP request that the XRPC layer gives to
 * handlers. The runtime value is the live Express request. Handlers must
 * depend only on this shape.
 */
export interface HandlerRequest {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
  auth?: HandlerAuth
}

export interface HandlerContext {
  input?: HandlerInput
  params: HandlerParams
  auth?: HandlerAuth
  req?: HandlerRequest
}

export interface HandlerResponse {
  encoding: string
  body: unknown
}

export type HandlerFn = (ctx: HandlerContext) => Promise<HandlerResponse>

// Type for accessing internal method - needed until lexicons are properly loaded
export interface XrpcServerInternal extends Omit<XrpcServer, 'method'> {
  method(nsid: string, config: Record<string, unknown>): void
}
