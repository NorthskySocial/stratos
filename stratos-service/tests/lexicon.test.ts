/**
 * Smoke test: Stratos lexicons are compatible with @atproto XrpcServer
 */
import { describe, it, expect } from 'vitest'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { schemas as atprotoSchemas } from '@atproto/api'
import { loadStratosLexicons } from '../src/context.js'

describe('Stratos Lexicons', () => {
  it('should create XrpcServer with combined ATProto and Stratos lexicons', () => {
    const stratosLexicons = loadStratosLexicons()
    const allLexicons = [...atprotoSchemas, ...stratosLexicons]

    expect(() => {
      new XrpcServer(allLexicons)
    }).not.toThrow()
  })
})
