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
  return knownStratosCustody || !parseRecordUri(post.uri).ok
}
