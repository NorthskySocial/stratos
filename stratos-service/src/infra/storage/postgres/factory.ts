import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import * as crypto from '@atproto/crypto'
import type {
  StorageFactory,
  StorageBackend,
  ActorStoreReaders,
  ActorStoreWriters,
  ServiceStores,
  BlobContentStore,
} from '@northskysocial/stratos-core'
import {
  type StratosPgDb,
  migrateStratosPgDb,
  pgSchema as pgActorSchema,
} from '@northskysocial/stratos-core'
import { PgRecordStoreReader, PgRecordStoreWriter } from './record-store.js'
import { PgBlobMetadataReader, PgBlobMetadataWriter } from './blob-store.js'
import { PgRepoStoreReader, PgRepoStoreWriter } from './repo-store.js'
import {
  PgSequenceStoreReader,
  PgSequenceStoreWriter,
} from './sequence-store.js'
import { PgEnrollmentStoreWriter } from './enrollment-store.js'
import type { ServicePgDb } from '../../../db/pg.js'

export interface PostgresStorageFactoryConfig {
  connectionString: string
  serviceDb: ServicePgDb
  cborToRecord: (content: Uint8Array) => Record<string, unknown>
  blobContentStoreCreator: (did: string) => BlobContentStore
  actorPoolSize?: number
}

function actorSchemaName(didHash: string): string {
  return `actor_${didHash.slice(0, 12)}`
}

export class PostgresStorageFactory implements StorageFactory {
  readonly backend: StorageBackend = 'postgres'

  private readonly serviceDb: ServicePgDb
  private readonly cborToRecord: (
    content: Uint8Array,
  ) => Record<string, unknown>
  private readonly blobContentStoreCreator: (did: string) => BlobContentStore
  private readonly pool: postgres.Sql
  private readonly actorPool: postgres.Sql
  private readonly actorDb: StratosPgDb

  constructor(config: PostgresStorageFactoryConfig) {
    this.serviceDb = config.serviceDb
    this.cborToRecord = config.cborToRecord
    this.blobContentStoreCreator = config.blobContentStoreCreator
    this.pool = postgres(config.connectionString, { max: 10 })
    this.actorPool = postgres(config.connectionString, {
      max: config.actorPoolSize ?? 30,
    })
    this.actorDb = drizzle({ client: this.actorPool, schema: pgActorSchema })
  }

  private async getActorSchemaName(did: string): Promise<string> {
    const didHash = await crypto.sha256Hex(did)
    return actorSchemaName(didHash)
  }

  private async withActorSchema<T>(
    schemaName: string,
    fn: (db: StratosPgDb) => Promise<T>,
  ): Promise<T> {
    return await this.actorDb.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`))
      return await fn(tx as unknown as StratosPgDb)
    })
  }

  async initialize(): Promise<void> {
    // Service tables are migrated separately via migrateServicePgDb
  }

  async actorExists(did: string): Promise<boolean> {
    const schemaName = await this.getActorSchemaName(did)
    const db = drizzle({ client: this.pool })
    const rows = await db.execute(
      sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schemaName} LIMIT 1`,
    )
    return rows.length > 0
  }

  async createActor(did: string): Promise<void> {
    const schemaName = await this.getActorSchemaName(did)
    // CREATE SCHEMA must run outside the actor schema's search_path
    const utilDb = drizzle({ client: this.pool })
    await utilDb.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`))
    await this.withActorSchema(schemaName, async (tx) => {
      await migrateStratosPgDb(tx)
    })
  }

  async deleteActor(did: string): Promise<void> {
    const schemaName = await this.getActorSchemaName(did)
    const db = drizzle({ client: this.pool })
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`))
  }

  async getActorReaders(did: string): Promise<ActorStoreReaders> {
    const schemaName = await this.getActorSchemaName(did)

    return {
      record: new PgRecordStoreReader(
        this.actorDb,
        this.cborToRecord,
        schemaName,
      ),
      blobMetadata: new PgBlobMetadataReader(this.actorDb, schemaName),
      blobContent: this.blobContentStoreCreator(did),
      repo: new PgRepoStoreReader(this.actorDb, schemaName),
      sequence: new PgSequenceStoreReader(this.actorDb, schemaName),
    }
  }

  async transactActor<T>(
    did: string,
    fn: (stores: ActorStoreWriters) => Promise<T>,
  ): Promise<T> {
    const schemaName = await this.getActorSchemaName(did)

    return await this.withActorSchema(schemaName, async (tx) => {
      const stores: ActorStoreWriters = {
        record: new PgRecordStoreWriter(tx, this.cborToRecord),
        blobMetadata: new PgBlobMetadataWriter(tx),
        blobContent: this.blobContentStoreCreator(did),
        repo: new PgRepoStoreWriter(tx),
        sequence: new PgSequenceStoreWriter(tx),
      }
      return await fn(stores)
    })
  }

  getServiceStores(): ServiceStores {
    return {
      enrollment: new PgEnrollmentStoreWriter(this.serviceDb),
    }
  }

  async close(): Promise<void> {
    await this.actorPool.end()
    await this.pool.end()
  }
}
