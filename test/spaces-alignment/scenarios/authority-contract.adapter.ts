/** Sandbox-only model. It must never be used as a production space host. */

export interface AuthorityMember {
  did: string
  custody: 'pds' | 'stratos'
  active: boolean
  boundaries: readonly string[]
}

export interface SignedPdsHead {
  space: string
  did: string
  rev: string
  hash: Uint8Array
}

const VERIFIED_HEAD = Symbol('verified PDS head')

export interface VerifiedPdsHead extends SignedPdsHead {
  readonly [VERIFIED_HEAD]: true
}

export interface StandardWriter {
  did: string
  rev: string
  hash: Uint8Array
}

export interface WriterSetPlan {
  rows: StandardWriter[]
  blockers: string[]
  publishable: boolean
}

const TID = /^[234567a-z]{13}$/
const SPACE_URI =
  /^at:\/\/did:[^/]+\/space\/[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+\/[A-Za-z0-9._~-]+$/

/** Keep cryptographic verification outside this pure fixture model. */
export async function confirmPdsHead(
  head: SignedPdsHead,
  verify: (head: SignedPdsHead) => Promise<void>,
): Promise<VerifiedPdsHead> {
  if (
    !SPACE_URI.test(head.space) ||
    !head.did.startsWith('did:') ||
    !TID.test(head.rev) ||
    head.hash.length !== 32
  ) {
    throw new Error('Invalid standard PDS head')
  }
  const space = head.space
  const did = head.did
  const rev = head.rev
  const verifiedHash = Uint8Array.from(head.hash)
  await verify({ space, did, rev, hash: Uint8Array.from(verifiedHash) })
  return Object.freeze({
    space,
    did,
    rev,
    get hash() {
      return Uint8Array.from(verifiedHash)
    },
    [VERIFIED_HEAD]: true as const,
  })
}

/** Select only authority-admitted writers with verified standard heads. */
export function planStandardWriters(
  members: readonly AuthorityMember[],
  boundary: string,
  space: string,
  heads: ReadonlyMap<string, VerifiedPdsHead>,
): WriterSetPlan {
  if (!SPACE_URI.test(space)) throw new Error('Invalid standard space URI')
  const rows: StandardWriter[] = []
  const blockers: string[] = []
  for (const member of members) {
    if (!member.active || !member.boundaries.includes(boundary)) continue
    if (member.custody !== 'pds') {
      blockers.push(`MST custody has no standard head: ${member.did}`)
      continue
    }
    const head = heads.get(member.did)
    if (
      !head ||
      head[VERIFIED_HEAD] !== true ||
      head.did !== member.did ||
      head.space !== space
    ) {
      blockers.push(`Missing verified PDS head: ${member.did}`)
      continue
    }
    rows.push({
      did: member.did,
      rev: head.rev,
      hash: Uint8Array.from(head.hash),
    })
  }
  return { rows, blockers, publishable: blockers.length === 0 }
}

export interface WriteNotification {
  space: string
  repo: string
  rev: string
  hash: Uint8Array
  issuer: string
  audience: string
}

/** A notification can advance an existing writer; it cannot discover one. */
export function advanceKnownWriter(
  rows: readonly StandardWriter[],
  notification: WriteNotification,
  authorityDid: string,
  expectedSpace: string,
  boundary: string,
  currentMembers: readonly AuthorityMember[],
  head: VerifiedPdsHead,
): StandardWriter[] {
  if (
    notification.issuer !== notification.repo ||
    notification.audience !== authorityDid ||
    notification.space !== expectedSpace ||
    !expectedSpace.startsWith(`at://${authorityDid}/space/`)
  ) {
    throw new Error('Notification identity does not match the space')
  }
  const index = rows.findIndex((row) => row.did === notification.repo)
  if (index < 0) throw new Error('Notification cannot discover a writer')
  const currentMember = currentMembers.find(
    (member) => member.did === notification.repo,
  )
  if (
    !currentMember ||
    !currentMember.active ||
    currentMember.custody !== 'pds' ||
    !currentMember.boundaries.includes(boundary)
  ) {
    throw new Error('Notification writer is not an active space member')
  }
  if (
    head[VERIFIED_HEAD] !== true ||
    head.space !== expectedSpace ||
    head.did !== notification.repo ||
    head.rev !== notification.rev ||
    head.hash.length !== notification.hash.length ||
    !head.hash.every((byte, position) => byte === notification.hash[position])
  ) {
    throw new Error('Notification does not match a verified PDS head')
  }
  const next = rows.map((row) => ({ ...row, hash: Uint8Array.from(row.hash) }))
  next[index] = {
    did: head.did,
    rev: head.rev,
    hash: Uint8Array.from(head.hash),
  }
  return next
}
