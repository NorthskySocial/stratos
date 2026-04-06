import { Server as XrpcServer } from '@atproto/xrpc-server'

export interface HandlerAuth {
  credentials: {
    type: string
    did?: string
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
