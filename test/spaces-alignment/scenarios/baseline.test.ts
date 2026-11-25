import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { suite } from './baseline.js'
import {
  assertionsReachedBy,
  validateAssertions,
  validateSuite,
} from '../rules.js'
import {
  parseSpaceRecordUri,
  parseSpaceUri,
} from '../../../stratos-client/src/space-uri.js'

describe('baseline browser receipt', () => {
  it('requires separate PDS grant and unrelated-boundary evidence', () => {
    expect(suite.requiredAssertions).toContain('pds-space-grant')
    expect(suite.requiredAssertions).toContain('unrelated-boundary-denied')
  })

  it('runs the isolated browser service and accepts every required assertion', async () => {
    const assertions = suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed' as const,
    }))
    const calls: Array<{ file: string; args: string[]; cwd: string }> = []
    const results = await suite.run({
      sandboxDirectory: '/tmp/faye-sandbox',
      composeFile: '/tmp/faye-sandbox/compose.yaml',
      projectName: 'faye-test',
      scratchDirectory: '/tmp/faye-report',
      async runCommand(file, args, cwd) {
        calls.push({ file, args, cwd })
        return `Browser output\n  ${JSON.stringify({ suite: 'baseline', assertions })}\nBrowser finished\n`
      },
    })
    expect(calls).toEqual([
      {
        file: 'docker',
        cwd: '/tmp/faye-sandbox',
        args: [
          'compose',
          '--file',
          '/tmp/faye-sandbox/compose.yaml',
          '--project-name',
          'faye-test',
          '--project-directory',
          '/tmp/faye-sandbox',
          'run',
          '--build',
          '--rm',
          '--no-deps',
          'feedgen-e2e-browser',
        ],
      },
    ])
    expect(() => validateAssertions(suite, results)).not.toThrow()
    expect(() => validateSuite(suite)).not.toThrow()
  })

  it('rejects missing and invalid browser receipts', async () => {
    const context = (output: string) => ({
      sandboxDirectory: '/tmp/faye-sandbox',
      composeFile: '/tmp/faye-sandbox/compose.yaml',
      projectName: 'faye-test',
      scratchDirectory: '/tmp/faye-report',
      async runCommand() {
        return output
      },
    })
    await expect(suite.run(context('Health check passed'))).rejects.toThrow(
      'no baseline assertion receipt',
    )
    await expect(
      suite.run(context('{"suite":"baseline","assertions":[]}')),
    ).resolves.toEqual([])
    await expect(
      suite.run(context('{"suite":"wrong","assertions":[]}')),
    ).rejects.toThrow('no baseline assertion receipt')
    await expect(
      suite.run(
        context('{"suite":"baseline","assertions":{},"suite":"wrong"}'),
      ),
    ).rejects.toThrow('invalid baseline assertion receipt')
    await expect(
      suite.run(
        context('{"suite":"baseline","assertions":[],"suite":"wrong"}'),
      ),
    ).rejects.toThrow('invalid baseline assertion receipt')
    await expect(
      suite.run(context('{"suite":"baseline","assertions":{}}')),
    ).rejects.toThrow('invalid baseline assertion receipt')
  })
})

const driverSource = await readFile(
  new URL('../atmosphere/runtime/feedgen-ng-e2e-browser.mjs', import.meta.url),
  'utf8',
)

function functionBody(name: string): string {
  const start = driverSource.search(
    new RegExp(`^(?:async )?function ${name}\\(`, 'm'),
  )
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0)
  const next = driverSource.slice(start + 1).search(/^(?:async )?function /m)
  return driverSource.slice(start, next < 0 ? undefined : start + 1 + next)
}

function reachedIn(name: string): string[] {
  return [...functionBody(name).matchAll(/reach\('([a-z-]+)'\)/g)].map(
    (match) => match[1],
  )
}

describe('baseline driver progress lines', () => {
  it.each([
    [
      'runBaseline',
      [
        'browser-oauth',
        'pds-custody',
        'publication-feed',
        'space-lexicon',
        'pds-space-grant',
        'public-private-blob-denied',
        'authenticated-space-blob',
      ],
    ],
    ['assertStratosCustody', ['stratos-custody']],
    [
      'assertNonmemberDenied',
      ['unrelated-boundary-denied', 'boundary-isolation'],
    ],
  ])('prints the ids its steps prove in %s, in step order', (name, ids) => {
    expect(reachedIn(name)).toEqual(ids)
  })

  it('prints each of the ten ids exactly once and keeps their receipt order', () => {
    const printed = ['runBaseline', 'assertStratosCustody', 'assertNonmemberDenied']
      .flatMap((name) => reachedIn(name))
    expect([...printed].sort()).toEqual([...suite.requiredAssertions].sort())
    const receipt = /const baselineAssertions = \[([^\]]+)\]/.exec(
      driverSource,
    )![1]
    expect([...receipt.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])).toEqual([
      ...suite.requiredAssertions,
    ])
  })

  it('prints a progress line the runner reads, naming the suite', () => {
    const lines: string[] = []
    runInNewContext(`${functionBody('reach')}\nreach('browser-oauth')`, {
      console: { log: (line: string) => lines.push(line) },
      JSON,
      activeSuite: 'baseline',
    })
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { progress: 'assertion-reached', suite: 'baseline', id: 'browser-oauth' },
    ])
  })

  it('reports the ids reached when the driver fails', async () => {
    const reachedLine = (id: string) =>
      JSON.stringify({ progress: 'assertion-reached', suite: 'baseline', id })
    const error = await suite
      .run({
        sandboxDirectory: '/tmp/faye-sandbox',
        composeFile: '/tmp/faye-sandbox/compose.yaml',
        projectName: 'faye-test',
        scratchDirectory: '/tmp/faye-report',
        async runCommand() {
          throw Object.assign(new Error('docker compose exited 1'), {
            stdout: [
              reachedLine('browser-oauth'),
              reachedLine('pds-custody'),
            ].join('\n'),
          })
        },
      })
      .catch((caught: unknown) => caught)
    expect(assertionsReachedBy(error)).toEqual(['browser-oauth', 'pds-custody'])
  })
})

describe('baseline driver space URIs', () => {
  const authorityDid = 'did:web:stratos-e2e.bebop.test'
  const spaceUriFromParts = runInNewContext(
    `const spaceType = 'zone.stratos.space.feed';\n${functionBody('spaceUriFromParts')}\nspaceUriFromParts`,
    {},
  ) as (authority: string, skey: string) => string
  const assertSpaceRecordUri = runInNewContext(
    `const postCollection = 'zone.stratos.feed.post';\n${functionBody('assertSpaceRecordUri')}\nassertSpaceRecordUri`,
    { assert },
  ) as (uri: string, space: string) => { author: string; rkey: string }

  it('builds a space URI the client classifier accepts', () => {
    const space = spaceUriFromParts(authorityDid, 'general')
    expect(parseSpaceUri(space)).toEqual({
      ok: true,
      value: {
        spaceDid: authorityDid,
        spaceType: 'zone.stratos.space.feed',
        skey: 'general',
      },
    })
  })

  it('accepts a space record URI in that space and rejects the earlier spelling', () => {
    const space = spaceUriFromParts(authorityDid, 'general')
    const uri = `${space}/did:plc:fayevalentine/zone.stratos.feed.post/3kswordfish`
    expect(parseSpaceRecordUri(uri).ok).toBe(true)
    expect(assertSpaceRecordUri(uri, space)).toEqual({
      author: 'did:plc:fayevalentine',
      rkey: '3kswordfish',
    })
    const legacyRecord = `at://${authorityDid}/space/zone.stratos.space.feed/general/did:plc:fayevalentine/zone.stratos.feed.post/3kswordfish`
    expect(() => assertSpaceRecordUri(legacyRecord, space)).toThrow(
      'Post is not in the configured Stratos space',
    )
  })
})
