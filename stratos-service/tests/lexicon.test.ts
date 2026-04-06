/**
 * Smoke test: Stratos lexicons are compatible with @atproto XrpcServer
 */
import { describe, expect, it } from 'vitest'
import { Server as XrpcServer } from '@atproto/xrpc-server'
import { schemas as atprotoSchemas } from '@atproto/api'
import { stratosLexicons } from '@northskysocial/stratos-core'

describe('Stratos Lexicons', () => {
  it('should create XrpcServer with combined ATProto and Stratos lexicons', () => {
    const combined = [...atprotoSchemas, ...stratosLexicons]
    const uniqueLexicons = Array.from(
      new Map(combined.map((lex) => [lex.id, lex])).values(),
    )

    expect(() => {
      new XrpcServer(uniqueLexicons)
    }).not.toThrow()
  })
})
