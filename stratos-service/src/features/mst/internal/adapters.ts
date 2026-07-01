import { Cid } from '@atproto/lex-data'
import type {
  RepoWrite,
  SequencingService,
  SigningService,
} from '@northskysocial/stratos-core'
import type { ActorSignFn } from '../../../infra/signing/actor-signer.js'
import { ActorTransactor } from '../../../actor-store-types.js'
import { sequenceChange, SequenceTrace } from '../../../api'

/**
 * Adapter that satisfies the core {@link SigningService} from a bound
 * {@link ActorSignFn}. It holds only the signing function (which internally
 * reaches into `infra/signing/`), never a `Keypair` — so no raw private key
 * material lives in this module.
 */
export class SignFnSigningService implements SigningService {
  constructor(private readonly sign: ActorSignFn) {}

  /**
   * Sign a commit via the bound signing function.
   * @param _did - The DID of the actor.
   * @param unsignedBytes - The unsigned bytes to sign.
   * @returns A Promise resolving to the signed bytes.
   */
  async signCommit(
    _did: string,
    unsignedBytes: Uint8Array,
  ): Promise<Uint8Array> {
    return this.sign(unsignedBytes)
  }
}

/**
 * Adapter for sequencing changes using existing sequenceChange utility
 */
export class ActorStoreSequencingService implements SequencingService {
  constructor(
    private store: ActorTransactor,
    private trace?: SequenceTrace,
  ) {}

  /**
   * Sequence changes for a given DID, commit CID, revision, and writes.
   * @param _did - The DID of the actor.
   * @param commitCid - The CID of the commit.
   * @param rev - The revision string.
   * @param writes - An array of RepoWrite objects representing changes.
   * @returns A Promise resolving when all changes are sequenced.
   */
  async sequenceChange(
    _did: string,
    commitCid: Cid,
    rev: string,
    writes: RepoWrite[],
  ): Promise<void> {
    // We only sequence the first write for now, or we could loop.
    // The existing sequenceChange handles one op at a time.
    // In Stratos, most requests are single-record writes.
    for (const write of writes) {
      await sequenceChange(this.store, {
        action: write.action,
        uri: `at://${_did}/${write.collection}/${write.rkey}`,
        cid: write.cid?.toString(),
        record: write.record,
        commitCid: commitCid.toString(),
        rev,
        trace: this.trace,
      })
    }
  }
}
