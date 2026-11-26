/**
 * The account takedown read-path matrix against the Postgres stores. Requires
 * Docker; starts its own PostgreSQL container.
 */
import { defineAccountTakedownReadPathScenarios } from './helpers/account-takedown-read-paths.js'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from './helpers/test-env.js'
import { startPostgresWriteHarness } from './helpers/write-harness.js'

defineAccountTakedownReadPathScenarios(
  'Postgres',
  async () => startPostgresWriteHarness(await startPostgresContainer()),
  stopPostgresContainer,
)
