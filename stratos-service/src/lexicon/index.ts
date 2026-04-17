/**
 * GENERATED CODE - DO NOT MODIFY
 */
import {
  createServer as createXrpcServer,
  type Options as XrpcOptions,
  Server as XrpcServer,
} from '@atproto/xrpc-server'
import { schemas } from './lexicons.js'

export function createServer(options?: XrpcOptions): Server {
  return new Server(options)
}

export class Server {
  xrpc: XrpcServer

  constructor(options?: XrpcOptions) {
    this.xrpc = createXrpcServer(schemas, options)
  }
}
