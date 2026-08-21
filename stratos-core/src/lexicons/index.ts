import type { LexiconDoc } from '@atproto/lexicon'
import { atprotoLexicons } from './atproto.js'
import zoneStratosActorEnrollment from '../../../lexicons/zone/stratos/actor/enrollment.json' with { type: 'json' }
import zoneStratosAdminListEnrollments from '../../../lexicons/zone/stratos/admin/listEnrollments.json' with { type: 'json' }
import zoneStratosAdminAddAdmin from '../../../lexicons/zone/stratos/admin/addAdmin.json' with { type: 'json' }
import zoneStratosAdminListAdmins from '../../../lexicons/zone/stratos/admin/listAdmins.json' with { type: 'json' }
import zoneStratosAdminRemoveAdmin from '../../../lexicons/zone/stratos/admin/removeAdmin.json' with { type: 'json' }
import zoneStratosAdminSetActive from '../../../lexicons/zone/stratos/admin/setActive.json' with { type: 'json' }
import zoneStratosEmbedImages from '../../../lexicons/zone/stratos/embed/images.json' with { type: 'json' }
import zoneStratosBoundaryDefs from '../../../lexicons/zone/stratos/boundary/defs.json' with { type: 'json' }
import zoneStratosDefs from '../../../lexicons/zone/stratos/defs.json' with { type: 'json' }
import zoneStratosEnrollmentStatus from '../../../lexicons/zone/stratos/enrollment/status.json' with { type: 'json' }
import zoneStratosEnrollmentUnenroll from '../../../lexicons/zone/stratos/enrollment/unenroll.json' with { type: 'json' }
import zoneStratosFeedPost from '../../../lexicons/zone/stratos/feed/post.json' with { type: 'json' }
import zoneStratosFeedGetTimeline from '../../../lexicons/zone/stratos/feed/getTimeline.json' with { type: 'json' }
import zoneStratosFeedgenDescribeFeed from '../../../lexicons/zone/stratos/feedgen/describeFeed.json' with { type: 'json' }
import zoneStratosFeedgenGetFeed from '../../../lexicons/zone/stratos/feedgen/getFeed.json' with { type: 'json' }
import zoneStratosIdentityResolveEnrollments from '../../../lexicons/zone/stratos/identity/resolveEnrollments.json' with { type: 'json' }
import zoneStratosRepoHydrateRecord from '../../../lexicons/zone/stratos/repo/hydrateRecord.json' with { type: 'json' }
import zoneStratosRepoHydrateRecords from '../../../lexicons/zone/stratos/repo/hydrateRecords.json' with { type: 'json' }
import zoneStratosRepoImportRepo from '../../../lexicons/zone/stratos/repo/importRepo.json' with { type: 'json' }
import zoneStratosRepoUploadBlob from '../../../lexicons/zone/stratos/sync/uploadBlob.json' with { type: 'json' }
import zoneStratosServerListDomains from '../../../lexicons/zone/stratos/server/listDomains.json' with { type: 'json' }
import zoneStratosSpaceGetRecord from '../../../lexicons/zone/stratos/space/getRecord.json' with { type: 'json' }
import zoneStratosSpaceGetSpaceCredential from '../../../lexicons/zone/stratos/space/getSpaceCredential.json' with { type: 'json' }
import zoneStratosSpaceListBlobs from '../../../lexicons/zone/stratos/space/listBlobs.json' with { type: 'json' }
import zoneStratosSyncGetBlob from '../../../lexicons/zone/stratos/sync/getBlob.json' with { type: 'json' }
import zoneStratosSyncGetRepo from '../../../lexicons/zone/stratos/sync/getRepo.json' with { type: 'json' }
import zoneStratosSyncListRecordPaths from '../../../lexicons/zone/stratos/sync/listRecordPaths.json' with { type: 'json' }
import zoneStratosSyncListRepoOps from '../../../lexicons/zone/stratos/sync/listRepoOps.json' with { type: 'json' }
import zoneStratosSyncSubscribeRecords from '../../../lexicons/zone/stratos/sync/subscribeRecords.json' with { type: 'json' }

export const stratosLexicons: LexiconDoc[] = [
  ...atprotoLexicons,
  zoneStratosActorEnrollment as LexiconDoc,
  zoneStratosAdminListEnrollments as LexiconDoc,
  zoneStratosAdminAddAdmin as LexiconDoc,
  zoneStratosAdminListAdmins as LexiconDoc,
  zoneStratosAdminRemoveAdmin as LexiconDoc,
  zoneStratosAdminSetActive as LexiconDoc,
  zoneStratosEmbedImages as LexiconDoc,
  zoneStratosBoundaryDefs as LexiconDoc,
  zoneStratosDefs as LexiconDoc,
  zoneStratosEnrollmentStatus as LexiconDoc,
  zoneStratosEnrollmentUnenroll as LexiconDoc,
  zoneStratosFeedPost as LexiconDoc,
  zoneStratosFeedGetTimeline as LexiconDoc,
  zoneStratosFeedgenDescribeFeed as LexiconDoc,
  zoneStratosFeedgenGetFeed as LexiconDoc,
  zoneStratosIdentityResolveEnrollments as LexiconDoc,
  zoneStratosRepoHydrateRecord as LexiconDoc,
  zoneStratosRepoHydrateRecords as LexiconDoc,
  zoneStratosRepoImportRepo as LexiconDoc,
  zoneStratosRepoUploadBlob as LexiconDoc,
  zoneStratosServerListDomains as LexiconDoc,
  zoneStratosSpaceGetRecord as LexiconDoc,
  zoneStratosSpaceGetSpaceCredential as LexiconDoc,
  zoneStratosSpaceListBlobs as LexiconDoc,
  zoneStratosSyncGetBlob as LexiconDoc,
  zoneStratosSyncGetRepo as LexiconDoc,
  zoneStratosSyncListRecordPaths as LexiconDoc,
  zoneStratosSyncListRepoOps as LexiconDoc,
  zoneStratosSyncSubscribeRecords as LexiconDoc,
]

export interface LexiconProvider {
  getAll: () => LexiconDoc[]
  get: (id: string) => LexiconDoc | undefined
}

/**
 * Default lexicon provider that combines Stratos lexicons with custom lexicons.
 */
export class DefaultLexiconProvider implements LexiconProvider {
  private lexicons: Map<string, LexiconDoc>

  constructor(customLexicons: LexiconDoc[] = []) {
    this.lexicons = new Map()
    for (const doc of [...stratosLexicons, ...customLexicons]) {
      this.lexicons.set(doc.id, doc)
    }
  }

  /**
   * Get all lexicons.
   * @returns Array of lexicon documents.
   */
  getAll(): LexiconDoc[] {
    return Array.from(this.lexicons.values())
  }

  /**
   * Get a specific lexicon by ID.
   * @param id
   * @returns Lexicon document or undefined if not found.
   */
  get(id: string): LexiconDoc | undefined {
    return this.lexicons.get(id)
  }
}
