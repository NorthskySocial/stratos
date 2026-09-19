import type { EnrollmentStoreWriter } from '@northskysocial/stratos-core'
import {
  boundaryHash,
  boundaryPayload,
  BoundaryHistoryTruncatedError,
  decodeBoundaryCursor,
  encodeBoundaryCursor,
  readBoundaryState,
  verifyBoundaryOperation,
  type BoundaryAuthoritySigner,
  type BoundaryCheckpoint,
  type BoundaryOperation,
  type SignedBoundaryCheckpoint,
  type SignedBoundaryOperation,
} from './model.js'

export interface BoundaryAuditHead {
  sequence: number
  hash: string
}

export interface BoundaryAuditTransaction {
  enrollmentStore: EnrollmentStoreWriter
  head: BoundaryAuditHead
  append: (operation: SignedBoundaryOperation) => Promise<void>
  list: (after: number, limit: number) => Promise<SignedBoundaryOperation[]>
}

export interface BoundaryAuditBackend {
  transaction: <T>(
    did: string,
    work: (tx: BoundaryAuditTransaction) => Promise<T>,
  ) => Promise<T>
}

export interface BoundaryHistoryPage {
  operations: SignedBoundaryOperation[]
  cursor: string
  hasMore: boolean
}

export class BoundaryAudit {
  private signer?: BoundaryAuthoritySigner

  constructor(
    private readonly authority: string,
    private readonly backend: BoundaryAuditBackend,
  ) {}

  setSigner(signer: BoundaryAuthoritySigner): void {
    this.signer = signer
  }

  private authoritySigner(): BoundaryAuthoritySigner {
    if (!this.signer)
      throw new Error('Boundary audit signing is not initialized')
    return this.signer
  }

  async mutate(
    did: string,
    mutation: (store: EnrollmentStoreWriter) => Promise<void>,
  ): Promise<void> {
    const signer = this.authoritySigner()
    await this.backend.transaction(did, async (tx) => {
      const before = await readBoundaryState(tx.enrollmentStore, did)
      await mutation(tx.enrollmentStore)
      const after = await readBoundaryState(tx.enrollmentStore, did)
      if (JSON.stringify(before) === JSON.stringify(after)) return

      const operation: BoundaryOperation = {
        $type: 'zone.stratos.boundary.operation',
        authority: this.authority,
        did,
        sequence: tx.head.sequence + 1,
        previousHash: tx.head.hash,
        recordedAt: new Date().toISOString(),
        signingKey: signer.publicKey,
        before,
        after,
      }
      const bytes = boundaryPayload(operation)
      await tx.append({
        operation,
        hash: boundaryHash(bytes),
        signature: Buffer.from(await signer.sign(bytes)).toString('base64'),
      })
    })
  }

  async list(
    did: string,
    limit = 50,
    cursor?: string,
  ): Promise<BoundaryHistoryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('limit must be an integer from 1 to 100')
    }
    const start = decodeBoundaryCursor(did, cursor)
    return this.backend.transaction(did, async (tx) => {
      const operations = await tx.list(start.sequence, limit)
      let position = start
      for (const signed of operations) {
        const op = signed.operation
        if (
          op.$type !== 'zone.stratos.boundary.operation' ||
          op.authority !== this.authority ||
          op.did !== did ||
          op.sequence !== position.sequence + 1 ||
          op.previousHash !== position.hash ||
          !(await verifyBoundaryOperation(signed))
        ) {
          throw new BoundaryHistoryTruncatedError()
        }
        position = { sequence: op.sequence, hash: signed.hash }
      }
      if (operations.length < limit && position.sequence !== tx.head.sequence) {
        throw new BoundaryHistoryTruncatedError()
      }
      if (
        position.sequence === tx.head.sequence &&
        position.hash !== tx.head.hash
      ) {
        throw new BoundaryHistoryTruncatedError()
      }
      return {
        operations,
        cursor: encodeBoundaryCursor(did, position.sequence, position.hash),
        hasMore: position.sequence < tx.head.sequence,
      }
    })
  }

  async checkpoint(did: string): Promise<SignedBoundaryCheckpoint> {
    const signer = this.authoritySigner()
    return this.backend.transaction(did, async (tx) => {
      const checkpoint: BoundaryCheckpoint = {
        $type: 'zone.stratos.boundary.checkpoint',
        authority: this.authority,
        did,
        sequence: tx.head.sequence,
        headHash: tx.head.hash,
        recordedAt: new Date().toISOString(),
        signingKey: signer.publicKey,
        state: await readBoundaryState(tx.enrollmentStore, did),
      }
      return {
        checkpoint,
        signature: Buffer.from(
          await signer.sign(boundaryPayload(checkpoint)),
        ).toString('base64'),
        cursor: encodeBoundaryCursor(did, tx.head.sequence, tx.head.hash),
      }
    })
  }
}
