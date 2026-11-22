/**
 * The body of `com.atproto.space.notifyRepoUpdate`, which a repo host sends a
 * space host after a write to a space repo. No pinned package ships the
 * lexicon, so its shape is checked here: `space` a string, `repo` a DID,
 * `repoRev` a TID and `data` lexicon bytes (`{ "$bytes": "<base64>" }`).
 *
 * Whether `space` names a space this service hosts is the caller's question,
 * answered with {@link parseSpaceUri}; a string that is not a space URI is an
 * unknown space, not a malformed body.
 */
import { TID } from '@atproto/common-web'
import { fromBase64 } from '@atproto/lex-data'
import { isValidTid } from '@atproto/syntax'

import { isSyntacticDid } from './domain.js'

/** How far ahead of the clock a notified repo revision may be. */
export const MAX_REPO_REV_LEAD_MS = 5 * 60 * 1000

export interface RepoUpdateNotice {
  space: string
  repo: string
  repoRev: string
  data: Uint8Array
}

export type RepoUpdateNoticeResult =
  | { ok: true; value: RepoUpdateNotice }
  | { ok: false; message: string }

const BYTES_KEY = '$bytes'

/** Checks a decoded JSON body against the notice's input schema. */
export function parseRepoUpdateNotice(body: unknown): RepoUpdateNoticeResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse('Input must be an object')
  }
  const { space, repo, repoRev, data } = body as Record<string, unknown>
  if (typeof space !== 'string') {
    return refuse('Input must have the property "space"')
  }
  if (typeof repo !== 'string' || !isSyntacticDid(repo)) {
    return refuse('Input/repo must be a valid did')
  }
  if (typeof repoRev !== 'string' || !isValidTid(repoRev)) {
    return refuse('Input/repoRev must be a valid TID')
  }
  const bytes = decodeLexBytes(data)
  if (!bytes) {
    return refuse('Input/data must be bytes')
  }
  return { ok: true, value: { space, repo, repoRev, data: bytes } }
}

/** True when the revision's timestamp is more than five minutes past `nowMs`. */
export function isRepoRevTooFarAhead(repoRev: string, nowMs: number): boolean {
  const revMicros = TID.fromStr(repoRev).timestamp()
  return revMicros > (nowMs + MAX_REPO_REV_LEAD_MS) * 1000
}

function decodeLexBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const keys = Object.keys(value)
  const encoded = (value as Record<string, unknown>)[BYTES_KEY]
  if (keys.length !== 1 || typeof encoded !== 'string') return undefined
  try {
    return fromBase64(encoded)
  } catch {
    return undefined
  }
}

function refuse(message: string): { ok: false; message: string } {
  return { ok: false, message }
}
