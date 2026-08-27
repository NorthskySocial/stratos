import { describe, expect, it, vi } from 'vitest'
import {
  buildOAuthScope,
  buildSpaceScope,
  OAUTH_SCOPE,
} from '../src/oauth/index.js'
import { IdResolver } from '@atproto/identity'
import { PdsTokenVerifier } from '../src/infra/auth/index.js'

describe('OAUTH_SCOPE', () => {
  it('should contain the atproto base scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('atproto')
  })

  it('should contain enrollment record scope', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).toContain('repo:zone.stratos.actor.enrollment')
  })

  it('no longer requests the feed.post write scope (stub writes removed)', () => {
    const scopes = OAUTH_SCOPE.split(' ')
    expect(scopes).not.toContain(
      'repo:zone.stratos.feed.post?action=create&action=delete',
    )
  })

  it('should match the expected full value', () => {
    expect(OAUTH_SCOPE).toBe('atproto repo:zone.stratos.actor.enrollment')
  })
})

describe('buildSpaceScope', () => {
  it('requests this service as authority, with no skey and no PDS probe', () => {
    expect(buildSpaceScope('did:web:stratos.example.com')).toBe(
      'space:zone.stratos.space.feed?authority=did:web:stratos.example.com&collection=zone.stratos.feed.post&action=create&action=read',
    )
  })

  it('omits skey so the grant covers boundaries added after enrolment', () => {
    expect(buildSpaceScope('did:web:stratos.example.com')).not.toContain(
      'skey=',
    )
  })
})

describe('buildOAuthScope', () => {
  it('keeps the fixed base scope and appends the space grant', () => {
    const scope = buildOAuthScope('did:web:stratos.example.com')
    const parts = scope.split(' ')
    expect(parts[0]).toBe('atproto')
    expect(parts).toContain('repo:zone.stratos.actor.enrollment')
    expect(scope).toContain(buildSpaceScope('did:web:stratos.example.com'))
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
