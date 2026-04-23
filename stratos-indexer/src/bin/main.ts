import process from 'node:process'
import { loadConfig } from '../config.ts'
import { Indexer } from '../indexer.ts'

const main = async (): Promise<void> => {
  const config = loadConfig()
  const indexer = new Indexer(config)

  await indexer.start()

  const shutdown = async () => {
    await indexer.stop()
    Deno.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch((err) => {
  console.error('fatal error', err)
  Deno.exit(1)
})
