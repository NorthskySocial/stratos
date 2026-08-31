import { describe, expect, it, vi } from 'vitest'

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

function config(devMode: boolean): StratosServiceConfig {
  return {
    service: {
      did: 'did:web:localhost%3A3100',
      serviceFragment: 'atproto_pns',
      port: 3100,
      publicUrl: 'http://localhost:3100',
      repoUrl: 'http://localhost:3100',
    },
    stratos: { devMode },
    oauth: {},
  } as StratosServiceConfig
}

describe('OAuth client factories', () => {
  it('passes allowHttp only when service development mode is enabled', async () => {
    for (const devMode of [true, false]) {
      nodeOAuthClient.mockClear()

      await createOAuthClientContext(
        config(devMode),
        stores,
        idResolver as never,
        fetch,
      )
      await createAdminOAuthClientContext(
        config(devMode),
        stores,
        idResolver as never,
        fetch,
      )

      expect(nodeOAuthClient).toHaveBeenCalledTimes(2)
      for (const [options] of nodeOAuthClient.mock.calls) {
        expect(options).toHaveProperty('clientMetadata')
        if (devMode) {
          expect(options).toHaveProperty('allowHttp', true)
        } else {
          expect(options).not.toHaveProperty('allowHttp')
        }
      }
    }
  })
})
