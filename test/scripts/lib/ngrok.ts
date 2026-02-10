import { info, pass, fail, warn } from './log.ts'
import { loadState, saveState } from './state.ts'

export async function startNgrok(port: number): Promise<string> {
  info(`Starting ngrok tunnel to port ${port}...`)

  const authToken = Deno.env.get('NGROK_AUTHTOKEN')
  if (authToken) {
    const authCmd = new Deno.Command('ngrok', {
      args: ['config', 'add-authtoken', authToken],
    })
    await authCmd.output()
  }

  const cmd = new Deno.Command('ngrok', {
    args: ['http', port.toString(), '--log=stdout'],
    stdout: 'null',
    stderr: 'null',
    stdin: 'null',
  })

  const child = cmd.spawn()
  child.unref()
  
  // Give it a moment to start and fetch the tunnel URL
  // ngrok has an API on localhost:4040
  let url = ''
  for (let i = 0; i < 10; i++) {
    try {
      const resp = await fetch('http://localhost:4040/api/tunnels')
      const data = await resp.json()
      if (data.tunnels && data.tunnels.length > 0) {
        url = data.tunnels[0].public_url
        break
      }
    } catch (err) {
      // Ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  if (!url) {
    // If we couldn't get it from the API, try to parse it from the process output if needed
    // But API is more reliable
    fail('Failed to start ngrok or get public URL')
    child.kill()
    throw new Error('ngrok failed to start')
  }

  pass('ngrok started', url)
  
  const state = await loadState()
  state.ngrokUrl = url
  await saveState(state)

  return url
}

export async function stopNgrok(): Promise<void> {
  info('Stopping ngrok...')
  const pkill = new Deno.Command('pkill', {
    args: ['ngrok'],
  })
  try {
    await pkill.output()
    pass('ngrok stopped')
  } catch (err) {
    warn(`Failed to stop ngrok: ${err}`)
  }
}
