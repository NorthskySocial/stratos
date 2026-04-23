import ngrok from '@ngrok/ngrok'
import concurrently from 'concurrently'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

// Load .env from root if it exists
const envPath = path.join(rootDir, '.env')
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
}

/**
 * Check if a URL is responding with a 200 status code.
 *
 * @param url - URL to check
 * @param timeoutMs - Max time to wait for a response
 * @returns Promise that resolves to true if responding, false otherwise
 */
async function waitForOk(url: string, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      // Any response (even error status) means the server is up
      if (res.status !== 0) return true
    } catch {
      // Ignore errors and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function start() {
  console.log('Starting local development with ngrok...')

  try {
    // 1. Start ngrok for service
    const serviceListener = await ngrok.forward({
      addr: 3100,
      authtoken_from_env: true,
    })
    const serviceUrl = serviceListener.url()!
    console.log(`Service Tunnel URL: ${serviceUrl}`)

    // 2. Start ngrok for webapp
    const webappListener = await ngrok.forward({
      addr: 5173,
      authtoken_from_env: true,
    })
    const webappUrl = webappListener.url()!
    console.log(`Webapp Tunnel URL: ${webappUrl}`)

    // 3. Update webapp/public/client-metadata.json with actual tunnel URL
    const publicDir = path.join(rootDir, 'webapp', 'public')
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true })
    }

    const clientMetadataPath = path.join(publicDir, 'client-metadata.json')
    const clientMetadataTemplatePath = path.join(
      publicDir,
      'client-metadata.json.template',
    )

    // Ensure we have a template to work from
    if (
      !fs.existsSync(clientMetadataTemplatePath) &&
      fs.existsSync(clientMetadataPath)
    ) {
      fs.copyFileSync(clientMetadataPath, clientMetadataTemplatePath)
      console.log(`Created template from ${clientMetadataPath}`)
    }

    if (fs.existsSync(clientMetadataTemplatePath)) {
      let content = fs.readFileSync(clientMetadataTemplatePath, 'utf8')
      content = content.replace(/VITE_WEBAPP_URL/g, webappUrl)
      fs.writeFileSync(clientMetadataPath, content)
      console.log(`Updated ${clientMetadataPath} with ${webappUrl}`)
    }

    // Attempt to fetch public IP for verification (optional for ngrok)
    let publicIp = 'unknown'
    try {
      const response = await fetch('https://api.ipify.org').then((res) =>
        res.text(),
      )
      publicIp = response
    } catch {
      // Ignore errors
    }

    // 4. Prepare environment variables
    const env = {
      ...process.env,
      STRATOS_PUBLIC_URL: serviceUrl,
      STRATOS_REPO_URL: webappUrl,
      VITE_STRATOS_URL: serviceUrl,
      VITE_WEBAPP_URL: webappUrl,
      // Default to bsky.app if not set
      VITE_APPVIEW_URL: process.env.VITE_APPVIEW_URL || 'https://api.bsky.app',
      VITE_ATPROTO_HANDLE_RESOLVER:
        process.env.VITE_ATPROTO_HANDLE_RESOLVER || 'https://bsky.social',
    }

    console.log('Starting services...')

    // 4. Start services using concurrently JS API
    const { result } = concurrently(
      [
        {
          command: `STRATOS_PUBLIC_URL=${serviceUrl} VITE_STRATOS_URL=${serviceUrl} pnpm --filter @northskysocial/stratos-service run dev`,
          name: 'service',
        },
        {
          command: `VITE_STRATOS_URL=${serviceUrl} VITE_WEBAPP_URL=${webappUrl} STRATOS_REPO_URL=${webappUrl} pnpm --filter @northskysocial/stratos-webapp run dev`,
          name: 'webapp',
        },
      ],
      {
        killOthersOn: ['failure', 'success'],
        prefix: 'name',
        env,
        cwd: rootDir,
        raw: false,
      },
    )

    // 5. Wait for services to be ready
    console.log('Waiting for services to be ready on localhost...')
    const [serviceReady, webappReady] = await Promise.all([
      waitForOk('http://localhost:3100/ready'),
      waitForOk('http://localhost:5173/'),
    ])

    if (!serviceReady || !webappReady) {
      console.error('\nError: Services failed to become ready in time.')
      if (!serviceReady)
        console.error('- Stratos Service (3100) not responding.')
      if (!webappReady) console.error('- Webapp (5173) not responding.')
      process.exit(1)
    }

    const helpMsg = `
--- NGROK SETUP ---
1. Tunnels are established at:
   - Webapp:  ${webappUrl}
   - Service: ${serviceUrl}

2. Ensure you have NGROK_AUTHTOKEN set in your .env file or environment.
   Get one at: https://dashboard.ngrok.com/get-started/your-authtoken

3. If you encounter issues, check the ngrok dashboard: https://dashboard.ngrok.com/tunnels/agents
-------------------
`
    console.log(helpMsg)

    // ngrok doesn't have the 511 interstitial issue like localtunnel,
    // but we can still keep a basic health check if desired.
    const checkInterval = setInterval(async () => {
      // Basic connectivity check
      try {
        await Promise.all([
          fetch(serviceUrl).catch(() => null),
          fetch(webappUrl).catch(() => null),
        ])
      } catch {
        // Ignore
      }
    }, 60000)

    const cleanup = () => {
      console.log('\nShutting down tunnels...')
      clearInterval(checkInterval)
      ngrok.disconnect()
      process.exit()
    }

    result.then(cleanup, cleanup)
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
  } catch (err) {
    console.error('Failed to start development environment:', err)
    process.exit(1)
  }
}

start()
