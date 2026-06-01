import type { Logger, ProfileRecordWriter } from '@northskysocial/stratos-core'
import { Client, type FetchHandler } from '@atcute/client'
import * as comAtprotoRepoDeleteRecord from '@atcute/atproto/types/repo/deleteRecord'
import * as comAtprotoRepoPutRecord from '@atcute/atproto/types/repo/putRecord'
import '@atcute/atproto'

/**
 * Determines if the given error is a ClientResponseError.
 *
 * @param err - The error to check.
 * @returns True if the error is a ClientResponseError, false otherwise.
 */
function isClientResponseError(
  err: unknown,
): err is { error: string; status: number; description?: string } {
  return (
    err !== null &&
    typeof err === 'object' &&
    'error' in err &&
    typeof (err as Record<string, unknown>).error === 'string' &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number'
  )
}

/**
 * Encodes a Uint8Array to a base64 string without padding, as per ATProto spec for $bytes.
 *
 * @param bytes - The Uint8Array to encode.
 * @returns The base64 encoded string without padding.
 */
function encodeBase64NoPadding(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/**
 * Deeply transforms a record to convert Uint8Array fields into ATProto $bytes objects.
 *
 * @param record - The record to transform.
 * @returns The transformed record with Uint8Array fields replaced by ATProto $bytes objects.
 */
function transformRecord(record: unknown): unknown {
  if (record instanceof Uint8Array) {
    return { $bytes: encodeBase64NoPadding(record) }
  }
  if (Array.isArray(record)) {
    return record.map(transformRecord)
  }
  if (record !== null && typeof record === 'object') {
    const transformed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      transformed[key] = transformRecord(value)
    }
    return transformed
  }
  return record
}

export type PdsAgentProvider = (
  did: string,
) => Promise<{ handler: FetchHandler } | null>

/**
 * Implementation of ProfileRecordWriter
 *
 * @param agentProvider - Function to provide an agent for a given DID.
 * @param logger - Optional logger instance.
 */
export class ProfileRecordWriterImpl implements ProfileRecordWriter {
  constructor(
    private agentProvider: PdsAgentProvider,
    private logger?: Logger,
  ) {}

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
    this.logger?.info({ did, rkey }, 'putting enrollment record to PDS')
    const agent = await this.getAgent(did)
    const client = new Client({ handler: agent.handler })

    try {
      // First, attempt to delete any existing record with the same rkey.
      await this.deleteRecordIfExists(client, did, rkey)

      // Then, put the new record.
      await client.call(comAtprotoRepoPutRecord, {
        input: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          repo: did as any,
          collection: 'zone.stratos.actor.enrollment',
          rkey,
          record: transformRecord(record) as Record<string, unknown>,
          validate: false,
        },
      })
      this.logger?.info(
        { did, rkey },
        'successfully put enrollment record to PDS',
      )
    } catch (err: unknown) {
      this.logger?.error(
        { did, rkey, err },
        'failed to put enrollment record to PDS',
      )
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
    this.logger?.info({ did, rkey }, 'deleting enrollment record from PDS')
    const agent = await this.getAgent(did)
    const client = new Client({ handler: agent.handler })

    try {
      await client.call(comAtprotoRepoDeleteRecord, {
        input: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          repo: did as any,
          collection: 'zone.stratos.actor.enrollment',
          rkey,
        },
      })
      this.logger?.info(
        { did, rkey },
        'successfully deleted enrollment record from PDS',
      )
    } catch (err) {
      this.logger?.error(
        { did, rkey, err },
        'failed to delete enrollment record from PDS',
      )
      throw new Error(
        `Failed to delete enrollment record from PDS for ${did}`,
        {
          cause: err,
        },
      )
    }
  }

  /**
   * Get the agent for a given DID.
   * @param did - The DID of the actor.
   * @returns The agent for the DID.
   * @private
   */
  private async getAgent(did: string): Promise<{ handler: FetchHandler }> {
    const agent = await this.agentProvider(did).catch((err) => {
      this.logger?.error({ did, err }, 'failed to get PDS agent')
      throw new Error(`Failed to get PDS agent for ${did}`, { cause: err })
    })
    if (!agent) {
      this.logger?.error({ did }, 'PDS agent not found')
      throw new Error(`Failed to get PDS agent for ${did}`)
    }
    return agent
  }

  /**
   * Delete an enrollment record if it exists.
   * @param client - The client to use for the deletion.
   * @param did - The DID of the actor.
   * @param rkey - The rkey of the enrollment record.
   * @private
   */
  private async deleteRecordIfExists(
    client: Client,
    did: string,
    rkey: string,
  ): Promise<void> {
    // First, attempt to delete any existing record with the same rkey.
    // We ignore errors here because the record might not exist.
    try {
      await client.call(comAtprotoRepoDeleteRecord, {
        input: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          repo: did as any,
          collection: 'zone.stratos.actor.enrollment',
          rkey,
        },
      })
      this.logger?.debug({ did, rkey }, 'deleted existing enrollment record')
    } catch (err: unknown) {
      // Only ignore if it's a "RecordNotFound" error.
      // Atcute's ClientResponseError has an `error` property with the error name.
      if (
        isClientResponseError(err) &&
        (err.error === 'RecordNotFound' ||
          (err.status === 400 &&
            err.error === 'InvalidRequest' &&
            err.description?.includes('Record not found')))
      ) {
        // Ignore
        this.logger?.debug(
          { did, rkey },
          'no existing enrollment record to delete',
        )
      } else {
        this.logger?.error(
          { did, rkey, err },
          'failed to delete existing enrollment record',
        )
        throw err
      }
    }
  }
}
