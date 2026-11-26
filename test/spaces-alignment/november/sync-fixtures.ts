export const syncFixtures = [
  {
    id: 'terminal-set-hash-mismatch-never-promoted',
    tests: [
      'pds_space_sync::tests::a_wrong_digest_on_the_last_page_leads_to_one_replacement_and_its_state',
      'pds_space_sync::tests::a_replacement_whose_digest_is_wrong_fails_and_the_earlier_state_stands',
    ],
    observation:
      'The verified base and peer stayed intact until a distinct valid replacement. An invalid replacement kept the base.',
    remainingHostQuestion:
      'The rejection and archive exchange were exercised at the in-process host seam.',
  },
  {
    id: 'non-post-record-contributes-to-integrity',
    tests: [
      'pds_space_sync::tests::a_missing_value_on_a_post_path_leads_to_a_replacement_and_on_another_collection_promotes',
    ],
    observation:
      'A non-post record added to the fixture changed the verified digest and path count while its feed stayed the same.',
    remainingHostQuestion:
      'The pinned host must accept an OAuth write to a permitted non-post collection and verify both paths in its commit.',
  },
  {
    id: 'full-page-then-empty-terminal',
    tests: [
      'pds_space_sync::tests::a_full_page_followed_by_an_empty_last_page_promotes',
    ],
    observation:
      'The synchronizer followed the continuation and promoted the terminal revision from the fixture.',
    remainingHostQuestion:
      'Whether the pinned host returns an empty terminal page after an exactly full page.',
  },
  {
    id: 'expired-cursor-replaced-by-verified-star',
    tests: [
      'pds_space_sync::tests::invalid_cursor_on_a_later_page_replaces_the_poll',
      'pds_space_sync::tests::only_repo_not_found_with_status_400_clears_and_only_invalid_cursor_replaces',
    ],
    observation:
      'An injected InvalidCursor response triggered a verified replacement. The other refusal controls preserved the base.',
    remainingHostQuestion:
      'Whether a pinned host issues InvalidCursor for an expired cursor and supplies a verified replacement.',
  },
  {
    id: 'crash-restart-reaches-verified-terminal-revision',
    tests: [
      'pds_space_sync::tests::a_crashed_poll_leaves_no_state_and_the_next_poll_starts_from_the_verified_rev',
    ],
    observation:
      'Dropping a pending poll left the verified base untouched. A new poll resumed at its revision and promoted the terminal state.',
    remainingHostQuestion:
      'Whether the feedgen process resumes correctly after a stop and restart on the same encrypted volume.',
  },
  {
    id: 'host-and-kem-key-rotation',
    tests: [
      'pds_space_sync::tests::a_host_with_other_contents_and_no_oplog_replaces_from_the_new_host',
      'space_host::authenticated_read_tests::a_stale_kem_key_is_refreshed_and_one_new_request_with_a_new_key_share_verifies',
    ],
    observation:
      'A distinct host supplied a verified replacement. A cached stale KEM key prompted one refresh and a successful retry.',
    remainingHostQuestion:
      'Authorization and discovery after a pinned-host move, and the pinned host KEM key lifecycle.',
  },
  {
    id: 'membership-revoked-mid-poll',
    tests: [
      'pds_space_sync::tests::a_member_removed_during_the_poll_promotes_nothing',
      'pds_space_sync::tests::a_member_re_enrolled_with_a_new_generation_starts_with_a_replacement',
    ],
    observation:
      'In-flight work with an old membership generation could not promote. Re-enrollment required a replacement.',
    remainingHostQuestion:
      'Production reconciliation and persistence of the removal across a process restart.',
  },
  {
    id: 'health-answers-while-a-sync-writes',
    tier: 'controlled-transport',
    tests: [
      'server::tests::health_serves_a_loopback_client_during_a_verified_store_write',
    ],
    observation:
      'Three loopback HTTP responses completed within two seconds while a verified replacement held the encrypted-store write transaction open.',
    remainingHostQuestion:
      'Response timing during a naturally timed transaction in the sandbox feedgen process.',
  },
  {
    id: 'malformed-or-truncated-archive-refused',
    tests: [
      'pds_space_sync::tests::archive_failures_fail_the_target_and_leave_every_row_as_it_was',
    ],
    observation:
      'Malformed and truncated fixture archives preserved both verified members. A complete archive replaced the affected member.',
    remainingHostQuestion:
      'How the pinned host behaves when its archive stream ends early.',
  },
  {
    id: 'suspension-and-offline-are-not-deletion',
    tests: [
      'pds_space_sync::tests::suspension_and_unreachability_preserve_the_member_until_a_clean_poll',
    ],
    observation:
      'The injected suspended and unreachable responses preserved both members. A later clean poll promoted the new revision.',
    remainingHostQuestion:
      'The response to official suspension, transport failure during actual service downtime, and sync after restoration.',
  },
  {
    id: 'non-member-forged-boundary-write-never-indexed',
    tests: [
      'pds_space_scheduler::tests::the_scheduler_only_indexes_a_claimed_boundary_after_authority_membership',
      'pds_space_sync::tests::a_forged_boundary_in_a_record_changes_nothing_about_where_it_is_served',
    ],
    observation:
      'The scheduler excluded the nonmember and indexed the eligible control. After enrollment the record was served only under the enrolled boundary.',
    remainingHostQuestion: 'Upstream write admission remains unverified.',
  },
] as const
