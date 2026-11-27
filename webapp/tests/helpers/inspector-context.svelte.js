/**
 * The reactive object the app shares with the record inspector.
 * @param {import('@atproto/oauth-client-browser').OAuthSession | null} session
 * @param {string} serviceUrl
 * @returns {{ session: import('@atproto/oauth-client-browser').OAuthSession | null, serviceUrl: string }}
 */
export function createInspectorContext(session, serviceUrl) {
  const shared = $state({ session, serviceUrl })
  return shared
}
