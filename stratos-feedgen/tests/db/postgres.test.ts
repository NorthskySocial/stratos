import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe } from 'vitest'
import {
  createPgDb,
  migratePgDb,
  PgFeedgenStore,
  type PgDb,
} from '../../src/db/index.js'
import { describeStoreContract } from './contract.js'

const RUN_PG_TESTS =
  process.env.FEEDGEN_RUN_PG_TESTS === '1' ||
  process.env.STRATOS_TEST_BACKEND === 'postgres'

const maybeDescribe = RUN_PG_TESTS ? describe : describe.skip

maybeDescribe('postgres backend (testcontainers)', () => {
  let container: StartedPostgreSqlContainer
  let pgUrl: string
  let cleanupDb: PgDb

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('feedgen_test')
      .withUsername('feedgen')
      .withPassword('feedgen')
      .start()
    pgUrl = container.getConnectionUri()
    cleanupDb = createPgDb(pgUrl)
    await migratePgDb(cleanupDb)
  }, 120_000)

  afterAll(async () => {
    if (cleanupDb) await cleanupDb._client.end()
    if (container) await container.stop()
  })

  describeStoreContract('postgres', {
    async build() {
      const db = createPgDb(pgUrl)
      await migratePgDb(db)
      await db.execute(
        sql.raw(
          'TRUNCATE TABLE post_boundary, post, sync_cursor, enrolled_actor, space_sync_cursor, space_sync_stage, space_sync_pending_verification, space_member_snapshot RESTART IDENTITY CASCADE',
        ),
      )
      return new PgFeedgenStore(db)
    },
  })
})
