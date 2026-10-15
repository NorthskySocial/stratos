import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(
  new URL('../../../webapp/package.json', import.meta.url),
)
const { chromium } = require('@playwright/test')
const { createServer } = require('vite')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  appType: 'custom',
  optimizeDeps: {
    noDiscovery: true,
  },
})
server.middlewares.use((req, res, next) => {
  if (req.url !== '/') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end('<!doctype html><title>Request proof foundation</title>')
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(server.resolvedUrls.local[0])
  const result = await page.evaluate(async () => {
    const { vectorKey, vectorContext, vectorProof } =
      await import('/stratos-client/tests/request-proof-vector.ts')
    const { createRequestProof, verifyRequestProof } =
      await import('/stratos-client/src/request-proof.ts')
    const { createServiceAssertion, verifyServiceAssertion } =
      await import('/stratos-client/src/service-assertion.ts')
    const fixed = await verifyRequestProof(vectorProof, vectorContext)
    const fresh = await createRequestProof({
      ...vectorContext,
      signingKey: vectorKey,
    })
    const context = {
      proof: fresh,
      request: vectorContext,
      issuer: 'did:web:rei.nerv.jp',
      lxm: 'zone.stratos.space.getRecord',
    }
    const assertion = await createServiceAssertion({
      ...context,
      kid: `${context.issuer}#atproto`,
      signingKey: vectorKey,
    })
    const service = await verifyServiceAssertion(assertion, context, {
      resolve: async () => vectorKey,
    })
    let tamperRejected = false
    try {
      await verifyRequestProof(vectorProof, {
        ...vectorContext,
        target: vectorContext.target.replace('%2F', '%2f'),
      })
    } catch {
      tamperRejected = true
    }
    return {
      browser: navigator.userAgent,
      nodeGlobals:
        typeof globalThis.Buffer !== 'undefined' ||
        typeof globalThis.process !== 'undefined',
      jti: fixed.claims.jti,
      ath: fixed.claims.ath,
      body: fixed.claims.body_hash,
      issuer: service.issuer,
      tamperRejected,
    }
  })
  assert.equal(result.nodeGlobals, false)
  assert.equal(result.jti, 'AAECAwQFBgcICQoLDA0ODw')
  assert.equal(result.ath, 'oQYm0Eu-wU2_AySCMoEMlSZN9uc0MaGrWMAtvWqyamQ')
  assert.equal(result.body, '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
  assert.equal(result.issuer, 'did:web:rei.nerv.jp')
  assert.equal(result.tamperRejected, true)
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  await server.close()
}
