import {
  buildSpaceTypeRegistry,
  requireSpaceTypeCollections,
  type SpaceTypeRegistry,
} from '@northskysocial/stratos-core'
import feedDeclaration from '../../../lexicons-spaces/zone/stratos/space/feed.json' with { type: 'json' }

export const SPACE_TYPE_REGISTRY: SpaceTypeRegistry = buildSpaceTypeRegistry([
  feedDeclaration,
])

/** Space type NSID this service hosts. */
export const HOSTED_SPACE_TYPE = 'zone.stratos.space.feed'

export const HOSTED_SPACE_COLLECTIONS: readonly string[] =
  requireSpaceTypeCollections(SPACE_TYPE_REGISTRY, HOSTED_SPACE_TYPE)
