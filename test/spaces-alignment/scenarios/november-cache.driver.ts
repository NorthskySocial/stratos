import { join } from 'node:path'
import type { ScenarioContext } from '../rules.js'

const TEST =
  'store::migrations::tests::a_verified_sync_of_a_member_works_end_to_end_on_a_migrated_file_store'

/** Runs the encrypted migration and verified in-process host proof. */
export async function runNovemberCacheEvidence(
  context: ScenarioContext,
): Promise<{ test: string; endpointBacked: false }> {
  const output = await context.runCommand(
    'cargo',
    [
      'test',
      '--locked',
      '-p',
      'stratos-feedgen-ng',
      '--lib',
      TEST,
      '--',
      '--exact',
    ],
    join(context.scratchDirectory, 'stratos'),
  )
  if (
    !output.includes(`test ${TEST} ... ok`) ||
    !/test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(output)
  )
    throw new Error(
      'Encrypted migration test did not report exactly one passing test',
    )
  return { test: TEST, endpointBacked: false }
}
