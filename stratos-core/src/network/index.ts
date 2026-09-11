// Server-only exports: keep socket policy out of browser entry points.
export {
  createPublicFetch,
  isPublicAddress,
  publicFetch,
} from './public-fetch.js'
export {
  createPublicIdResolver,
  didWebDocumentUrl,
  protectIdentityResolver,
} from './identity.js'
