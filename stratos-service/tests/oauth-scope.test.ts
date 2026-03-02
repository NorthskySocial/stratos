import { describe, it, expect, vi } from 'vitest'
import { OAUTH_SCOPE } from '../src/oauth/client.js'
import { PdsTokenVerifier } from '../src/auth/introspection-client.js'
import { IdResolver } from '@atproto/identity'

describe('OAUTH_SCOPE', () => {
  it('should contain the atproto base scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('atproto')
  })

  it('should contain enrollment record scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('repo:zonestratos.actor.enrollment')
  })

  it('should contain post record scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('repo:zonestratos.feed.post')
  })

  it('should not contain transition:generic', () => {
    expect(OAUTH_SCOPE).not.toContain('transition:generic')
  })

  it('should be a space-separated string of exactly 3 scopes', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toHaveLength(3)
  })

  it('should match the expected full value', () => {
    expect(OAUTH_SCOPE).toBe(
      'atproto repo:zonestratos.actor.enrollment repo:zonestratos.feed.post',
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
