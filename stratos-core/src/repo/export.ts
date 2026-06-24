import * as CAR from '@atcute/car'
import type { CidLink } from '@atcute/cid'
import type { Cid } from '@atproto/lex-data'
import { type CarBlock, StratosRepoRootNotFoundError } from './reader.js'

/**
 * Minimal repo source required to export a CAR file.
 */
export interface RepoCarSource {
  getRootDetailed: () => Promise<{ cid: Cid; rev: string } | null>
  iterateCarBlocks: (since?: string) => AsyncIterable<CarBlock>
}

/**
 * Stream a repository as a CAR (Content Addressable aRchive) file.
 *
 * The repo root commit is emitted as the CAR root, followed by every block
 * reachable in the repository. When `since` is provided, only blocks created
 * after that revision are streamed.
 *
 * @param source - Repo reader exposing the root commit and block iterator.
 * @param since - Optional revision to export blocks created after.
 * @returns Async iterable of CAR file chunks.
 * @throws StratosRepoRootNotFoundError when the repository has no root commit.
 */
export async function* exportRepoCarStream(
  source: RepoCarSource,
  since?: string,
): AsyncIterable<Uint8Array> {
  const root = await source.getRootDetailed()
  if (!root) {
    throw new StratosRepoRootNotFoundError()
  }

  const roots: CidLink[] = [{ $link: root.cid.toString() }]

  const blocks = async function* () {
    for await (const block of source.iterateCarBlocks(since)) {
      yield { cid: block.cid.bytes, data: block.bytes }
    }
  }

  yield* CAR.writeCarStream(roots, blocks())
}
