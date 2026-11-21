import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { suite } from './ordinary-custody.js'
import { suite as baseline } from './baseline.js'
import {
  assertionsReachedBy,
  STANDALONE_SUITE_IDS,
  suiteExecutionOrder,
  validateAssertions,
  validateSuite,
} from '../rules.js'
import type { ScenarioContext, ScenarioSuite } from '../rules.js'

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

const receiptLine = (coverage = suite.coverage) =>
  JSON.stringify({
    suite: 'ordinary-custody',
    coverage,
    assertions: suite.requiredAssertions.map((id) => ({
      id,
      status: 'passed',
    })),
  })

function context(runCommand: ScenarioContext['runCommand']): ScenarioContext {
  return {
    sandboxDirectory: '/tmp/faye-sandbox',
    composeFile: '/tmp/faye-sandbox/compose.yaml',
    projectName: 'faye-test',
    scratchDirectory: '/tmp/faye-report',
    runCommand,
  }
}

describe('ordinary-custody suite', () => {
  it('is a valid suite with names of its own', () => {
    expect(() => validateSuite(suite)).not.toThrow()
    expect(suite.requiredAssertions).toHaveLength(5)
    for (const id of suite.requiredAssertions)
      expect(baseline.requiredAssertions).not.toContain(id)
  })

  it('runs only the ordinary-custody driver of the browser service', async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = []
    const results = await suite.run(
      context(async (file, args, cwd) => {
        calls.push({ file, args, cwd })
        return `Browser output\n${receiptLine()}\n`
      }),
    )
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
          'ordinary-custody',
        ],
      },
    ])
    expect(() => validateAssertions(suite, results)).not.toThrow()
  })

  it('says in its receipt what it does not cover', () => {
    expect(suite.coverage).toMatch(/^Ordinary custody only/)
    expect(suite.coverage).toContain('PDS custody')
  })

  it.each([
    [
      'no receipt',
      'Health check passed',
      'no ordinary-custody assertion receipt',
    ],
    [
      'a receipt without the coverage line',
      receiptLine('Everything'),
      'invalid ordinary-custody assertion receipt',
    ],
    [
      'a receipt of another suite',
      receiptLine().replace('"ordinary-custody"', '"baseline"'),
      'no ordinary-custody assertion receipt',
    ],
  ])('rejects %s', async (_name, output, message) => {
    await expect(suite.run(context(async () => output))).rejects.toThrow(
      message,
    )
  })

  it('reports the assertions reached when the driver fails', async () => {
    const reached = JSON.stringify({
      progress: 'assertion-reached',
      suite: 'ordinary-custody',
      id: 'ordinary-sign-in',
    })
    const error = await suite
      .run(
        context(async () => {
          throw Object.assign(new Error('docker compose exited 1'), {
            stdout: reached,
          })
        }),
      )
      .catch((caught: unknown) => caught)
    expect(assertionsReachedBy(error)).toEqual(['ordinary-sign-in'])
  })
})

describe('suite registry', () => {
  async function registeredSuites(): Promise<ScenarioSuite[]> {
    const files = (await readdir(new URL('.', import.meta.url))).filter(
      (file) => /^[a-z][a-z0-9-]*\.ts$/.test(file),
    )
    const modules = await Promise.all(
      files.map(
        (file) =>
          import(
            /* @vite-ignore */ new URL(`./${file}`, import.meta.url).href
          ) as Promise<{ suite: ScenarioSuite }>,
      ),
    )
    return modules.map((module) => module.suite)
  }

  it('makes no suite but ordinary-custody standalone', async () => {
    const suites = await registeredSuites()
    expect(suites.map((item) => item.id)).toContain('ordinary-custody')
    for (const item of suites) {
      const order = suiteExecutionOrder(item.id, suites).map(
        (entry) => entry.id,
      )
      expect(order).toEqual(
        item.id === 'baseline' || STANDALONE_SUITE_IDS.has(item.id)
          ? [item.id]
          : ['baseline', item.id],
      )
    }
    expect(
      suites
        .filter((item) => STANDALONE_SUITE_IDS.has(item.id))
        .map((i) => i.id),
    ).toEqual(['ordinary-custody'])
  })

  it('gives no suite but the baseline a name from the baseline', async () => {
    const suites = await registeredSuites()
    const ordinary = suites.find((item) => item.id === 'ordinary-custody')!
    expect(
      ordinary.requiredAssertions.filter((id) =>
        baseline.requiredAssertions.includes(id),
      ),
    ).toEqual([])
  })
})

describe('ordinary-custody driver', () => {
  it('prints its five ids in journey order', () => {
    const printed = [
      ...functionBody('runOrdinaryCustody').matchAll(/reach\('([a-z-]+)'\)/g),
    ].map((match) => match[1])
    expect(printed).toEqual([...suite.requiredAssertions])
    const receipt = /const ordinaryCustodyAssertions = \[([^\]]+)\]/.exec(
      driverSource,
    )![1]
    expect([...receipt.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])).toEqual([
      ...suite.requiredAssertions,
    ])
  })

  it('uses the ordinary PDS accounts and never the spaces PDS account steps', () => {
    const journey = functionBody('runOrdinaryCustody')
    for (const spacesStep of [
      'provisionAccount',
      'pdsCreatePath',
      'writeSpaceBlobFixture',
      'assertPdsGrantedSpaceScope',
      'pds-space1',
    ])
      expect(journey).not.toContain(spacesStep)
    expect(functionBody('ordinaryAccount')).toContain('.pds1.')
    expect(functionBody('unjoinedOrdinaryAccount')).toContain('.pds1.')
  })

  it('selects the journey by suite id and refuses an unknown one', () => {
    expect(driverSource).toMatch(
      /const journeys = \{\s*baseline: runBaseline,\s*'ordinary-custody': runOrdinaryCustody,\s*\}/,
    )
    expect(functionBody('main')).toContain(
      "assert.ok(Object.hasOwn(journeys, activeSuite), 'Unknown suite')",
    )
  })

  describe('custody URI check', () => {
    const assertCustodyUri = runInNewContext(
      `const postCollection = 'zone.stratos.feed.post';\n${functionBody('assertCustodyUri')}\nassertCustodyUri`,
      { assert },
    ) as (uri: unknown, did: string) => void
    const member = 'did:plc:spikespiegel'

    it("accepts a post record URI of the member's own repo", () => {
      expect(() =>
        assertCustodyUri(
          `at://${member}/zone.stratos.feed.post/3kbebop`,
          member,
        ),
      ).not.toThrow()
    })

    it.each([
      [
        'another member',
        'at://did:plc:fayevalentine/zone.stratos.feed.post/3kbebop',
      ],
      [
        'a space record',
        `at:space/did:web:bebop.example/zone.stratos.space.feed/crew/${member}/zone.stratos.feed.post/3kbebop`,
      ],
      ['a missing record key', `at://${member}/zone.stratos.feed.post/`],
      [
        'an extra segment',
        `at://${member}/zone.stratos.feed.post/3kbebop/extra`,
      ],
      ['a non-string', undefined],
    ])('refuses %s', (_name, uri) => {
      expect(() => assertCustodyUri(uri, member)).toThrow()
    })
  })

  describe('deleted post leaves the feed', () => {
    function waitForFeedWithout(responsesPerReload: Array<unknown[]>) {
      let now = 0
      const responses: Array<{ status: number; body: unknown }> = []
      let reload = 0
      const page = {
        reload: async () => {
          for (const body of responsesPerReload[reload++] ?? [])
            responses.push({ status: 200, body })
        },
      }
      const run = runInNewContext(
        `${functionBody('waitForFeedWithout')}\nwaitForFeedWithout`,
        {
          Date: { now: () => now },
          delay: async () => {
            now += 60_000
          },
          Error,
          Array,
        },
      ) as (
        page: unknown,
        responses: unknown[],
        text: string,
        uri: string,
      ) => Promise<void>
      return () =>
        run(
          page,
          responses,
          'Ed was here',
          'at://did:plc:ed/zone.stratos.feed.post/3k',
        )
    }
    const listed = {
      feed: [
        {
          post: {
            uri: 'at://did:plc:ed/zone.stratos.feed.post/3k',
            record: { text: 'Ed was here' },
          },
        },
      ],
    }

    it('resolves once a fresh feed response no longer lists the post', async () => {
      await expect(
        waitForFeedWithout([[listed], [{ feed: [] }]])(),
      ).resolves.toBeUndefined()
    })

    it('fails when the feed keeps listing the post', async () => {
      await expect(waitForFeedWithout([[listed], [listed]])()).rejects.toThrow(
        'still returned the deleted custody post',
      )
    })
  })
})
