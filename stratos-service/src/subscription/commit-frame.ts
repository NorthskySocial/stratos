import type { LexValue } from '@atproto/lex-cbor'
import { MessageFrame } from '@atproto/xrpc-server'
import type { RecordOp } from './subscribe-records.js'

const SUBSCRIBE_RECORDS_NSID = 'zone.stratos.sync.subscribeRecords'

/**
 * The largest commit frame the actor stream sends, and so the most one boundary
 * commit may carry. The feed generator reads frames up to the same size
 * (`MAX_ACTOR_FRAME_BYTES` in stratos-feedgen-ng `config.rs`). It covers the
 * largest frame a boundary applyWrites body can produce, 2,297,439 bytes from
 * 200 writes in `BOUNDARY_WRITE_JSON_LIMIT_BYTES` of JSON: an integer written
 * as `5e9` takes 3 bytes of JSON and 9 of CBOR. The derivation is in
 * stratos-feedgen-ng/README.md.
 */
export const MAX_COMMIT_FRAME_BYTES = 2_359_296

// The longest values the frame's sequence, time and revision can take, so the
// measured frame is never smaller than the one the stream sends.
const LONGEST_SEQ = Number.MAX_SAFE_INTEGER
const LONGEST_TIME = '9999-12-31T23:59:59.999Z'
const LONGEST_REV = 'zzzzzzzzzzzzz'

/**
 * The size of the commit frame the actor stream would send for these ops,
 * measured with the stream's own frame encoder.
 */
export function commitFrameBytes(did: string, ops: RecordOp[]): number {
  return MessageFrame.fromLexValue(
    {
      $type: `${SUBSCRIBE_RECORDS_NSID}#commit`,
      seq: LONGEST_SEQ,
      did,
      time: LONGEST_TIME,
      rev: LONGEST_REV,
      // The stream sends the ops it decoded from the event, which holds them
      // as written here; the record values are lex values.
      ops: ops as unknown as LexValue,
    },
    SUBSCRIBE_RECORDS_NSID,
  ).toBytes().length
}
