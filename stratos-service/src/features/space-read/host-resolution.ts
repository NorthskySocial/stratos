import { IdResolver } from '@atproto/identity'
import type {
  DidPdsReader,
  HostOverrideReader,
  RepoHostResolverDeps,
} from '@northskysocial/stratos-core'

/**
 * Reports a member's own `repoHost` (from their enrollment row) as Stratos's
 * authority-recorded override. `repoHost` is written on enrolment and kept
 * current on a PDS move, so it is already the answer to "does Stratos know a
 * host for this member that overrides their DID document" -- no separate
 * override table is needed.
 */
export class EnrollmentHostOverrideReader implements HostOverrideReader {
  constructor(private readonly repoHost: string | undefined) {}

  async get(): Promise<string | undefined> {
    return this.repoHost
  }
}

/**
 * Resolves a member's `#atproto_pds` service endpoint from their DID
 * document. Mirrors `PdsTokenVerifier.getPdsEndpointFromDid`
 * (`infra/auth/introspection-client.ts`); duplicated rather than shared
 * because that reader is scoped to OAuth issuer verification, a different
 * concern that happens to resolve the same field.
 */
export class DidDocumentPdsReader implements DidPdsReader {
  constructor(private readonly idResolver: IdResolver) {}

  async getPdsEndpoint(memberDid: string): Promise<string | undefined> {
    try {
      const didDoc = await this.idResolver.did.resolve(memberDid)
      if (!didDoc) return undefined

      for (const service of didDoc.service ?? []) {
        const isPdsService =
          service.id === '#atproto_pds' ||
          service.id === `${memberDid}#atproto_pds`
        if (isPdsService && typeof service.serviceEndpoint === 'string') {
          return service.serviceEndpoint
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Builds the {@link RepoHostResolverDeps} `resolveRepoHost` needs for one
 * member. `repoHost` comes from that member's own enrollment row.
 */
export function createRepoHostResolverDeps(
  idResolver: IdResolver,
  repoHost: string | undefined,
): RepoHostResolverDeps {
  return {
    overrides: new EnrollmentHostOverrideReader(repoHost),
    dids: new DidDocumentPdsReader(idResolver),
  }
}
