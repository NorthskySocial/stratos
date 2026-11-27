// Run: cd test/scripts && deno test --allow-read --allow-env lib

import assert from 'node:assert/strict'

import { parseRunOptions, phasesFor, SPACES_PDS_OPTION } from './phases.ts'

const SPACES_PDS_SCRIPT = 'test-mixed-mode.ts'

function scriptsFor(args: string[]): string[] {
  return phasesFor(parseRunOptions(args)).map((phase) => phase.script)
}

Deno.test('the default run has no spaces PDS phase', () => {
  assert.ok(!scriptsFor([]).includes(SPACES_PDS_SCRIPT))
})

Deno.test(
  'the option adds the mixed-custody phase before the admin checks',
  () => {
    const scripts = scriptsFor([SPACES_PDS_OPTION])
    const position = scripts.indexOf(SPACES_PDS_SCRIPT)
    assert.ok(position > scripts.indexOf('test-feedgen.ts'))
    assert.ok(position < scripts.indexOf('test-admin-api.ts'))
    assert.deepEqual(
      scripts.filter((script) => script !== SPACES_PDS_SCRIPT),
      scriptsFor([]),
    )
  },
)

Deno.test('teardown runs after a failure in both modes', () => {
  for (const args of [[], [SPACES_PDS_OPTION]]) {
    const teardown = phasesFor(parseRunOptions(args)).find(
      (phase) => phase.script === 'teardown.ts',
    )
    assert.equal(teardown?.always, true)
  }
})

const PDS_FIXTURE_REFERENCES = /mixedMode|PDS_SPACES_URL|mixed-mode-pds/
const PDS_CUSTODY_CHECK_CALL = /\bawait assertPdsCustody\w+\(/
const PDS_CUSTODY_CHECK_DEFINITION = /\basync function assertPdsCustody\w+\(/

async function readScript(script: string): Promise<string[]> {
  const source = await Deno.readTextFile(
    new URL(`../${script}`, import.meta.url),
  )
  return source.split('\n')
}

// The default run reads the fixture accounts only through checks that the
// option guards, so it needs nothing the opt-in phases create.
Deno.test(
  'the default run phases touch the spaces PDS fixture only behind the option',
  async () => {
    const defaultScripts = scriptsFor([]).filter(
      (script) => !['setup.ts', 'teardown.ts'].includes(script),
    )
    for (const script of defaultScripts) {
      const lines = await readScript(script)
      const insideCheck: boolean[] = []
      let inCheck = false
      for (const line of lines) {
        if (PDS_CUSTODY_CHECK_DEFINITION.test(line)) inCheck = true
        insideCheck.push(inCheck)
        if (inCheck && line === '}') inCheck = false
      }
      lines.forEach((line, index) => {
        if (PDS_FIXTURE_REFERENCES.test(line) && !/^import /.test(line)) {
          const allowed =
            insideCheck[index] ||
            /pdsFixture = state\.mixedMode\?\.member/.test(line)
          assert.ok(
            allowed,
            `${script}:${index + 1} reads the PDS fixture: ${line}`,
          )
        }
        if (PDS_CUSTODY_CHECK_CALL.test(line)) {
          assert.match(
            `${lines[index - 1]}\n${line}`,
            /if \(spacesPdsRequested\(\)[^\n]*\) \{\n/,
            `${script}:${
              index + 1
            } calls a PDS-custody check without the option`,
          )
        }
      })
    }
  },
)

Deno.test(
  'both admin phases keep their PDS-custody check behind the option',
  async () => {
    for (const script of ['test-admin-api.ts', 'test-admin-ui.ts']) {
      const source = (await readScript(script)).join('\n')
      assert.match(source, PDS_CUSTODY_CHECK_DEFINITION, script)
      assert.match(source, PDS_CUSTODY_CHECK_CALL, script)
    }
  },
)
