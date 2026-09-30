import http from 'node:http'

export function createProxyServer(upstreamFetch = fetch) {
  let mode = 'observe'
  const blockedCursors = new Map()
  let pages = 0
  let interruptions = 0
  let firstRequests = 0
  let commitRequests = 0
  let commitFailures = 0
  let lastCommitStatus
  const repos = new Set()
  const globalRepos = new Set()
  const passes = new Map()
  const cid = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://proxy')
    if (url.pathname === '/_control/mode') {
      mode = url.searchParams.get('value')
      blockedCursors.clear()
      passes.clear()
      res.end('ok')
      return
    }
    if (url.pathname === '/_control/status') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          pages,
          interruptions,
          firstRequests,
          commitRequests,
          commitFailures,
          lastCommitStatus,
          targetCount: repos.size,
          globalTargetCount: globalRepos.size,
        }),
      )
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
      const pass = passes.get(repo) || 0
      passes.set(repo, pass + 1)
      if (['replacement', 'delete', 'rollback'].includes(mode)) {
        const terminal = pass % 2 === 1
        const rkey =
          mode === 'replacement'
            ? 'replacement'
            : mode === 'delete'
              ? 'deleted'
              : 'rolled-back'
        const record = {
          rev: 'synthetic',
          collection: 'zone.stratos.feed.post',
          rkey,
          cid,
          value: {
            $type: 'zone.stratos.feed.post',
            text:
              mode === 'replacement' && terminal
                ? 'staged replacement'
                : `${mode} staged record`,
            createdAt: new Date().toISOString(),
          },
        }
        const ops =
          mode === 'delete' && terminal
            ? [{ rev: 'synthetic', collection: record.collection, rkey }]
            : mode === 'rollback' && terminal
              ? Array.from({ length: 10 }, (_, n) => ({
                  ...record,
                  rkey: `${rkey}-${n}`,
                }))
              : [record]
        let commit
        if (terminal && mode !== 'rollback') {
          try {
            const query = new URL(req.url, 'http://proxy')
            query.pathname = '/xrpc/com.atproto.space.listRepoOps'
            query.searchParams.delete('cursor')
            query.searchParams.delete('since')
            query.searchParams.delete('excludeValues')
            query.searchParams.set('limit', '1000')
            const headers = { ...req.headers }
            delete headers.connection
            const upstream = await upstreamFetch(
              `http://feedgen-e2e-pds-spaces:3000${query.pathname}${query.search}`,
              { headers },
            )
            commitRequests += 1
            lastCommitStatus = upstream.status
            if (!upstream.ok) throw new Error('Upstream PDS request failed')
            commit = (await upstream.json()).commit
            if (!commit)
              throw new Error('Upstream PDS returned no terminal commit')
          } catch (error) {
            commitFailures += 1
            console.error(
              `event=staging_limits_proxy_commit_failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
            )
            res.writeHead(502)
            res.end()
            return
          }
        }
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ops,
            cursor: terminal ? undefined : `${mode}-${index + 1}`,
            commit,
          }),
        )
        return
      }
      const next = mode + '-' + (index + 1)
      blockedCursors.set(repo, next)
      const count = mode === 'interrupted' ? 1 : 10
      const ops = Array.from({ length: count }, (_, n) => ({
        rev: 'synthetic',
        collection: 'zone.stratos.feed.post',
        rkey: 'stage-' + index + '-' + n,
        cid,
        value: {
          $type: 'zone.stratos.feed.post',
          text: 'x'.repeat(1200),
          createdAt: new Date().toISOString(),
        },
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
      const upstream = await upstreamFetch(
        'http://feedgen-e2e-pds-spaces:3000' + req.url,
        {
          method: req.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        },
      )
      const body = Buffer.from(await upstream.arrayBuffer())
      const responseHeaders = Object.fromEntries(upstream.headers)
      delete responseHeaders['content-length']
      delete responseHeaders['content-encoding']
      delete responseHeaders['transfer-encoding']
      res.writeHead(upstream.status, responseHeaders)
      res.end(body)
    } catch (error) {
      console.error(
        `event=staging_limits_proxy_upstream_failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
      )
      res.writeHead(502)
      res.end()
    }
  })
}
