import { WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import { CID } from 'multiformats/cid'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import PQueue from 'p-queue'
import type { EnrollmentCallback } from './pds/pds-firehose.js'
import { extractBoundaries, jsonToLex } from '@northskysocial/stratos-core'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

/**
 * Convert a provider endpoint to an HTTP URL.
 * @param endpoint - The provider endpoint.
 */
function toHttpUrl(endpoint: string): string {
  return endpoint
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
}

export interface BackfillOptions {
  repoProvider: string
  indexingService: IndexingService
  enrollmentCallback: EnrollmentCallback
  concurrency?: number
  onError?: (err: Error) => void
  onProgress?: (processed: number) => void
}

/**
 * Backfill repositories from a provider using the given options.
 *
 * @param opts - Backfill options.
 * @returns A Promise resolving to the number of processed repositories.
 */
export async function backfillRepos(opts: BackfillOptions): Promise<number> {
  let processed = 0
  const queue = new PQueue({ concurrency: opts.concurrency ?? 10 })

  for await (const page of listRepoPages(opts.repoProvider)) {
    for (const repo of page) {
      void queue.add(async () => {
        try {
          await backfillViaListRecords(opts, repo.did)
          processed++
          opts.onProgress?.(processed)
        } catch (err) {
          opts.onError?.(
            new Error(`failed to backfill repo ${repo.did}`, { cause: err }),
          )
        }
      })
    }
    // Wait for current page to be mostly processed to avoid unbounded queue growth
    while (queue.size > 100) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  await queue.onIdle()
  return processed
}

/**
 * Backfill actors from a provider using the given options.
 *
 * @param opts - Backfill options.
 * @param dids - List of actor DIDs to backfill.
 * @returns A Promise resolving to the number of processed actors.
 */
export async function backfillActors(
  opts: BackfillOptions,
  dids: string[],
): Promise<number> {
  let processed = 0
  const queue = new PQueue({ concurrency: opts.concurrency ?? 10 })

  for (const did of dids) {
    void queue.add(async () => {
      try {
        await backfillViaListRecords(opts, did)
        processed++
        opts.onProgress?.(processed)
      } catch (err) {
        opts.onError?.(
          new Error(`failed to backfill repo ${did}`, { cause: err }),
        )
      }
    })
  }

  await queue.onIdle()
  return processed
}

/**
 * Backfill a single actor from a provider using the given options.
 *
 * @param opts - Backfill options.
 * @param did - The DID of the actor to backfill.
 */
export async function backfillSingleActor(
  opts: BackfillOptions,
  did: string,
): Promise<void> {
  await backfillViaListRecords(opts, did)
}

interface BackfillRecord {
  uri: string
  cid: string
  value: Record<string, unknown>
}

interface ListRecordsResponse {
  records: BackfillRecord[]
  cursor?: string
}

/**
 * Backfill records for a single actor from a provider using the given options.
 *
 * @param opts - Backfill options.
 * @param did - The DID of the actor to backfill.
 */
async function backfillViaListRecords(
  opts: BackfillOptions,
  did: string,
): Promise<void> {
  let cursor: string | undefined

  do {
    const response = await fetchRepoRecordsPage(opts, did, cursor)
    if (!response) break

    for (const record of response.records) {
      await indexBackfilledRecord(opts, did, record)
    }

    cursor = response.cursor
  } while (cursor)
}

/**
 * Fetch a single page of records for an actor.
 *
 * @param opts - Backfill options.
 * @param did - The DID of the actor.
 * @param cursor - Pagination cursor.
 * @returns The page of records, or null if fetch failed.
 */
async function fetchRepoRecordsPage(
  opts: BackfillOptions,
  did: string,
  cursor?: string,
): Promise<ListRecordsResponse | null> {
  const url = new URL(
    `/xrpc/com.atproto.repo.listRecords`,
    toHttpUrl(opts.repoProvider),
  )
  url.searchParams.set('repo', did)
  url.searchParams.set('limit', '100')
  if (cursor) url.searchParams.set('cursor', cursor)

  const res = await fetch(url.toString())
  if (!res.ok) return null

  return (await res.json()) as ListRecordsResponse
}

/**
 * Index a single backfilled record.
 *
 * @param opts - Backfill options.
 * @param did - The DID of the actor.
 * @param record - The record to index.
 */
async function indexBackfilledRecord(
  opts: BackfillOptions,
  did: string,
  record: BackfillRecord,
): Promise<void> {
  const uri = new AtUri(record.uri)
  try {
    await opts.indexingService.indexRecord(
      uri,
      CID.parse(record.cid),
      jsonToLex(record.value),
      WriteOpAction.Create,
      new Date().toISOString(),
    )

    if (uri.collection === ENROLLMENT_COLLECTION) {
      handleEnrollmentRecord(opts, did, record.value)
    }
  } catch (err) {
    opts.onError?.(
      new Error(`failed to index record ${record.uri}`, { cause: err }),
    )
  }
}

/**
 * Handle an enrollment record discovered during backfill.
 *
 * @param opts - Backfill options.
 * @param did - The DID of the actor.
 * @param recordValue - The raw record value.
 */
function handleEnrollmentRecord(
  opts: BackfillOptions,
  did: string,
  recordValue: Record<string, unknown>,
): void {
  const serviceUrl =
    typeof recordValue.service === 'string' ? recordValue.service : ''
  const boundaries = extractBoundaries(recordValue)

  if (serviceUrl) {
    opts.enrollmentCallback.onEnrollmentDiscovered(did, serviceUrl, boundaries)
  }
}

/**
 * List all repositories in a provider.
 *
 * @param repoProvider - The provider to list repositories from.
 * @returns An async generator yielding batches of repository DID records.
 */
async function* listRepoPages(
  repoProvider: string,
): AsyncGenerator<Array<{ did: string }>> {
  let cursor: string | undefined
  const httpBase = toHttpUrl(repoProvider)

  do {
    const url = new URL(`/xrpc/com.atproto.sync.listRepos`, httpBase)
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString())
    if (!res.ok) break

    const body = (await res.json()) as {
      repos: Array<{ did: string; rev?: string }>
      cursor?: string
    }

    yield body.repos
    cursor = body.cursor
  } while (cursor)
}
