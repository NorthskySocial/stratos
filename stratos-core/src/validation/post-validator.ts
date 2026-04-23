import { AtUri } from '@atproto/syntax'
import { StratosValidationError } from '../types.js'
import { BaseValidator, type RepoRecord } from './base.js'

interface ReplyRef {
  root: { uri: string; cid: string }
  parent: { uri: string; cid: string }
}

/**
 * Validates stratos post-records for domain boundaries and cross-namespace isolation.
 */
export class PostValidator extends BaseValidator {
  collection = 'zone.stratos.feed.post'

  /**
   * Validate a post-record.
   * @param record - The record to validate.
   * @param parentBoundaries - The boundaries of the parent record, if this is a reply.
   * @throws StratosValidationError if the record is invalid.
   */
  validate(record: RepoRecord, parentBoundaries?: string[]): void {
    this.assertBoundaryPresence(record.boundary)
    this.validateBoundaryDomains(record.boundary)

    if (record.reply) {
      this.assertReplyIsolation(record.reply as ReplyRef)
      this.assertReplyBoundaryConsistency(
        record.boundary as { values: Array<{ value: string }> },
        parentBoundaries,
      )
    }

    if (record.embed) {
      this.assertNoCrossNamespaceEmbed(record.embed, 'stratos')
    }
  }

  /**
   * Asserts that a reply is isolated from its parent and root.
   * @param reply - The reply to validate.
   * @throws StratosValidationError if the reply is not isolated.
   * @private
   */
  private assertReplyIsolation(reply: ReplyRef): void {
    const parentUri = new AtUri(reply.parent.uri)
    const rootUri = new AtUri(reply.root.uri)

    if (
      !parentUri.collection.startsWith('zone.stratos.') ||
      !rootUri.collection.startsWith('zone.stratos.')
    ) {
      throw new StratosValidationError(
        'Replies cannot cross namespace boundaries',
        'CrossNamespaceReply',
      )
    }
  }

  /**
   * Asserts that a reply boundary is a subset of the parent boundaries.
   * @param boundary - The boundary to validate.
   * @param parentBoundaries - The boundaries of the parent record, if this is a reply.
   * @throws StratosValidationError if the boundary is not a subset of the parent boundaries.
   * @private
   */
  private assertReplyBoundaryConsistency(
    boundary: { values: Array<{ value: string }> },
    parentBoundaries?: string[],
  ): void {
    if (!parentBoundaries) return

    const currentDomains = boundary.values.map((d) => d.value)
    for (const domain of currentDomains) {
      if (!parentBoundaries.includes(domain)) {
        throw new StratosValidationError(
          'expands beyond parent boundaries',
          'ReplyBoundaryEscalation',
        )
      }
    }
  }

  /**
   * Asserts that an embed does not cross namespace boundaries.
   * @param embed - The embed to validate.
   * @param namespace - The namespace of the embed (stratos or bsky).
   * @throws StratosValidationError if the embed is invalid.
   * @private
   */
  private assertNoCrossNamespaceEmbed(embed: unknown, namespace: string): void {
    if (!embed || typeof embed !== 'object') return
    const e = embed as { record?: { uri?: string }; images?: unknown[] }

    if (e.record?.uri) {
      const uri = new AtUri(e.record.uri)
      const isStratos = uri.collection.startsWith('zone.stratos.')

      if (namespace === 'stratos' && !isStratos) {
        throw new StratosValidationError(
          'Stratos records cannot embed non-Stratos content',
          'CrossNamespaceEmbed',
        )
      }
      if (namespace === 'bsky' && isStratos) {
        throw new StratosValidationError(
          'Non-Stratos records cannot embed Stratos content',
          'CrossNamespaceEmbed',
        )
      }
    }
  }
}
