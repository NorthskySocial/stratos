import { Agent } from '@atproto/api'
import type { ProfileRecordWriter } from '@northskysocial/stratos-core'

export type PdsAgentProvider = (did: string) => Promise<{ api: Agent } | null>

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
    const agent = await this.agentProvider(did)
    if (!agent) {
      throw new Error(`Failed to get PDS agent for ${did}`)
    }

    await agent.api.com.atproto.repo.putRecord({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey,
      record,
    })
  }

  /**
   * Deletes an enrollment record from the PDS for a given DID.
   * @param did - The DID of the actor.
   * @param rkey - The record key for the enrollment record.
   */
  async deleteEnrollmentRecord(did: string, rkey: string): Promise<void> {
    const agent = await this.agentProvider(did)
    if (!agent) {
      throw new Error(`Failed to get PDS agent for ${did}`)
    }

    await agent.api.com.atproto.repo.deleteRecord({
      repo: did,
      collection: 'zone.stratos.actor.enrollment',
      rkey,
    })
  }
}
