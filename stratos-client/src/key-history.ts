import { encode, toBytes } from '@atcute/cbor'
import { verifySigWithDidKey } from '@atcute/crypto'

export interface ServiceKeyHistoryEntry {
  versionId: string
  key: string
  validFrom: string
  previousVersionId: string | null
  proof: string
  acceptance: string
}

export interface ServiceKeyHistory {
  serviceDid: string
  entries: ServiceKeyHistoryEntry[]
}

export interface HistorySigner {
  did(): string
  sign(bytes: Uint8Array): Promise<Uint8Array>
}

export const MAX_KEY_HISTORY_ENTRIES = 1024
const HISTORY_TYPE = 'zone.stratos.identity.keyHistory'

export function keyHistoryTimestamp(value: string): number {
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error('Key history requires canonical UTC timestamps')
  }
  return time
}

function payload(
  serviceDid: string,
  entry: Omit<ServiceKeyHistoryEntry, 'versionId' | 'proof' | 'acceptance'>,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encode({ type: HISTORY_TYPE, serviceDid, ...entry }))
}

async function versionId(
  version: number,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `${version}-${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function signaturePayload(
  purpose: 'authorize' | 'accept',
  id: string,
  bytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    encode({
      type: HISTORY_TYPE,
      purpose,
      versionId: id,
      entry: toBytes(bytes),
    }),
  )
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

export async function appendServiceKeyHistory(
  history: ServiceKeyHistory,
  previousSigner: HistorySigner,
  nextSigner: HistorySigner,
  validFrom: string,
): Promise<ServiceKeyHistory> {
  const previous = history.entries.at(-1)
  if (previous)
    await verifyServiceKeyHistory(
      history,
      history.serviceDid,
      previousSigner.did(),
    )
  else if (previousSigner.did() !== nextSigner.did())
    throw new Error('Genesis requires its own signing key')
  const body = {
    key: nextSigner.did(),
    validFrom,
    previousVersionId: previous?.versionId ?? null,
  }
  const bytes = payload(history.serviceDid, body)
  const id = await versionId(history.entries.length + 1, bytes)
  const entry = {
    ...body,
    versionId: id,
    proof: toBase64(
      await previousSigner.sign(signaturePayload('authorize', id, bytes)),
    ),
    acceptance: toBase64(
      await nextSigner.sign(signaturePayload('accept', id, bytes)),
    ),
  }
  const result = {
    serviceDid: history.serviceDid,
    entries: [...history.entries, entry],
  }
  await verifyServiceKeyHistory(result, history.serviceDid, nextSigner.did())
  return result
}

export async function verifyServiceKeyHistory(
  input: unknown,
  serviceDid: string,
  currentKey: string,
): Promise<ServiceKeyHistory> {
  const history = parseHistory(input, serviceDid)
  let previous: ServiceKeyHistoryEntry | undefined
  const keys = new Set<string>()
  for (const [index, entry] of history.entries.entries()) {
    validateEntry(entry, previous, keys)
    const time = keyHistoryTimestamp(entry.validFrom)
    if (previous && time <= keyHistoryTimestamp(previous.validFrom))
      throw new Error('Key history timestamps must increase')
    const bytes = payload(serviceDid, {
      key: entry.key,
      validFrom: entry.validFrom,
      previousVersionId: entry.previousVersionId,
    })
    const expectedId = await versionId(index + 1, bytes)
    if (entry.versionId !== expectedId)
      throw new Error('Key history hash chain mismatch')
    if (
      !(await verifySigWithDidKey(
        previous?.key ?? entry.key,
        fromBase64(entry.proof),
        signaturePayload('authorize', expectedId, bytes),
      ))
    ) {
      throw new Error('Key history authorization signature failed')
    }
    if (
      !(await verifySigWithDidKey(
        entry.key,
        fromBase64(entry.acceptance),
        signaturePayload('accept', expectedId, bytes),
      ))
    ) {
      throw new Error('Key history acceptance signature failed')
    }
    keys.add(entry.key)
    previous = entry
  }
  if (previous!.key !== currentKey)
    throw new Error('Key history does not match the current DID key')
  return history
}

function parseHistory(input: unknown, serviceDid: string): ServiceKeyHistory {
  const history = input as ServiceKeyHistory | null
  if (
    !history ||
    history.serviceDid !== serviceDid ||
    !serviceDid.startsWith('did:web:') ||
    !Array.isArray(history.entries) ||
    history.entries.length === 0 ||
    history.entries.length > MAX_KEY_HISTORY_ENTRIES
  ) {
    throw new Error('Invalid service key history')
  }
  return history
}

export function findHistoricalSigningKey(
  history: ServiceKeyHistory,
  key: string,
  issuedAt: string,
): string {
  const timestamp = keyHistoryTimestamp(issuedAt)
  const index = history.entries.findIndex((entry) => entry.key === key)
  const entry = history.entries[index]
  const next = history.entries[index + 1]
  if (
    !entry ||
    timestamp < keyHistoryTimestamp(entry.validFrom) ||
    (next && timestamp >= keyHistoryTimestamp(next.validFrom))
  ) {
    throw new Error(
      'Attestation signing key is outside its authorized time window',
    )
  }
  return entry.key
}

function validateEntry(
  entry: ServiceKeyHistoryEntry,
  previous: ServiceKeyHistoryEntry | undefined,
  keys: Set<string>,
): void {
  if (
    !entry ||
    typeof entry.key !== 'string' ||
    typeof entry.validFrom !== 'string' ||
    typeof entry.proof !== 'string' ||
    typeof entry.acceptance !== 'string' ||
    entry.previousVersionId !== (previous?.versionId ?? null) ||
    keys.has(entry.key)
  ) {
    throw new Error('Invalid key history entry')
  }
}
