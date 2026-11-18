import { spawn } from 'node:child_process'

export type RustContractKind = 'privacy' | 'recovery'

const CONTRACT_TESTS: Record<RustContractKind, readonly string[]> = {
  privacy: [
    'store::tests::opens_only_when_sqlcipher_is_available',
    'store::tests::rejects_a_plain_sqlite_file',
    'store::tests::reopens_with_the_same_key_and_rejects_a_wrong_key',
    'store::tests::rejects_permissive_or_malformed_secret_files',
    'store::tests::redacts_storage_keys_in_debug_output',
    'conformance::tests::reads_the_label_pages_stratos_serves_in_the_shared_fixture',
    'actor_event::tests::the_operation_boundary_wins_over_a_disagreeing_body_claim',
    'lifecycle::tests::serves_a_post_whose_boundary_is_only_on_the_operation_to_viewers_in_that_boundary',
    'conformance::tests::parses_the_actor_commit_frames_stratos_sends_in_the_shared_fixture',
    'actor_event::tests::the_body_fallback_is_still_limited_to_current_enrollment',
  ],
  recovery: [
    'store::tests::restarting_a_staged_page_requires_a_new_terminal_verification',
    'store::tests::terminal_space_stage_stays_invisible_until_promotion',
    'service::tests::invalidation_between_query_and_release_rejects_the_page',
    'label_poller::tests::a_replayed_enroll_does_not_readmit_a_taken_down_account',
    'label_poller::tests::the_takedown_outlives_a_restart',
    'store::labels::tests::a_later_update_does_not_readmit_a_taken_down_post_but_advances_the_cursor',
    'store::labels::tests::a_replay_from_the_start_does_not_readmit_a_taken_down_post',
    'label_poller::tests::a_fresh_start_applies_labels_before_serving_and_refuses_the_post',
    'label_poller::tests::a_negated_stratos_post_returns_by_replay_while_another_takedown_stays_refused',
    'label_poller::tests::a_catch_up_after_the_bound_reopens_feeds_without_a_restart',
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
