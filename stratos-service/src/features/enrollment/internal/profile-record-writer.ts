import type { ProfileRecordWriter } from '@northskysocial/stratos-core'
import { Client, type FetchHandler } from '@atcute/client'
import '@atcute/atproto'

export type PdsAgentProvider = (
  did: string,
) => Promise<{ handler: FetchHandler } | null>

/**
 * Implementation of ProfileRecordWriter
 *
 * @param agentProvider - Function to provide an agent for a given DID.
 */
export class ProfileRecordWriterImpl implements ProfileRecordWriter {
  constructor(private agentProvider: PdsAgentProvider) {}

  /**
   * Writes an enrollment record to the PDS for a given DID.
   * @param did - The DID of the actor.
   * @param rkey - The record key for the enrollment record.
   * @param record - The enrollment record to write.
   */
  async putEnrollmentRecord(
    did: string,
    rkey: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    const agent = await this.agentProvider(did).catch((err) => {
      throw new Error(`Failed to get PDS agent for ${did}`, { cause: err })
    })
    if (!agent) {
      throw new Error(`Failed to get PDS agent for ${did}`)
    }

    const client = new Client({ handler: agent.handler })

    try {
      await client.call(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'com.atproto.repo.putRecord' as any,
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          repo: did as any,
          collection: 'zone.stratos.actor.enrollment',
          rkey,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          record: record as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      )
    } catch (err) {
      throw new Error(`Failed to put enrollment record to PDS for ${did}`, {
        cause: err,
      })
    }
  }

  /**
   * Deletes an enrollment record from the PDS for a given DID.
   * @param did - The DID of the actor.
   * @param rkey - The record key for the enrollment record.
   */
  async deleteEnrollmentRecord(did: string, rkey: string): Promise<void> {
    const agent = await this.agentProvider(did).catch((err) => {
      throw new Error(`Failed to get PDS agent for ${did}`, { cause: err })
    })
    if (!agent) {
      throw new Error(`Failed to get PDS agent for ${did}`)
    }

    const client = new Client({ handler: agent.handler })

    try {
      await client.call(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'com.atproto.repo.deleteRecord' as any,
        {
          repo: did,
          collection: 'zone.stratos.actor.enrollment',
          rkey,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      )
    } catch (err) {
      throw new Error(
        `Failed to delete enrollment record from PDS for ${did}`,
        {
          cause: err,
        },
      )
    }
  }
}
