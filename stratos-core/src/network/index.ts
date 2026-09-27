// Server-only exports: keep socket policy out of browser entry points.
export {
  createPublicFetch,
  isPublicAddress,
  publicFetch,
  type TrustedOriginPolicy,
} from './public-fetch.js'
export { createPublicIdResolver, didWebDocumentUrl } from './identity.js'
