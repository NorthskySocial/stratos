import { formatSpaceUri } from '@northskysocial/stratos-core'

/**
 * Build a space URI `at://{did}/space/{type}/{skey}` for static test fixtures.
 * Unwraps {@link formatSpaceUri}; throws on invalid parts, since fixtures are
 * constant and a rejection means the test itself is wrong.
 */
export function makeSpaceUri(did: string, type: string, skey: string): string {
  const result = formatSpaceUri({ spaceDid: did, spaceType: type, skey })
  if (!result.ok) {
    throw new Error(`invalid space URI fixture: ${result.error.message}`)
  }
  return result.value
}
