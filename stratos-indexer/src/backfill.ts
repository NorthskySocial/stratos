import { WriteOpAction } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import type { IndexingService } from '@atproto/bsky/dist/data-plane/server/indexing/index.js'
import type { EnrollmentCallback } from './pds-firehose.ts'
import { jsonToLex, parseCid, extractBoundaries } from './record-decoder.ts'

const ENROLLMENT_COLLECTION = 'zone.stratos.actor.enrollment'

function toHttpUrl(endpoint: string): string {
  return endpoint
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
}

export interface BackfillOptions {
  repoProvider: string
  indexingService: IndexingService
  enrollmentCallback: EnrollmentCallback
  onError?: (err: Error) => void
  onProgress?: (processed: number) => void
}

export async function backfillRepos(opts: BackfillOptions): Promise<number> {
  let processed = 0

  for await (const page of listRepoPages(opts.repoProvider)) {
    for (const repo of page) {
      try {
        await backfillViaListRecords(opts, repo.did)
        processed++
        opts.onProgress?.(processed)
      } catch (err) {
        opts.onError?.(
          new Error(`failed to backfill repo ${repo.did}`, { cause: err }),
        )
      }
    }
  }

  return processed
}

export async function backfillActors(
  opts: BackfillOptions,
  dids: string[],
): Promise<number> {
  let processed = 0

  for (const did of dids) {
    try {
      await backfillViaListRecords(opts, did)
      processed++
      opts.onProgress?.(processed)
    } catch (err) {
      opts.onError?.(
        new Error(`failed to backfill repo ${did}`, { cause: err }),
      )
    }
  }

  return processed
}

export async function backfillSingleActor(
  opts: BackfillOptions,
  did: string,
): Promise<void> {
  await backfillViaListRecords(opts, did)
}

async function backfillViaListRecords(
  opts: BackfillOptions,
  did: string,
): Promise<void> {
  let cursor: string | undefined

  do {
    const url = new URL(
      `/xrpc/com.atproto.repo.listRecords`,
      toHttpUrl(opts.repoProvider),
    )
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

        if (uri.collection === ENROLLMENT_COLLECTION) {
          const serviceUrl =
            typeof record.value.service === 'string'
              ? record.value.service
              : ''
          const boundaries = extractBoundaries(record.value)
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
