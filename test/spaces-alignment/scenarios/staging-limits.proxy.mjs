import http from 'node:http'

export function createProxyServer() {
  let mode = 'observe'
  const blockedCursors = new Map()
  let pages = 0
  let interruptions = 0
  let firstRequests = 0
  const repos = new Set()
  const globalRepos = new Set()
  const cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://proxy')
    if (url.pathname === '/_control/mode') {
      mode = url.searchParams.get('value')
      blockedCursors.clear()
      res.end('ok')
      return
    }
    if (url.pathname === '/_control/status') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ pages, interruptions, firstRequests,
        targetCount: repos.size, globalTargetCount: globalRepos.size }))
      return
    }
    const isPage = url.pathname === '/xrpc/com.atproto.space.listRepoOps'
    const repo = url.searchParams.get('repo')
    if (isPage) {
      repos.add(repo)
      if (mode === 'global') globalRepos.add(repo)
      if (!url.searchParams.has('cursor')) firstRequests += 1
    }
    if (isPage && mode !== 'observe') {
      const cursor = url.searchParams.get('cursor')
      if (blockedCursors.get(repo) === cursor) {
        blockedCursors.delete(repo)
        interruptions += 1
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{"error":"Unavailable"}')
        return
      }
      const index = pages++
      const next = mode + '-' + (index + 1)
      blockedCursors.set(repo, next)
      const count = mode === 'interrupted' ? 1 : 10
      const ops = Array.from({ length: count }, (_, n) => ({
        rev: 'synthetic', collection: 'zone.stratos.feed.post',
        rkey: 'stage-' + index + '-' + n, cid,
        value: { $type: 'zone.stratos.feed.post', text: 'x'.repeat(1200),
          createdAt: new Date().toISOString() },
      }))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ops, cursor: next }))
      return
    }
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const headers = { ...req.headers }
      delete headers.connection
      const upstream = await fetch('http://feedgen-e2e-pds-spaces:3000' + req.url, {
        method: req.method, headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      })
      const body = Buffer.from(await upstream.arrayBuffer())
      const responseHeaders = Object.fromEntries(upstream.headers)
      delete responseHeaders['content-length']
      delete responseHeaders['content-encoding']
      delete responseHeaders['transfer-encoding']
      res.writeHead(upstream.status, responseHeaders)
      res.end(body)
    } catch {
      res.writeHead(502)
      res.end()
    }
  })
}
