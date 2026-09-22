import { spawn } from 'node:child_process'

export type RustContractKind = 'privacy' | 'recovery'

const CONTRACT_TESTS: Record<RustContractKind, readonly string[]> = {
  privacy: [
    'store::tests::opens_only_when_sqlcipher_is_available',
    'store::tests::rejects_a_plain_sqlite_file',
    'store::tests::reopens_with_the_same_key_and_rejects_a_wrong_key',
    'store::tests::rejects_permissive_or_malformed_secret_files',
    'store::tests::redacts_storage_keys_in_debug_output',
  ],
  recovery: [
    'store::tests::restarting_a_staged_page_requires_a_new_terminal_verification',
    'store::tests::terminal_space_stage_stays_invisible_until_promotion',
    'service::tests::invalidation_between_query_and_release_rejects_the_page',
  ],
}

export async function runRustContracts(
  kind: RustContractKind,
): Promise<number> {
  for (const testName of CONTRACT_TESTS[kind]) {
    await runCargoTest(testName)
  }
  return CONTRACT_TESTS[kind].length
}

function runCargoTest(testName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cargo',
      [
        'test',
        '--locked',
        '--manifest-path',
        'stratos-feedgen-ng/Cargo.toml',
        testName,
        '--',
        '--exact',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 4096) output += chunk.toString('utf8')
    })
    child.once('error', () =>
      reject(new Error('Rust contract runner could not start')),
    )
    child.once('exit', (code) => {
      if (code === 0 && /running 1 test/.test(output)) resolve()
      else reject(new Error('Rust contract assertion failed'))
    })
  })
}
