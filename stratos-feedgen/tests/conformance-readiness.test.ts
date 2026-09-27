import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  buildFeedRegistry,
  createFeedgenServer,
  type FeedRequestVerifier,
} from '../src/index.js'
import { FeedReadinessGate } from '../src/readiness.js'

interface ReadinessFixture {
  version: number
  cases: ReadinessCase[]
}

interface ReadinessCase {
  name: string
  events: ReadinessEvent[]
  expected_ready: boolean
}

type ReadinessEvent =
  | {
      type:
        | 'mark_unavailable'
        | 'mark_session_established'
        | 'begin_reconciliation'
    }
  | { type: 'complete_reconciliation'; errors: number; truncated: boolean }

const FIXTURE_PATH = fileURLToPath(
  new URL('../testdata/conformance/v1/readiness.json', import.meta.url),
)
const DID_FIXTURE_PATH = fileURLToPath(
  new URL('../testdata/conformance/v1/did-document.json', import.meta.url),
)

describe('readiness conformance fixture', () => {
  it('is versioned and accepted by the TypeScript gate', () => {
    const fixture = JSON.parse(
      readFileSync(FIXTURE_PATH, 'utf8'),
    ) as ReadinessFixture
    expect(fixture.version).toBe(1)

    for (const testCase of fixture.cases) {
      const gate = new FeedReadinessGate()
      let generation: number | undefined
      for (const event of testCase.events) {
        if (event.type === 'mark_unavailable') gate.markUnavailable()
        if (event.type === 'mark_session_established')
          gate.markSessionEstablished()
        if (event.type === 'begin_reconciliation') {
          generation = gate.beginReconciliation()
        }
        if (event.type === 'complete_reconciliation') {
          expect(generation, testCase.name).toBeDefined()
          gate.completeReconciliation(generation!, event)
        }
      }
      expect(gate.isReady(), testCase.name).toBe(testCase.expected_ready)
    }
  })

  it('serves the shared DID document fixture', async () => {
    const fixture = JSON.parse(readFileSync(DID_FIXTURE_PATH, 'utf8')) as {
      version: number
      input: {
        serviceDid: string
        publicUrl: string
        publicKeyMultibase: string
      }
      expected: unknown
    }
    const verifier: FeedRequestVerifier = async () => ({
      viewerDid: 'did:plc:irrelevant',
      lxm: 'zone.stratos.feedgen.getFeed',
    })
    const server = createFeedgenServer({
      feedgenServiceDid: fixture.input.serviceDid,
      feedgenPublicUrl: fixture.input.publicUrl,
      publicKeyMultibase: fixture.input.publicKeyMultibase,
      feeds: buildFeedRegistry([{ id: 'eng-feed', boundary: 'engineering' }]),
      store: {
        listPostsByBoundary: async () => ({ posts: [] }),
      } as unknown as Parameters<typeof createFeedgenServer>[0]['store'],
      enrollmentManager: {
        getBoundaries: async () => [],
      } as unknown as Parameters<
        typeof createFeedgenServer
      >[0]['enrollmentManager'],
      verifier,
    })
    const httpServer = await server.listen(0, '127.0.0.1')
    try {
      const address = httpServer.address() as AddressInfo
      const response = await fetch(
        `http://127.0.0.1:${address.port}/.well-known/did.json`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(fixture.expected)
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  })
})
