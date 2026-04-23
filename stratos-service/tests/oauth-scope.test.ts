import { describe, expect, it, vi } from 'vitest'
import { OAUTH_SCOPE } from '../src/oauth'
import { IdResolver } from '@atproto/identity'
import { PdsTokenVerifier } from '../src/infra/auth'

describe('OAUTH_SCOPE', () => {
  it('should contain the atproto base scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('atproto')
  })

  it('should contain enrollment record scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('repo:zone.stratos.actor.enrollment')
  })

  it('should contain post record scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('repo:zone.stratos.feed.post')
  })

  it('should match the expected full value', () => {
    expect(OAUTH_SCOPE).toBe(
      'atproto repo:zone.stratos.actor.enrollment repo:zone.stratos.feed.post',
    )
  })
})

describe('PdsTokenVerifier audience config', () => {
  it('should accept config without audience', () => {
    const idResolver = {
      did: { resolve: vi.fn() },
      handle: { resolve: vi.fn() },
    } as unknown as IdResolver

    // This is how context.ts now constructs the verifier — no audience field
    const verifier = new PdsTokenVerifier({ idResolver })

    expect(verifier).toBeDefined()
  })

  it('should still accept config with audience for backward compat', () => {
    const idResolver = {
      did: { resolve: vi.fn() },
      handle: { resolve: vi.fn() },
    } as unknown as IdResolver

    const verifier = new PdsTokenVerifier({
      idResolver,
      audience: 'https://stratos.example.com',
    })

    expect(verifier).toBeDefined()
  })
})
