import concurrently from 'concurrently'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const webappPort = 5173

const args = process.argv.slice(2)
const isDebugService = args.includes('--debug-service')

const envPath = path.join(rootDir, '.env')
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
}

interface CloudflareTunnel {
  process: ChildProcess
  url: string
  exit: Promise<never>
}

interface FeedgenKey {
  didKey: string
  signingKey: string
}

function localPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function didWebForUrl(url: string): string {
  return `did:web:${encodeURIComponent(new URL(url).host)}`
}

async function waitForOk(url: string, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // Retry until the timeout expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return false
}

function startCloudflareTunnel(
  name: string,
  targetUrl: string,
): Promise<CloudflareTunnel> {
  return new Promise((resolve, reject) => {
    const tunnel = spawn(
      'cloudflared',
      ['tunnel', '--no-autoupdate', '--url', targetUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let opened = false
    let rejectTunnelExit!: (error: Error) => void
    const exit = new Promise<never>((_resolve, rejectExit) => {
      rejectTunnelExit = rejectExit
    })
    void exit.catch(() => {})
    const timeout = setTimeout(() => {
      tunnel.kill()
      reject(new Error(`${name} tunnel did not report a URL in 30 seconds`))
    }, 30000)

    let tunnelOutput = ''
    const captureUrl = (chunk: Buffer) => {
      if (opened) return
      tunnelOutput = `${tunnelOutput}${chunk.toString()}`.slice(-256)
      const match = tunnelOutput.match(
        /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      )
      if (!match) return

      opened = true
      clearTimeout(timeout)
      resolve({ process: tunnel, url: match[0], exit })
    }

    tunnel.stdout.on('data', captureUrl)
    tunnel.stderr.on('data', captureUrl)
    tunnel.once('error', (error) => {
      clearTimeout(timeout)
      reject(new Error(`Could not start the ${name} tunnel: ${error.message}`))
    })
    tunnel.once('exit', (code) => {
      clearTimeout(timeout)
      if (opened) {
        const error = new Error(`${name} tunnel exited with code ${code}`)
        console.error(error.message)
        rejectTunnelExit(error)
      } else {
        reject(new Error(`${name} tunnel exited before reporting a URL`))
      }
    })
  })
}

function generateFeedgenKey(): Promise<FeedgenKey> {
  return new Promise((resolve, reject) => {
    const generator = spawn('node', ['stratos-feedgen/local/gen-key.mjs'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''

    generator.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    generator.once('error', () => {
      reject(new Error('Could not start the feedgen key generator'))
    })
    generator.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error('The feedgen key generator failed'))
        return
      }

      try {
        const value: unknown = JSON.parse(output)
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as { didKey?: unknown }).didKey !== 'string' ||
          typeof (value as { privHex?: unknown }).privHex !== 'string'
        ) {
          throw new Error('The key generator returned an invalid result')
        }
        const key = value as { didKey: string; privHex: string }
        resolve({ didKey: key.didKey, signingKey: key.privHex })
      } catch {
        reject(new Error('The key generator returned an invalid result'))
      }
    })
  })
}

function updateClientMetadata(webappUrl: string, serviceDid: string): void {
  const publicDir = path.join(rootDir, 'webapp', 'public')
  const clientMetadataPath = path.join(publicDir, 'client-metadata.json')
  const templatePath = path.join(publicDir, 'client-metadata.json.template')

  if (!fs.existsSync(templatePath) && fs.existsSync(clientMetadataPath)) {
    fs.copyFileSync(clientMetadataPath, templatePath)
  }

  if (!fs.existsSync(templatePath)) return

  const content = fs
    .readFileSync(templatePath, 'utf8')
    .replace(/VITE_WEBAPP_URL/g, webappUrl)
    .replace(
      /VITE_STRATOS_SERVICE_DID_ENCODED/g,
      encodeURIComponent(serviceDid),
    )
  fs.writeFileSync(clientMetadataPath, content)
}

function stopTunnels(tunnels: ChildProcess[]): void {
  tunnels.forEach((tunnel) => {
    if (!tunnel.killed) tunnel.kill()
  })
}

async function start(): Promise<void> {
  const tunnels: ChildProcess[] = []

  try {
    const servicePort = localPort('STRATOS_PORT', 3100)
    const feedgenPort = localPort('FEEDGEN_PORT', 3302)
    const serviceLocalUrl = `http://127.0.0.1:${servicePort}`

    console.log('Starting Cloudflare tunnels...')
    const serviceTunnel = await startCloudflareTunnel(
      'Stratos',
      serviceLocalUrl,
    )
    tunnels.push(serviceTunnel.process)
    const feedgenTunnel = await startCloudflareTunnel(
      'Feedgen',
      `http://127.0.0.1:${feedgenPort}`,
    )
    tunnels.push(feedgenTunnel.process)
    const webappTunnel = await startCloudflareTunnel(
      'Webapp',
      `http://127.0.0.1:${webappPort}`,
    )
    tunnels.push(webappTunnel.process)

    const serviceUrl = serviceTunnel.url
    const feedgenUrl = feedgenTunnel.url
    const webappUrl = webappTunnel.url
    const serviceDid = didWebForUrl(serviceUrl)
    const feedgenDid = didWebForUrl(feedgenUrl)
    const feedgenKey = await generateFeedgenKey()

    updateClientMetadata(webappUrl, serviceDid)
    fs.mkdirSync(path.join(rootDir, 'data'), { recursive: true })

    const env = {
      ...process.env,
      STRATOS_PORT: String(servicePort),
      STRATOS_PUBLIC_URL: serviceUrl,
      STRATOS_REPO_URL: webappUrl,
      STRATOS_SERVICE_DID: serviceDid,
      STRATOS_ENROLLMENT_MODE: 'open',
      STRATOS_AUTO_ENROLL_DOMAINS: 'swordsmith',
      FEEDGEN_PORT: String(feedgenPort),
      FEEDGEN_SERVICE_DID: feedgenDid,
      FEEDGEN_PUBLIC_URL: feedgenUrl,
      FEEDGEN_SIGNING_KEY: feedgenKey.signingKey,
      FEEDGEN_STORAGE_BACKEND: 'sqlite',
      FEEDGEN_SQLITE_PATH: path.join(rootDir, 'data', 'feedgen.sqlite'),
      FEEDGEN_FEEDS_FILE: '',
      FEEDGEN_FEEDS_JSON: JSON.stringify({
        feeds: [
          {
            id: 'swordsmith',
            boundary: `${serviceDid}/swordsmith`,
            displayName: 'Swordsmith',
            description: 'Local feedgen test feed',
          },
        ],
      }),
      FEEDGEN_SUBSCRIBE_ENROLLMENTS: 'true',
      STRATOS_SERVICE_URL: serviceLocalUrl,
      STRATOS_SERVICE_ENROLLMENTS: JSON.stringify([
        {
          boundaries: ['swordsmith'],
          did: feedgenDid,
          signingKey: feedgenKey.didKey,
        },
      ]),
      VITE_STRATOS_URL: serviceUrl,
      VITE_STRATOS_SERVICE_DID: serviceDid,
      VITE_FEEDGEN_DID: feedgenDid,
      VITE_FEEDGEN_FEED: 'swordsmith',
      VITE_WEBAPP_URL: webappUrl,
      VITE_APPVIEW_URL: process.env.VITE_APPVIEW_URL || 'https://api.bsky.app',
      VITE_ATPROTO_HANDLE_RESOLVER:
        process.env.VITE_ATPROTO_HANDLE_RESOLVER || 'https://bsky.social',
    }

    const serviceCommand = isDebugService
      ? 'tsx watch --inspect=0.0.0.0:9229 src/index.ts'
      : 'pnpm --filter @northskysocial/stratos-service run dev'

    const { commands, result } = concurrently(
      [
        {
          command: serviceCommand,
          name: 'service',
          cwd: path.join(rootDir, 'stratos-service'),
          env,
        },
        {
          command: 'tsx src/bin/main.ts',
          name: 'feedgen',
          cwd: path.join(rootDir, 'stratos-feedgen'),
          env,
        },
        {
          command: 'pnpm --filter @northskysocial/stratos-webapp run dev',
          name: 'webapp',
          cwd: path.join(rootDir, 'webapp'),
          env,
        },
      ],
      {
        killOthersOn: ['failure', 'success'],
        prefix: 'name',
        cwd: rootDir,
        raw: false,
      },
    )

    const tunnelResult = Promise.race([
      serviceTunnel.exit,
      feedgenTunnel.exit,
      webappTunnel.exit,
    ]).then(
      () => 1,
      () => 1,
    )
    const stackResult = Promise.race([
      result.then(
        () => 0,
        () => 1,
      ),
      tunnelResult,
    ])
    let checkInterval: ReturnType<typeof setInterval> | undefined
    const cleanup = (exitCode: number) => {
      if (checkInterval) clearInterval(checkInterval)
      stopTunnels(tunnels)
      commands.forEach((command) => command.kill())
      process.exit(exitCode)
    }

    process.on('SIGINT', () => cleanup(0))
    process.on('SIGTERM', () => cleanup(0))

    const startup = await Promise.race([
      Promise.all([
        waitForOk(`${serviceLocalUrl}/ready`),
        waitForOk(`http://127.0.0.1:${feedgenPort}/health`),
        waitForOk(`http://127.0.0.1:${webappPort}/`),
      ]).then(([serviceReady, feedgenReady, webappReady]) => ({
        feedgenReady,
        serviceReady,
        webappReady,
      })),
      stackResult.then(() => null),
    ])

    if (
      !startup ||
      !startup.serviceReady ||
      !startup.feedgenReady ||
      !startup.webappReady
    ) {
      cleanup(1)
      return
    }

    console.log(`Webapp:  ${webappUrl}`)
    console.log(`Stratos: ${serviceUrl} (${serviceDid})`)
    console.log(`Feedgen: ${feedgenUrl} (${feedgenDid})`)

    checkInterval = setInterval(() => {
      void Promise.all([
        fetch(serviceUrl).catch(() => null),
        fetch(feedgenUrl).catch(() => null),
        fetch(webappUrl).catch(() => null),
      ])
    }, 60000)

    cleanup(await stackResult)
  } catch (error) {
    stopTunnels(tunnels)
    console.error('Failed to start the local stack:', error)
    process.exit(1)
  }
}

void start()
