import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CursorManager,
  type CursorState,
} from '../src/storage/cursor-manager.ts'

describe('CursorManager', () => {
  let flushed: CursorState[]
  let manager: CursorManager

  beforeEach(() => {
    flushed = []
    manager = new CursorManager(100_000, async (state) => {
      flushed.push({
        pdsSeq: state.pdsSeq,
        stratosCursors: new Map(state.stratosCursors),
      })
    })
  })

  afterEach(async () => {
    await manager.stop()
  })

  it('tracks PDS cursor updates', () => {
    manager.updatePdsCursor(42)
    expect(manager.getPdsCursor()).toBe(42)

    manager.updatePdsCursor(100)
    expect(manager.getPdsCursor()).toBe(100)
  })

  it('tracks per-actor stratos cursors', () => {
    manager.updateStratosCursor('did:plc:spike', 10)
    manager.updateStratosCursor('did:plc:faye', 20)

    expect(manager.getStratosCursor('did:plc:spike')).toBe(10)
    expect(manager.getStratosCursor('did:plc:faye')).toBe(20)
    expect(manager.getStratosCursor('did:plc:jet')).toBeUndefined()
  })

  it('removes stratos cursors', () => {
    manager.updateStratosCursor('did:plc:ein', 5)
    expect(manager.getStratosCursor('did:plc:ein')).toBe(5)

    manager.removeStratosCursor('did:plc:ein')
    expect(manager.getStratosCursor('did:plc:ein')).toBeUndefined()
  })

  it('restores state', () => {
    const state: CursorState = {
      pdsSeq: 999,
      stratosCursors: new Map([
        ['did:plc:motoko', 50],
        ['did:plc:batou', 75],
      ]),
    }

    manager.restore(state)

    expect(manager.getPdsCursor()).toBe(999)
    expect(manager.getStratosCursor('did:plc:motoko')).toBe(50)
    expect(manager.getStratosCursor('did:plc:batou')).toBe(75)
  })

  it('flushes state on stop when dirty', async () => {
    manager.start()
    manager.updatePdsCursor(123)
    manager.updateStratosCursor('did:plc:ayanami', 456)
    await manager.stop()

    expect(flushed).toHaveLength(1)
    expect(flushed[0].pdsSeq).toBe(123)
    expect(flushed[0].stratosCursors.get('did:plc:ayanami')).toBe(456)
  })

  it('does not flush when not dirty', async () => {
    manager.start()
    await manager.stop()

    expect(flushed).toHaveLength(0)
  })

  it('flushes periodically', async () => {
    const fastManager = new CursorManager(50, async (state) => {
      flushed.push({
        pdsSeq: state.pdsSeq,
        stratosCursors: new Map(state.stratosCursors),
      })
    })
    fastManager.start()

    fastManager.updatePdsCursor(1)
    await new Promise((r) => setTimeout(r, 120))

    expect(flushed.length).toBeGreaterThanOrEqual(1)
    expect(flushed[0].pdsSeq).toBe(1)

    await fastManager.stop()
  })

  it('restored state is independent from input', () => {
    const cursors = new Map([['did:plc:togusa', 10]])
    const state: CursorState = { pdsSeq: 1, stratosCursors: cursors }

    manager.restore(state)
    cursors.set('did:plc:togusa', 999)

    expect(manager.getStratosCursor('did:plc:togusa')).toBe(10)
  })
})
