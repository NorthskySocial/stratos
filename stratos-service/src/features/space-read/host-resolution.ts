import { IdResolver } from '@atproto/identity'
import type {
  DidPdsReader,
  HostOverrideReader,
  RepoHostResolverDeps,
} from '@northskysocial/stratos-core'

/**
 * No Stratos storage records host overrides yet (the admin override table is
 * MM-08, not built). Every lookup reports "no override", which sends
 * `resolveRepoHost` straight to the DID-document arm -- the same outcome as
 * an override store that happens to hold nothing for this member.
 */
export class NoopHostOverrideReader implements HostOverrideReader {
  async get(): Promise<string | undefined> {
    return undefined
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

/** Builds the {@link RepoHostResolverDeps} `resolveRepoHost` needs. */
export function createRepoHostResolverDeps(
  idResolver: IdResolver,
): RepoHostResolverDeps {
  return {
    overrides: new NoopHostOverrideReader(),
    dids: new DidDocumentPdsReader(idResolver),
  }
}
