import type { syncFixtures } from '../november/sync-fixtures.js'
import type { JourneyEvidence, ScenarioContext } from '../rules.js'
import { runNamedFeedgenTest } from './november-cache.driver.js'

export async function runSyncFixture(
  context: ScenarioContext,
  fixture: (typeof syncFixtures)[number],
): Promise<JourneyEvidence> {
  for (const test of fixture.tests) await runNamedFeedgenTest(context, test)
  return {
    id: fixture.id,
    tier: 'tier' in fixture ? fixture.tier : 'in-process',
    observation: fixture.observation,
    remainingHostQuestion: fixture.remainingHostQuestion,
    artifact: fixture.tests.join(', '),
  }
}
