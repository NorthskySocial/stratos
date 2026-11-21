import type { FetchHandler } from '@atcute/client'
import { createServiceFetchHandler, type RepositoryTarget } from './routing.js'

/** The space type every Stratos boundary is hosted as on a member's PDS. */
const BOUNDARY_SPACE_TYPE = 'zone.stratos.space.feed'

const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/
const NSID_PATTERN =
  /^[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?:\.[a-zA-Z](?:[a-zA-Z0-9]{0,62})?)$/
const SPACE_KEY_PATTERN = /^[a-zA-Z0-9_~.:-]{1,512}$/
const MAX_DID_LENGTH = 2048
const MAX_NSID_LENGTH = 253 + 1 + 63
const MIN_NSID_LENGTH = 5

export type UnresolvedReason = Extract<
  RepositoryTarget,
  { kind: 'unresolved' }
>['reason']

export type BoundaryWriteRefusal = UnresolvedReason | 'invalid-boundary'

export type BoundarySpaceUriResult =
  | { ok: true; value: string }
  | { ok: false; reason: string }

export type BoundaryWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BoundaryWriteRefusal }

/**
 * Formats the space URI of a boundary, `at://{serviceDid}/space/{spaceType}/{name}`
 * for the boundary `{serviceDid}/{name}`. Same output as the stratos-core
 * function of the same name; the client cannot import core, so a test in
 * stratos-service keeps the two in step.
 */
export const boundaryToSpaceUri = (
  boundary: string,
  spaceType: string,
): BoundarySpaceUriResult => {
  const slash = boundary.indexOf('/')
  if (slash === -1) {
    return {
      ok: false,
      reason: `boundary must be "{serviceDid}/{domainName}", got "${boundary}"`,
    }
  }
  const serviceDid = boundary.slice(0, slash)
  const name = boundary.slice(slash + 1)
  if (serviceDid.length > MAX_DID_LENGTH || !DID_PATTERN.test(serviceDid)) {
    return { ok: false, reason: `invalid service DID: "${serviceDid}"` }
  }
  if (
    spaceType.length > MAX_NSID_LENGTH ||
    spaceType.length < MIN_NSID_LENGTH ||
    !NSID_PATTERN.test(spaceType)
  ) {
    return { ok: false, reason: `invalid space type NSID: "${spaceType}"` }
  }
  if (name === '.' || name === '..' || !SPACE_KEY_PATTERN.test(name)) {
    return { ok: false, reason: `invalid boundary name: "${name}"` }
  }
  return { ok: true, value: `at://${serviceDid}/space/${spaceType}/${name}` }
}

/** What a write helper needs: an authenticated handler and where to send. */
export interface BoundaryWriteClient {
  /** Attaches the member's DPoP proof and access token. */
  handler: FetchHandler
  /** Usually `() => resolveRepositoryTarget(enrollment, hosts)`. */
  resolveTarget: () => RepositoryTarget
}

export interface CreateBoundaryRecordInput {
  boundary: string
  repo: string
  collection: string
  rkey?: string
  validate?: boolean
  record: unknown
}

export interface PutBoundaryRecordInput {
  boundary: string
  repo: string
  collection: string
  rkey: string
  validate?: boolean
  record: unknown
}

export interface DeleteBoundaryRecordInput {
  boundary: string
  repo: string
  collection: string
  rkey: string
}

export type BoundaryWriteAction = 'create' | 'update' | 'delete'

export interface BoundaryWriteOperation {
  action: BoundaryWriteAction
  collection: string
  /** Required for `update` and `delete`. */
  rkey?: string
  /** Required for `create` and `update`. */
  value?: unknown
}

export interface ApplyBoundaryWritesInput {
  boundary: string
  repo: string
  validate?: boolean
  writes: BoundaryWriteOperation[]
}

export interface RecordWriteOutput {
  uri: string
  cid: string
  validationStatus?: string
}

export interface ApplyBoundaryWritesOutput {
  results?: Array<{
    $type: string
    uri?: string
    cid?: string
    validationStatus?: string
  }>
}

/** An error response from the service or the PDS, by its error name. */
export class BoundaryWriteError extends Error {
  readonly status: number
  readonly errorName: string

  constructor(status: number, errorName: string, message: string) {
    super(message)
    this.name = 'BoundaryWriteError'
    this.status = status
    this.errorName = errorName
  }
}

/** The member's grant predates the collection; send them through authorization again. */
export class ScopeUpgradeRequiredError extends BoundaryWriteError {
  constructor(status: number, message: string) {
    super(status, 'ScopeUpgradeRequired', message)
    this.name = 'ScopeUpgradeRequiredError'
  }
}

type Procedure = 'createRecord' | 'putRecord' | 'deleteRecord' | 'applyWrites'

const procedureNsid = (target: RepositoryTarget, procedure: Procedure) =>
  target.kind === 'stratos'
    ? `zone.stratos.repo.${procedure}`
    : `com.atproto.space.${procedure}`

/** The boundary field Stratos takes, or the space field the PDS takes. */
const addressBoundary = (
  target: RepositoryTarget & { kind: 'stratos' | 'pds' },
  boundary: string,
): { ok: true; field: Record<string, string> } | { ok: false } => {
  if (target.kind === 'stratos') return { ok: true, field: { boundary } }
  const space = boundaryToSpaceUri(boundary, BOUNDARY_SPACE_TYPE)
  if (!space.ok) return { ok: false }
  return { ok: true, field: { space: space.value } }
}

const readFailure = async (response: Response): Promise<BoundaryWriteError> => {
  let errorName = 'UnknownError'
  let message = `Request failed with status ${response.status}`
  try {
    const body = (await response.json()) as {
      error?: unknown
      message?: unknown
    }
    if (typeof body.error === 'string') errorName = body.error
    if (typeof body.message === 'string') message = body.message
  } catch {
    // A non-JSON failure keeps the status-only message.
  }
  return errorName === 'ScopeUpgradeRequired'
    ? new ScopeUpgradeRequiredError(response.status, message)
    : new BoundaryWriteError(response.status, errorName, message)
}

const send = async <T>(
  client: BoundaryWriteClient,
  procedure: Procedure,
  boundary: string,
  body: (address: Record<string, string>, target: RepositoryTarget) => unknown,
): Promise<BoundaryWriteResult<T>> => {
  const target = client.resolveTarget()
  if (target.kind === 'unresolved') return { ok: false, reason: target.reason }
  const address = addressBoundary(target, boundary)
  if (!address.ok) return { ok: false, reason: 'invalid-boundary' }

  const response = await createServiceFetchHandler(
    client.handler,
    target.url,
  ).handle(`/xrpc/${procedureNsid(target, procedure)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body(address.field, target)),
  })
  if (!response.ok) throw await readFailure(response)
  return { ok: true, value: (await response.json()) as T }
}

export const createBoundaryRecord = (
  client: BoundaryWriteClient,
  { boundary, ...fields }: CreateBoundaryRecordInput,
): Promise<BoundaryWriteResult<RecordWriteOutput>> =>
  send(client, 'createRecord', boundary, (address) => ({
    ...address,
    ...fields,
  }))

export const putBoundaryRecord = (
  client: BoundaryWriteClient,
  { boundary, ...fields }: PutBoundaryRecordInput,
): Promise<BoundaryWriteResult<RecordWriteOutput>> =>
  send(client, 'putRecord', boundary, (address) => ({
    ...address,
    ...fields,
  }))

/** Deletes one record from a boundary; a missing record is not an error. */
export const deleteBoundaryRecord = (
  client: BoundaryWriteClient,
  { boundary, ...fields }: DeleteBoundaryRecordInput,
): Promise<BoundaryWriteResult<Record<string, never>>> =>
  send(client, 'deleteRecord', boundary, (address) => ({
    ...address,
    ...fields,
  }))

/** Applies creates, updates and deletes in one boundary as one commit. */
export const applyBoundaryWrites = (
  client: BoundaryWriteClient,
  { boundary, writes, ...fields }: ApplyBoundaryWritesInput,
): Promise<BoundaryWriteResult<ApplyBoundaryWritesOutput>> =>
  send(client, 'applyWrites', boundary, (address, target) => ({
    ...address,
    ...fields,
    writes: writes.map(({ action, ...operation }) => ({
      $type: `${procedureNsid(target, 'applyWrites')}#${action}`,
      ...operation,
    })),
  }))
