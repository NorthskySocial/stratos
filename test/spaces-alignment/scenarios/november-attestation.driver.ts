import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JourneyEvidence, ScenarioContext } from '../rules.js'

const testFile = 'stratos-service/tests/space-credential-app-gating.test.ts'
const expected = [
  'allowList space without attestation → AttestationRequired',
  'listed client with valid attestation → OK exactly once (replay rejected)',
  'allowList space: the authority host audience mints, the retired audience → AttestationRequired',
]

export async function runAttestationFixture(
  context: ScenarioContext,
): Promise<JourneyEvidence> {
  const source = fileURLToPath(new URL('../../../', import.meta.url))
  const report = join(context.scratchDirectory, 'attestation-verifier.json')
  await context.runCommand(
    join(source, 'node_modules/.bin/vitest'),
    [
      'run',
      '--project',
      'stratos-service',
      testFile,
      '-t',
      'allowList space without attestation|listed client with valid attestation|authority host audience',
      '--reporter=json',
      '--outputFile',
      report,
    ],
    source,
  )
  const result = JSON.parse(await readFile(report, 'utf8')) as {
    testResults: Array<{
      name: string
      assertionResults: Array<{ title: string; status: string }>
    }>
  }
  const [file] = result.testResults
  const passed = file?.assertionResults
    .filter(({ status }) => status === 'passed')
    .map(({ title }) => title)
  if (
    result.testResults.length !== 1 ||
    file?.name !== join(source, testFile) ||
    passed.length !== expected.length ||
    !expected.every((title) => passed.includes(title))
  ) {
    throw new Error(
      'The attestation fixture did not report every selected test as passed',
    )
  }
  return {
    id: 'current-delegation-and-client-attestation-accepted',
    tier: 'in-process',
    observation:
      'The Stratos mint required the configured client attestation and accepted a valid allow-listed client with the current authority audience.',
    artifact: testFile,
    remainingHostQuestion:
      'The disposable confidential client needs a publicly reachable HTTPS metadata origin to exercise production JWKS resolution with a live PDS delegation.',
  }
}
