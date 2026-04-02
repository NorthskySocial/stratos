import type { LexiconDoc } from '@atproto/lexicon'
import zoneStratosActorEnrollment from '../../../lexicons/zone/stratos/actor/enrollment.json' with { type: 'json' }
import zoneStratosBoundaryDefs from '../../../lexicons/zone/stratos/boundary/defs.json' with { type: 'json' }
import zoneStratosDefs from '../../../lexicons/zone/stratos/defs.json' with { type: 'json' }
import zoneStratosEnrollmentStatus from '../../../lexicons/zone/stratos/enrollment/status.json' with { type: 'json' }
import zoneStratosEnrollmentUnenroll from '../../../lexicons/zone/stratos/enrollment/unenroll.json' with { type: 'json' }
import zoneStratosFeedPost from '../../../lexicons/zone/stratos/feed/post.json' with { type: 'json' }
import zoneStratosIdentityResolveEnrollments from '../../../lexicons/zone/stratos/identity/resolveEnrollments.json' with { type: 'json' }
import zoneStratosRepoHydrateRecord from '../../../lexicons/zone/stratos/repo/hydrateRecord.json' with { type: 'json' }
import zoneStratosRepoHydrateRecords from '../../../lexicons/zone/stratos/repo/hydrateRecords.json' with { type: 'json' }
import zoneStratosRepoImportRepo from '../../../lexicons/zone/stratos/repo/importRepo.json' with { type: 'json' }
import zoneStratosServerListDomains from '../../../lexicons/zone/stratos/server/listDomains.json' with { type: 'json' }
import zoneStratosSyncGetRepo from '../../../lexicons/zone/stratos/sync/getRepo.json' with { type: 'json' }
import zoneStratosSyncSubscribeRecords from '../../../lexicons/zone/stratos/sync/subscribeRecords.json' with { type: 'json' }

export const stratosLexicons: LexiconDoc[] = [
  zoneStratosActorEnrollment as LexiconDoc,
  zoneStratosBoundaryDefs as LexiconDoc,
  zoneStratosDefs as LexiconDoc,
  zoneStratosEnrollmentStatus as LexiconDoc,
  zoneStratosEnrollmentUnenroll as LexiconDoc,
  zoneStratosFeedPost as LexiconDoc,
  zoneStratosIdentityResolveEnrollments as LexiconDoc,
  zoneStratosRepoHydrateRecord as LexiconDoc,
  zoneStratosRepoHydrateRecords as LexiconDoc,
  zoneStratosRepoImportRepo as LexiconDoc,
  zoneStratosServerListDomains as LexiconDoc,
  zoneStratosSyncGetRepo as LexiconDoc,
  zoneStratosSyncSubscribeRecords as LexiconDoc,
]

export interface LexiconProvider {
  getAll(): LexiconDoc[]
  get(id: string): LexiconDoc | undefined
}

export class DefaultLexiconProvider implements LexiconProvider {
  private lexicons: Map<string, LexiconDoc>

  constructor(customLexicons: LexiconDoc[] = []) {
    this.lexicons = new Map()
    for (const doc of [...stratosLexicons, ...customLexicons]) {
      this.lexicons.set(doc.id, doc)
    }
  }

  getAll(): LexiconDoc[] {
    return Array.from(this.lexicons.values())
  }

  get(id: string): LexiconDoc | undefined {
    return this.lexicons.get(id)
  }
}
