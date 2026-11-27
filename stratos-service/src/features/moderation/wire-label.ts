import {
  ACCOUNT_SUBJECT_TYPE,
  RECORD_SUBJECT_TYPE,
  type StoredLabel,
} from '@northskysocial/stratos-core'

export function toWireLabel(label: StoredLabel): Record<string, unknown> {
  return {
    seq: label.seq,
    subject:
      label.subjectKind === 'account'
        ? { $type: ACCOUNT_SUBJECT_TYPE, did: label.subjectKey }
        : {
            $type: RECORD_SUBJECT_TYPE,
            uri: label.subjectKey,
            ...(label.cid === undefined ? {} : { cid: label.cid }),
          },
    val: label.val,
    neg: label.neg,
    ...(label.ref === undefined ? {} : { ref: label.ref }),
    createdAt: label.createdAt,
  }
}
