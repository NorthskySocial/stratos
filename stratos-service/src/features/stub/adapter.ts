import { CID } from '@atproto/lex-data'
import type {
  StubWriterService,
  WriteStubResult,
} from '@northskysocial/stratos-core'
import { generateStub, NotEnrolledError } from '@northskysocial/stratos-core'

/**
 * Agent interface for writing to user's PDS
 */
export interface PdsAgent {
  api: {
    com: {
      atproto: {
        repo: {
          createRecord: (params: {
            repo: string
            collection: string
            rkey?: string
            record: Record<string, unknown>
            swapRecord?: string | null
            swapCommit?: string | null
          }, opts?: Record<string, unknown>) => Promise<{ data: { uri: string; cid: string } }>
          deleteRecord: (
            params: {
              repo: string
              collection: string
              rkey: string
              swapRecord?: string | null
              swapCommit?: string | null
            },
            opts?: Record<string, unknown>,
          ) => Promise<void>
        }
      }
    }
  }
}

/**
 * Implementation of StubWriterService port
 * Writes stub records to user's PDS via their OAuth session
 */
export class StubWriterServiceImpl implements StubWriterService {
  constructor(
    private getAgent: (did: string) => Promise<PdsAgent | null>,
    private serviceDid: string,
  ) {}

  /**
   * Write a stub record to the user's PDS'
   * @param did - The user's DID.
   * @param collection - The collection name for the stub record.
   * @param rkey - The record key for the stub record.
   * @param recordType - The type of the stub record.
   * @param fullRecordCid - The CID of the full record.
   * @param createdAt - The creation timestamp of the stub record.
   * @returns A WriteStubResult indicating success or failure.
   */
  async writeStub(
    did: string,
    collection: string,
    rkey: string,
    recordType: string,
    fullRecordCid: CID,
    createdAt: string,
  ): Promise<WriteStubResult> {
    const agent = await this.getAgent(did)
    if (!agent) {
      throw new NotEnrolledError(did)
    }

    const uri = `at://${did}/${collection}/${rkey}`
    const stub = generateStub({
      uri,
      cid: fullRecordCid,
      recordType,
      createdAt,
      serviceDid: this.serviceDid,
    })

    const result = await agent.api.com.atproto.repo.createRecord({
      repo: did,
      collection,
      rkey,
      record: stub as unknown as Record<string, unknown>,
    })

    return {
      uri: result.data.uri,
      cid: result.data.cid,
    }
  }

  /**
   * Delete a stub record from the user's PDS.
   * @param did - The user's DID.
   * @param collection - The collection name for the stub record.
   * @param rkey - The record key for the stub record.
   */
  async deleteStub(
    did: string,
    collection: string,
    rkey: string,
  ): Promise<void> {
    const agent = await this.getAgent(did)
    if (!agent) {
      throw new NotEnrolledError(did)
    }

    await agent.api.com.atproto.repo.deleteRecord({
      repo: did,
      collection,
      rkey,
    })
  }
}
