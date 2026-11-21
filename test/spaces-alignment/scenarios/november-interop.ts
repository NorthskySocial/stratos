import { JOURNEYS } from '../november/interop-journeys.js'
import {
  loadNovemberSources,
  manifestReadinessProblems,
} from '../november/reference-host.js'
import type { AssertionResult, ScenarioSuite } from '../rules.js'

const withoutDriver = JOURNEYS.filter(
  (journey) => journey.carriedBy.length === 0,
).map((journey) => journey.id)

export const suite: ScenarioSuite = {
  id: 'november-interop',
  requiredAssertions: JOURNEYS.map((journey) => journey.id),
  coverage:
    'Prepared, never run: the journeys for the day a host accepts the new space spelling. No host has accepted it, so nothing here has a result.',
  async run(): Promise<AssertionResult[]> {
    const problems = manifestReadinessProblems(loadNovemberSources())
    if (problems.length > 0)
      throw new Error(
        `november-interop refuses to run until the November manifest is ready: ${problems.join('; ')}`,
      )
    throw new Error(
      `november-interop has no driver for ${withoutDriver.length} of its ${JOURNEYS.length} journeys yet: ${withoutDriver.join(', ')}`,
    )
  },
}
