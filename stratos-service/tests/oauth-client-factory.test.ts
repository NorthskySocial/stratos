import { beforeEach, describe, expect, it, vi } from 'vitest'

const { nodeOAuthClient } = vi.hoisted(() => ({ nodeOAuthClient: vi.fn() }))

vi.mock('@atproto/oauth-client-node', () => ({
  NodeOAuthClient: nodeOAuthClient,
}))

import {
  createAdminOAuthClientContext,
  createOAuthClientContext,
} from '../src/oauth/client-factory.js'
import type { StratosServiceConfig } from '../src/config.js'

const stores = {
  sessionStore: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  stateStore: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}

const idResolver = {
  handle: { resolve: vi.fn() },
}

function config(
  stratos: Partial<StratosServiceConfig['stratos']>,
): StratosServiceConfig {
  return {
    service: {
      did: 'did:web:motoko.spike.test%3A3100',
      serviceFragment: 'atproto_pns',
      port: 3100,
      publicUrl: 'http://motoko.spike.test:3100',
      repoUrl: 'http://motoko.spike.test:3100',
    },
    stratos,
    oauth: {},
  } as StratosServiceConfig
}

describe('OAuth client factories', () => {
  beforeEach(() => nodeOAuthClient.mockClear())

  async function createEnrollmentAndAdminClients(
    serviceConfig: StratosServiceConfig,
  ): Promise<void> {
    await createOAuthClientContext(
      serviceConfig,
      stores,
      idResolver as never,
      fetch,
    )
    await createAdminOAuthClientContext(
      serviceConfig,
      stores,
      idResolver as never,
      fetch,
    )
  }

  it('allows HTTP for both clients in service development mode', async () => {
    await createEnrollmentAndAdminClients(config({ devMode: true }))

    expect(nodeOAuthClient).toHaveBeenCalledTimes(2)
    for (const [options] of nodeOAuthClient.mock.calls) {
      expect(options).toHaveProperty('clientMetadata')
      expect(options).toHaveProperty('allowHttp', true)
    }
  })

  it('keeps HTTP disabled for both clients outside development mode', async () => {
    await createEnrollmentAndAdminClients(config({}))

    expect(nodeOAuthClient).toHaveBeenCalledTimes(2)
    for (const [options] of nodeOAuthClient.mock.calls) {
      expect(options).toHaveProperty('clientMetadata')
      expect(options).not.toHaveProperty('allowHttp')
    }
  })
})
