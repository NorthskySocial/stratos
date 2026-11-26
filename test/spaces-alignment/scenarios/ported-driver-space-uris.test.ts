import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  boundaryToSpaceUri,
  parseSpaceRecordUri,
  parseSpaceUri,
} from '../../../stratos-client/src/space-uri.js'
import { spaceUriFromParts } from './standard-credential-transport.driver.mjs'

const authorityDid = 'did:web:stratos-e2e.bebop.test'
const author = 'did:plc:spikespiegel'
const generalSpace = {
  spaceDid: authorityDid,
  spaceType: 'zone.stratos.space.feed',
  skey: 'general',
}

async function source(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8')
}

function expectSpaceUri(uri: unknown, skey = 'general') {
  expect(typeof uri).toBe('string')
  expect(parseSpaceUri(uri as string)).toEqual({
    ok: true,
    value: { ...generalSpace, skey },
  })
}

// Each driver runs in a container, so its space URI line is read from the
// file and evaluated here with the values the sandbox gives it.
function evaluateLine(
  text: string,
  pattern: RegExp,
  scope: Record<string, unknown>,
): unknown {
  const match = pattern.exec(text)
  expect(match, String(pattern)).not.toBeNull()
  return runInNewContext(match![1], { ...scope })
}

describe('space URIs in the ported drivers', () => {
  it('builds the standard driver space from its parts', () => {
    expectSpaceUri(spaceUriFromParts(authorityDid, 'general'))
    expectSpaceUri(spaceUriFromParts(authorityDid, 'other'), 'other')
  })

  it('builds the credential authority space', async () => {
    expectSpaceUri(
      evaluateLine(
        await source('credential-lifetime.authority.mjs'),
        /const spaceUri = (`[^`]+`)/,
        { issuerDid: authorityDid },
      ),
    )
  })

  it('builds the feed error fixture space', async () => {
    expectSpaceUri(
      evaluateLine(
        await source('feed-errors.browser.mjs'),
        /space: (`at:space[^`]+`),/,
        { domain: 'bebop.test' },
      ),
    )
  })

  it('builds the service admission space from the boundary', async () => {
    const boundary = `${authorityDid}/general`
    expectSpaceUri(
      decodeURIComponent(
        evaluateLine(
          await source('service-admission.ts'),
          /'space=' \+ (encodeURIComponent\(\[[^\]]+\]\.join\('\/'\)\))/,
          { encodeURIComponent, authority: authorityDid, boundary },
        ) as string,
      ),
    )
  })

  it('builds the delegation probe space', async () => {
    const text = await source('delegation-transport.ts')
    const spaceType = evaluateLine(text, /const spaceType = ('[^']+')/, {})
    expectSpaceUri(
      evaluateLine(
        text,
        /const space = (\['at:space', authorityDid, spaceType, 'general'\]\.join\('\/'\))/,
        { authorityDid, spaceType },
      ),
    )
  })

  it('builds the client custody space through the client formatter', async () => {
    const text = await source('client-custody.mjs')
    expect(text).toContain('boundaryToSpaceUri(')
    const built = boundaryToSpaceUri(
      `${authorityDid}/general`,
      'zone.stratos.space.feed',
    )
    expect(built.ok).toBe(true)
    expectSpaceUri(built.ok ? built.value : undefined)
  })

  it('reads the client custody rkey with the client record parser', async () => {
    const text = await source('client-custody.mjs')
    expect(text).toContain('parseSpaceRecordUri(result.uri)')
    expect(text).not.toContain("slice('at://'")
    const uri = `at:space/${authorityDid}/zone.stratos.space.feed/general/${author}/zone.stratos.feed.post/3kswordfish`
    const parsed = parseSpaceRecordUri(uri)
    expect(parsed.ok && parsed.value.rkey).toBe('3kswordfish')
  })

  describe('space delete browser helpers', () => {
    async function helpers() {
      const text = await source('space-delete.browser.mjs')
      const start = text.indexOf("const spaceUriPrefix = 'at:space/'")
      const end = text.indexOf('async function createPrivateFixture')
      expect(start).toBeGreaterThanOrEqual(0)
      return runInNewContext(
        `${text.slice(start, end)}\n({ spaceUriFromParts, recordUriParts, recordUriFromParts })`,
        { assert },
      ) as {
        spaceUriFromParts: (parts: object) => string
        recordUriParts: (uri: string) => Record<string, string>
        recordUriFromParts: (parts: object) => string
      }
    }
    const record = `at:space/${authorityDid}/zone.stratos.space.feed/general/${author}/zone.stratos.feed.post/3kswordfish`

    it('splits a record URI the client parser accepts and joins it back', async () => {
      const { recordUriParts, recordUriFromParts, spaceUriFromParts } =
        await helpers()
      expect(parseSpaceRecordUri(record).ok).toBe(true)
      const parts = recordUriParts(record)
      expect(parts.rkey).toBe('3kswordfish')
      expectSpaceUri(spaceUriFromParts(parts))
      expect(recordUriFromParts(parts)).toBe(record)
    })

    it('puts another author into a record URI from its parts', async () => {
      const { recordUriParts, recordUriFromParts } = await helpers()
      const other = recordUriFromParts({
        ...recordUriParts(record),
        author: 'did:plc:fayevalentine',
      })
      expect(parseSpaceRecordUri(other).ok).toBe(true)
      expect(other).toContain('/did:plc:fayevalentine/')
      expect(other).not.toBe(record)
    })

    it('refuses the earlier spelling of a record URI', async () => {
      const { recordUriParts } = await helpers()
      const legacyRecord = `at://${authorityDid}/space/zone.stratos.space.feed/general/${author}/zone.stratos.feed.post/3kswordfish`
      expect(() => recordUriParts(legacyRecord)).toThrow(
        'Not a space record URI',
      )
    })
  })

  it('keeps the earlier spelling out of every driver and template', async () => {
    const earlier = /at:\/\/[^/\s"'`]+\/space\/|'\/space\/|\/space\/\$\{/
    for (const name of [
      'standard-credential-transport.driver.mjs',
      'credential-lifetime.driver.mjs',
      'credential-lifetime.authority.mjs',
      'delegation-transport.driver.mjs',
      'delegation-transport.ts',
      'rust-production-interop.driver.mjs',
      'client-custody.mjs',
      'feed-errors.browser.mjs',
      'space-delete.browser.mjs',
      'service-admission.ts',
      '../atmosphere/runtime/feedgen-ng-e2e-browser.mjs',
      '../atmosphere/stacks/feedgen-ng-e2e.yaml',
    ])
      expect(earlier.test(await source(name)), name).toBe(false)
  })
})
