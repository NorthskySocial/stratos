// Pages that moved keep their old URLs working. GitHub Pages serves 404.html
// for an unknown path, the app boots there, and the router hook below sends
// the reader to the new page before anything renders.
export const REDIRECTS: Record<string, string> = {
  '/guide/glossary': '/reference/glossary',
  '/guide/errors': '/reference/errors',
  '/client/api-reference': '/reference/api',
  '/indexer-architecture': '/architecture/appview-indexer',
  '/architecture/october-writer-sync-contract':
    '/history/october-writer-sync-contract',
  '/architecture/credential-revocation-contract':
    '/history/credential-revocation-contract',
  '/operator/upgrades/october-spaces': '/history/october-spaces',
}

export function findRedirect(href: string): string | undefined {
  const url = new URL(href, 'http://localhost')
  const path = url.pathname.replace(/\.html$/, '').replace(/\/$/, '')
  const target = REDIRECTS[path]
  return target === undefined ? undefined : target + url.hash
}
