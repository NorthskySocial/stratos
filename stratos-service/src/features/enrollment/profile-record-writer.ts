import { Agent } from '@atproto/api'
import type { ProfileRecordWriter } from '@northskysocial/stratos-core'

export type PdsAgentProvider = (did: string) => Promise<{ api: Agent } | null>

/**
 * Implementation of ProfileRecordWriter port
 */
export class ProfileRecordWriterImpl implements ProfileRecordWriter {
  constructor(private agentProvider: PdsAgentProvider) {}

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
