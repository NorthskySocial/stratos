import { AtUri } from '@northskysocial/stratos-core'
import { parseRecordUri } from '@northskysocial/stratos-core/spaces'
import type { FeedgenStore, IndexedPost } from '../db/index.js'

export async function canServePostBlobs(
  store: Pick<FeedgenStore, 'listSpaceMembers'>,
  post: IndexedPost,
): Promise<boolean> {
  let knownStratosCustody = false
  for (const boundary of post.boundaries) {
    const members = await store.listSpaceMembers(boundary)
    const member = members.find((member) => member.did === post.did)
    if (member?.custody === 'pds') return false
    if (member?.custody === 'stratos') knownStratosCustody = true
  }
  return knownStratosCustody || isStratosRepositoryRecordUri(post.uri)
}

export function isStratosRepositoryRecordUri(uri: string): boolean {
  if (parseRecordUri(uri).ok || uri.includes('?') || uri.includes('#')) {
    return false
  }
  try {
    const parsed = new AtUri(uri)
    return (
      parsed.host.startsWith('did:') &&
      parsed.collection.length > 0 &&
      parsed.rkey.length > 0 &&
      uri.split('/').length === 5
    )
  } catch {
    return false
  }
}
