import { JOURNEYS } from '../november/interop-journeys.js'
import {
  loadNovemberSources,
  manifestReadinessProblems,
} from '../november/reference-host.js'
import { SuiteFailure, validateAssertions } from '../rules.js'
import { runNovemberCacheEvidence } from './november-cache.driver.js'
import { suite as ordinary } from './ordinary-custody.js'
import { suite as positive } from './november-positive.js'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const executedJourneys = [
  'canonical-uri-at-each-boundary',
  'schema-resolution-and-explicit-grants',
  'ordinary-custody-create-feed-delete',
  'post-uri-and-text-in-real-feed-response',
] as const
const withoutDriver = JOURNEYS.filter(
  (journey) =>
    !executedJourneys.includes(journey.id as (typeof executedJourneys)[number]),
).map((journey) => journey.id)

export const suite: ScenarioSuite = {
  id: 'november-interop',
  requiredAssertions: JOURNEYS.map((journey) => journey.id),
  coverage:
    'Full November interop runs positive and ordinary custody journeys plus partial in-process cache migration evidence. Endpoint-backed migration and other unimplemented journeys prevent acceptance.',
  async run(context): Promise<AssertionResult[]> {
    const problems = manifestReadinessProblems(loadNovemberSources())
    if (problems.length > 0)
      throw new Error(
        `november-interop refuses to run until the November manifest is ready: ${problems.join('; ')}`,
      )
    const results = await positive.run(context)
    validateAssertions(positive, results)
    try {
      validateAssertions(ordinary, await ordinary.run(context))
    } catch (error) {
      throw new SuiteFailure(
        'The ordinary-custody journey failed.',
        suite.id,
        executedJourneys.filter(
          (id) => id !== 'ordinary-custody-create-feed-delete',
        ),
        { cause: error },
      )
    }
    try {
      await runNovemberCacheEvidence(context)
    } catch (error) {
      throw new SuiteFailure(
        'The in-process cache migration evidence failed; it does not establish endpoint-backed migration.',
        suite.id,
        executedJourneys,
        { cause: error },
      )
    }
    throw new SuiteFailure(
      `november-interop ran partial in-process cache migration evidence; it has no driver for ${withoutDriver.length} of its ${JOURNEYS.length} journeys yet: ${withoutDriver.join(', ')}`,
      suite.id,
      executedJourneys,
    )
  },
}
