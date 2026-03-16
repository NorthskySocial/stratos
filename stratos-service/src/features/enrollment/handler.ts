import {
  Server as XrpcServer,
  InvalidRequestError,
  AuthRequiredError,
} from '@atproto/xrpc-server'
import type { AppContext } from '../../context.js'

type HandlerAuth = {
  credentials: {
    type: string
    did?: string
  }
}

type HandlerInput = {
  body?: unknown
}

type HandlerParams = Record<string, unknown>

type HandlerContext = {
  input?: HandlerInput
  params: HandlerParams
  auth?: HandlerAuth
}

type HandlerResponse = {
  encoding: string
  body: unknown
}

type HandlerFn = (ctx: HandlerContext) => Promise<HandlerResponse>

// Type for accessing internal method - needed until lexicons are properly loaded
type XrpcServerInternal = XrpcServer & {
  method(
    nsid: string,
    config: {
      auth?: (
        ctx: import('@atproto/xrpc-server').MethodAuthContext,
      ) => Promise<unknown>
      handler: HandlerFn
    },
  ): void
}

/**
 * Register enrollment-related XRPC handlers
 */
export function registerEnrollmentHandlers(
  server: XrpcServer,
  ctx: AppContext,
): void {
  const xrpc = server as unknown as XrpcServerInternal
  const { authVerifier } = ctx

  // zone.stratos.enrollment.status - Check enrollment status
  xrpc.method('zone.stratos.enrollment.status', {
    auth: authVerifier.optionalStandard,
    handler: async ({ params, auth }: HandlerContext) => {
      const start = Date.now()
      const did = params.did as string

      if (!did) {
        throw new InvalidRequestError(
          'did parameter required',
          'InvalidRequest',
        )
      }

      const typedAuth = auth as HandlerAuth | undefined
      const authenticatedDid = typedAuth?.credentials?.did

      ctx.logger?.debug(
        { method: 'enrollment.status', did, authenticated: !!authenticatedDid },
        'handling request',
      )

      const enrollment = await ctx.enrollmentService.getEnrollment(did)

      if (enrollment) {
        const body: {
          did: string
          enrolled: true
          enrolledAt: string
          active: boolean
          signingKey: string
          boundaries?: Array<{ value: string }>
          attestation?: { sig: Uint8Array; signingKey: string }
        } = {
          did,
          enrolled: true,
          enrolledAt: enrollment.enrolledAt.toISOString(),
          active: enrollment.active,
          signingKey: enrollment.signingKeyDid,
        }

        // Only include boundaries and attestation if authenticated
        if (authenticatedDid) {
          const boundaryValues = await ctx.boundaryResolver.getBoundaries(did)
          body.boundaries = boundaryValues.map((value: string) => ({
            value,
          }))

          if (boundaryValues.length > 0) {
            try {
              body.attestation = await ctx.createAttestation(
                did,
                boundaryValues,
                enrollment.signingKeyDid,
              )
            } catch (err) {
              ctx.logger?.warn(
                {
                  err: err instanceof Error ? err.message : String(err),
                  did,
                },
                'failed to generate attestation for status',
              )
            }
          }
        }

        ctx.logger?.debug(
          {
            did,
            enrolled: true,
            authenticated: !!authenticatedDid,
            boundaryCount: body.boundaries?.length ?? 0,
            durationMs: Date.now() - start,
          },
          'enrollment status checked',
        )

        return {
          encoding: 'application/json',
          body,
        }
      } else {
        ctx.logger?.debug(
          {
            did,
            enrolled: false,
            durationMs: Date.now() - start,
          },
          'enrollment status checked',
        )

        return {
          encoding: 'application/json',
          body: {
            did,
            enrolled: false,
          },
        }
      }
    },
  })

  // zone.stratos.enrollment.unenroll - Unenroll from Stratos
  xrpc.method('zone.stratos.enrollment.unenroll', {
    auth: authVerifier.standard,
    handler: async ({ auth }: HandlerContext) => {
      const start = Date.now()
      const typedAuth = auth as HandlerAuth | undefined
      const did = typedAuth?.credentials?.did

      if (!did) {
        throw new AuthRequiredError('Authentication required')
      }

      ctx.logger?.info(
        { did, method: 'enrollment.unenroll' },
        'handling unenrollment request',
      )

      // 1. Delete enrollment record from user's PDS (best-effort)
      try {
        await ctx.profileRecordWriter.deleteEnrollmentRecord(did)
      } catch (err) {
        ctx.logger?.warn(
          { err: err instanceof Error ? err.message : String(err), did },
          'failed to delete PDS enrollment record during unenrollment',
        )
      }

      // 2. Mark enrollment as inactive in local storage
      await ctx.enrollmentService.unenroll(did)

      // 3. Revoke OAuth sessions
      try {
        await ctx.oauthClient.revoke(did)
      } catch (err) {
        ctx.logger?.warn(
          { err: err instanceof Error ? err.message : String(err), did },
          'failed to revoke OAuth session during unenrollment',
        )
      }

      ctx.logger?.info(
        { did, durationMs: Date.now() - start },
        'user unenrolled successfully',
      )

      return {
        encoding: 'application/json',
        body: { success: true },
      }
    },
  })
}
