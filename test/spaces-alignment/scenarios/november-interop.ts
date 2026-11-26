import { JOURNEYS } from '../november/interop-journeys.js'
import {
  loadNovemberSources,
  manifestReadinessProblems,
} from '../november/reference-host.js'
import { SuiteFailure, validateAssertions } from '../rules.js'
import { runAttestationFixture } from './november-attestation.driver.js'
import { runNovemberCacheEvidence } from './november-cache.driver.js'
import { runSyncFixture } from './november-sync.driver.js'
import { syncFixtures } from '../november/sync-fixtures.js'
import { suite as ordinary } from './ordinary-custody.js'
import {
  runNovemberBrowserScenario,
  suite as positive,
} from './november-positive.js'
import type {
  AssertionResult,
  JourneyEvidence,
  ScenarioContext,
  ScenarioSuite,
} from '../rules.js'

export class NovemberInteropFailure extends SuiteFailure {
  constructor(
    readonly outstanding: readonly string[],
    readonly evidence: readonly JourneyEvidence[],
    readonly failedGroups: readonly string[],
  ) {
    super(
      `november-interop still requires ${outstanding.length} journeys: ${outstanding.join(', ')}`,
      'november-interop',
      evidence.filter((row) => !row.remainingHostQuestion).map((row) => row.id),
    )
  }
}

const upstreamMint: ScenarioSuite = {
  id: 'november-upstream-mint',
  requiredAssertions: [
    'member-pds-ready',
    'personal-space-created',
    'personal-record-written',
    'upstream-credential-issued',
    'upstream-credential-read-verified',
  ],
  run: (context) => runNovemberBrowserScenario(context, upstreamMint),
}

const ownInspector: ScenarioSuite = {
  id: 'november-own-inspector',
  requiredAssertions: [
    'own-record-read-verified',
    'invalid-address-sends-no-read',
  ],
  run: (context) => runNovemberBrowserScenario(context, ownInspector),
}

const snapshotInspector: ScenarioSuite = {
  id: 'november-snapshot-inspector',
  requiredAssertions: ['other-author-snapshot-verified'],
  run: (context) => runNovemberBrowserScenario(context, snapshotInspector),
}

const membershipControl: ScenarioSuite = {
  id: 'november-membership-control',
  requiredAssertions: ['unjoined-viewer-ineligible', 'joined-viewer-eligible'],
  run: (context) => runNovemberBrowserScenario(context, membershipControl),
}

const referenceReads: ScenarioSuite = {
  id: 'november-reference-reads',
  requiredAssertions: [
    'reference-mint-read-verified',
    'both-reference-owners-read',
  ],
  run: (context) => runNovemberBrowserScenario(context, referenceReads),
}

const positiveJourneys = [
  {
    id: 'canonical-uri-at-each-boundary',
    assertions: ['oauth-create', 'oauth-read', 'credential-read'],
  },
  {
    id: 'schema-resolution-and-explicit-grants',
    assertions: ['schema-grant', 'oauth-create'],
  },
  {
    id: 'post-uri-and-text-in-real-feed-response',
    assertions: ['oauth-create', 'authorized-feed'],
  },
]

async function observeCarrier(
  context: ScenarioContext,
  carrier: ScenarioSuite,
  mappings: readonly {
    id: string
    assertions: readonly string[]
    remainingHostQuestion?: string
  }[],
  evidence: JourneyEvidence[],
): Promise<void> {
  let reached: readonly string[]
  try {
    const results = await carrier.run(context)
    validateAssertions(carrier, results)
    reached = results.map((result) => result.id)
  } catch (error) {
    if (!(error instanceof SuiteFailure) || error.suiteId !== carrier.id)
      throw error
    reached = error.reachedAssertions
    recordObservations()
    throw error
  }
  recordObservations()

  function recordObservations() {
    for (const { id, assertions, remainingHostQuestion } of mappings) {
      if (
        assertions.every(
          (assertion) =>
            carrier.requiredAssertions.includes(assertion) &&
            reached.includes(assertion),
        )
      ) {
        evidence.push({
          id,
          tier: 'pinned-host',
          observation: assertions.join(', '),
          artifact: carrier.id,
          ...(remainingHostQuestion ? { remainingHostQuestion } : {}),
        })
      }
    }
  }
}

export const suite: ScenarioSuite = {
  id: 'november-interop',
  requiredAssertions: JOURNEYS.map((journey) => journey.id),
  coverage:
    'November interop tracks completed host journeys and partial fixture evidence per row.',
  async run(context): Promise<AssertionResult[]> {
    const problems = manifestReadinessProblems(loadNovemberSources())
    if (problems.length > 0)
      throw new Error(
        `november-interop refuses to run until the November manifest is ready: ${problems.join('; ')}`,
      )

    const evidence: JourneyEvidence[] = []
    const groups = [
      {
        name: positive.id,
        run: () =>
          observeCarrier(context, positive, positiveJourneys, evidence),
      },
      {
        name: ordinary.id,
        run: () =>
          observeCarrier(
            context,
            ordinary,
            [
              {
                id: 'ordinary-custody-create-feed-delete',
                assertions: ordinary.requiredAssertions,
              },
            ],
            evidence,
          ),
      },
      ...[
        { id: 'upstream-standard-mint-control', carrier: upstreamMint },
        {
          id: 'inspector-reads-own-record-through-oauth',
          carrier: ownInspector,
        },
        {
          id: 'other-author-snapshot-without-direct-request',
          carrier: snapshotInspector,
        },
        {
          id: 'host-does-not-authorize-write-against-authority',
          carrier: membershipControl,
          remainingHostQuestion:
            'Upstream PDS write admission remains unverified.',
        },
      ].map(({ id, carrier, remainingHostQuestion }) => ({
        name: carrier.id,
        run: () =>
          observeCarrier(
            context,
            carrier,
            [
              {
                id,
                assertions: carrier.requiredAssertions,
                remainingHostQuestion,
              },
            ],
            evidence,
          ),
      })),
      {
        name: referenceReads.id,
        run: () =>
          observeCarrier(
            context,
            referenceReads,
            [
              {
                id: 'custom-mint-reads-from-reference-pds',
                assertions: ['reference-mint-read-verified'],
              },
              {
                id: 'two-authors-on-one-host',
                assertions: referenceReads.requiredAssertions,
                remainingHostQuestion:
                  'Both successful reads are observed. The receiver rejection remains outstanding.',
              },
            ],
            evidence,
          ),
      },
      {
        name: 'client-attestation-fixture',
        async run() {
          evidence.push(await runAttestationFixture(context))
        },
      },
      {
        name: 'encrypted-cache-migration',
        async run() {
          const { test } = await runNovemberCacheEvidence(context)
          evidence.push({
            id: 'mixed-cache-migration-preserves-custody',
            tier: 'in-process',
            observation: 'Migrated encrypted store accepted a verified sync.',
            artifact: test,
            remainingHostQuestion:
              'The migrated cache still needs a verified rebuild from the pinned host.',
          })
        },
      },
      ...syncFixtures.map((fixture) => ({
        name: fixture.id,
        async run() {
          evidence.push(await runSyncFixture(context, fixture))
        },
      })),
    ]

    const failedGroups: string[] = []
    const groupProgress: Record<string, readonly string[]> = {}
    const failedGroupExitCodes: Record<string, number> = {}
    for (const group of groups) {
      try {
        await group.run()
      } catch (error) {
        failedGroups.push(group.name)
        if (error instanceof SuiteFailure && error.suiteId === group.name) {
          groupProgress[group.name] = error.reachedAssertions
        }
        const failure = error instanceof SuiteFailure ? error.cause : error
        const exitCode = (failure as { exitCode?: unknown } | null)?.exitCode
        if (typeof exitCode === 'number')
          failedGroupExitCodes[group.name] = exitCode
      }
    }

    const completed = evidence.filter((row) => !row.remainingHostQuestion)
    const outstanding = suite.requiredAssertions.filter(
      (id) => !completed.some((row) => row.id === id),
    )
    context.recordJourneyReport?.({
      outstanding,
      evidence,
      failedGroups,
      groupProgress,
      failedGroupExitCodes,
    })
    if (outstanding.length > 0 || failedGroups.length > 0)
      throw new NovemberInteropFailure(outstanding, evidence, failedGroups)
    return completed.map(({ id }) => ({ id, status: 'passed' }))
  },
}
