export {
  registerSpaceCredentialHandlers,
  GET_SPACE_CREDENTIAL_METHOD,
} from './handler.js'
export {
  mintSpaceCredential,
  SPACE_CREDENTIAL_TYP,
  ATPROTO_KID,
  DEFAULT_SPACE_CREDENTIAL_TTL_SECONDS,
  type MintSpaceCredentialInput,
  type MintSpaceCredentialResult,
  type SpaceCredentialHeader,
  type SpaceCredentialPayload,
} from './minter.js'
