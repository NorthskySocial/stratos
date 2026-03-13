import { WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { EnrollmentCallback } from './pds-subscription.ts'
import { jsonToLex, parseCid } from './pds-subscription.ts'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

export interface BackfillOptions {
  repoProvider: string
  indexingService: IndexingService
  enrollmentCallback: EnrollmentCallback
  onError?: (err: Error) => void
  onProgress?: (processed: number, total: number) => void
}

export async function backfillRepos(opts: BackfillOptions): Promise<number> {
  const repos = await listAllRepos(opts.repoProvider)
  let processed = 0

  for (const repo of repos) {
    try {
      await backfillRepo(opts, repo.did)
      processed++
      opts.onProgress?.(processed, repos.length)
    } catch (err) {
      opts.onError?.(
        new Error(`failed to backfill repo ${repo.did}`, { cause: err }),
      )
    }
  }

  return processed
}

async function backfillRepo(opts: BackfillOptions, did: string): Promise<void> {
  await backfillViaListRecords(opts, did)
}

async function backfillViaListRecords(
  opts: BackfillOptions,
  did: string,
): Promise<void> {
  let cursor: string | undefined

  do {
    const url = new URL(`/xrpc/com.atproto.repo.listRecords`, opts.repoProvider)
    url.searchParams.set('repo', did)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString())
    if (!res.ok) break

    const body = (await res.json()) as {
      records: Array<{
        uri: string
        cid: string
        value: Record<string, unknown>
      }>
      cursor?: string
    }

    for (const record of body.records) {
      const uri = new AtUri(record.uri)
      try {
        await opts.indexingService.indexRecord(
          uri,
          parseCid(record.cid),
          jsonToLex(record.value) as unknown,
          WriteOpAction.Create,
          new Date().toISOString(),
        )

        // Check for enrollment records
        if (uri.collection === ENROLLMENT_COLLECTION) {
          const serviceUrl =
            typeof record.value.service === 'string' ? record.value.service : ''
          const boundaries = extractBackfillBoundaries(record.value)
          if (serviceUrl) {
            opts.enrollmentCallback.onEnrollmentDiscovered(
              did,
              serviceUrl,
              boundaries,
            )
          }
        }
      } catch (err) {
        opts.onError?.(
          new Error(`failed to index record ${record.uri}`, { cause: err }),
        )
      }
    }

    cursor = body.cursor
  } while (cursor)
}

async function listAllRepos(
  repoProvider: string,
): Promise<Array<{ did: string }>> {
  const repos: Array<{ did: string }> = []
  let cursor: string | undefined

  do {
    const url = new URL(`/xrpc/com.atproto.sync.listRepos`, repoProvider)
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url.toString())
    if (!res.ok) break

    const body = (await res.json()) as {
      repos: Array<{ did: string; rev?: string }>
      cursor?: string
    }

    repos.push(...body.repos)
    cursor = body.cursor
  } while (cursor)

  return repos
}

function extractBackfillBoundaries(record: Record<string, unknown>): string[] {
  const boundary = record.boundary as
    | { values?: Array<{ value?: string }> }
    | undefined
  if (!boundary?.values || !Array.isArray(boundary.values)) return []
  return boundary.values
    .map((d) => d.value)
    .filter((v): v is string => typeof v === 'string')
}
