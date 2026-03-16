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
import type { ServicePgDb } from '../../db/pg.js'

export interface PostgresStorageFactoryConfig {
  connectionString: string
  serviceDb: ServicePgDb
  cborToRecord: (content: Uint8Array) => Record<string, unknown>
  blobContentStoreCreator: (did: string) => BlobContentStore
}

function actorSchemaName(didHash: string): string {
  return `actor_${didHash.slice(0, 12)}`
}

export class PostgresStorageFactory implements StorageFactory {
  readonly backend: StorageBackend = 'postgres'

  private readonly connectionString: string
  private serviceDb: ServicePgDb
  private cborToRecord: (content: Uint8Array) => Record<string, unknown>
  private blobContentStoreCreator: (did: string) => BlobContentStore
  private pool: postgres.Sql

  constructor(config: PostgresStorageFactoryConfig) {
    this.connectionString = config.connectionString
    this.serviceDb = config.serviceDb
    this.cborToRecord = config.cborToRecord
    this.blobContentStoreCreator = config.blobContentStoreCreator
    this.pool = postgres(this.connectionString, { max: 20 })
  }

  private async getActorSchemaName(did: string): Promise<string> {
    const didHash = await crypto.sha256Hex(did)
    return actorSchemaName(didHash)
  }

  private createActorDb(schemaName: string): StratosPgDb {
    const client = postgres(this.connectionString, {
      max: 5,
      connection: { search_path: schemaName },
    })
    return drizzle({ client, schema: pgActorSchema })
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
    const actorDb = this.createActorDb(schemaName)
    await migrateStratosPgDb(actorDb, schemaName)
  }

  async deleteActor(did: string): Promise<void> {
    const schemaName = await this.getActorSchemaName(did)
    const db = drizzle({ client: this.pool })
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`))
  }

  async getActorReaders(did: string): Promise<ActorStoreReaders> {
    const schemaName = await this.getActorSchemaName(did)
    const actorDb = this.createActorDb(schemaName)

    return {
      record: new PgRecordStoreReader(actorDb, this.cborToRecord),
      blobMetadata: new PgBlobMetadataReader(actorDb),
      blobContent: this.blobContentStoreCreator(did),
      repo: new PgRepoStoreReader(actorDb),
      sequence: new PgSequenceStoreReader(actorDb),
    }
  }

  async transactActor<T>(
    did: string,
    fn: (stores: ActorStoreWriters) => Promise<T>,
  ): Promise<T> {
    const schemaName = await this.getActorSchemaName(did)
    const actorDb = this.createActorDb(schemaName)

    return await actorDb.transaction(async (tx) => {
      const stores: ActorStoreWriters = {
        record: new PgRecordStoreWriter(
          tx as unknown as StratosPgDb,
          this.cborToRecord,
        ),
        blobMetadata: new PgBlobMetadataWriter(tx as unknown as StratosPgDb),
        blobContent: this.blobContentStoreCreator(did),
        repo: new PgRepoStoreWriter(tx as unknown as StratosPgDb),
        sequence: new PgSequenceStoreWriter(tx as unknown as StratosPgDb),
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
    await this.pool.end()
  }
}
