import type { OAuthSession } from '@atproto/oauth-client-browser'

/** Resolve a handle from the authenticated PDS rather than accepting user input as identity. */
export async function resolveAuthenticatedHandle(
  session: OAuthSession,
): Promise<string> {
  const parameters = new URLSearchParams({ repo: session.sub })
  const response = await session.fetchHandler(
    `/xrpc/com.atproto.repo.describeRepo?${parameters.toString()}`,
    { method: 'GET' },
  )
  if (!response.ok)
    throw new Error('Your PDS could not confirm the signed-in handle')
  const payload: unknown = await response.json()
  const handle =
    typeof payload === 'object' && payload !== null
      ? (payload as { handle?: unknown }).handle
      : undefined
  if (typeof handle !== 'string' || !handle) {
    throw new Error(
      'Your PDS did not return a handle for the signed-in account',
    )
  }
  return handle
}
