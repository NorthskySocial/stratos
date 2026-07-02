import { Server as XrpcServer } from '@atproto/xrpc-server'

export interface HandlerAuth {
  credentials: {
    type: string
    did?: string
    iss?: string
    /**
     * Present ONLY for space-credential auth (SWP-07). The three-component
     * `ats://` space URI the credential admits the caller to. When set, the
     * caller has NO `did` — visibility is scoped to this space's boundary and
     * still filtered per-record by the existing boundary gate.
     */
    spaceUri?: string
  }
}

export interface HandlerInput {
  encoding?: string
  body?: unknown
}

export type HandlerParams = Record<string, unknown>

export interface HandlerContext {
  input?: HandlerInput
  params: HandlerParams
  auth?: HandlerAuth
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req?: any // Support for access to underlying request
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
