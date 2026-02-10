// Test state persistence — read/write between script phases

import { STATE_FILE } from './config.ts'

export interface RecordRef {
  uri: string
  cid: string
  rkey: string
}

export interface UserState {
  did: string
  handle: string
  password: string
  enrolled: boolean
  records: Record<string, RecordRef>
}

export interface TestState {
  users: Record<string, UserState>
  stratosRunning: boolean
  ngrokUrl?: string
}

export function emptyState(): TestState {
  return { users: {}, stratosRunning: false }
}

export async function loadState(): Promise<TestState> {
  try {
    const text = await Deno.readTextFile(STATE_FILE)
    return JSON.parse(text) as TestState
  } catch {
    return emptyState()
  }
}

export async function saveState(state: TestState): Promise<void> {
  await Deno.mkdir(new URL('.', `file://${STATE_FILE}`).pathname, {
    recursive: true,
  })
  await Deno.writeTextFile(STATE_FILE, JSON.stringify(state, null, 2))
}
