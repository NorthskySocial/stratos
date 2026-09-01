export { createDpopProof, generateDpopKeyPair } from './dpop.js'
export type { CreateDpopProofOptions, DpopJwk, DpopKeyPair } from './dpop.js'
export {
  DELEGATION_TOKEN_LIFETIME_SECONDS,
  mintDelegationToken,
} from './delegation.js'
export type { MintDelegationTokenInput } from './delegation.js'
export {
  DEFAULT_REFRESH_MARGIN_MS,
  SpaceCredentialManager,
  STRATOS_FEED_SPACE_TYPE,
} from './manager.js'
export type {
  HeldSpaceCredential,
  SpaceCredentialManagerOptions,
} from './manager.js'
