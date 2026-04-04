import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { MigratingBoundaryResolver } from '../src/features/index.js'

const BEBOP_SERVICE = 'did:web:bebop.cowboy.space'

describe('MigratingBoundaryResolver', () => {
  let mockStore: {
    getBoundaries: Mock<(did: string) => Promise<string[]>>
    setBoundaries: Mock<(did: string, boundaries: string[]) => Promise<void>>
  }
  let resolver: MigratingBoundaryResolver

  beforeEach(() => {
    mockStore = {
      getBoundaries: vi.fn(),
      setBoundaries: vi.fn(),
    }
    resolver = new MigratingBoundaryResolver({
      enrollmentStore: mockStore,
      serviceDid: BEBOP_SERVICE,
    })
  })

  it('returns empty array for unenrolled users', async () => {
    mockStore.getBoundaries.mockResolvedValue([])
    const result = await resolver.getBoundaries('did:plc:spike' as any)
    expect(result).toEqual([])
    expect(mockStore.setBoundaries).not.toHaveBeenCalled()
  })

  it('passes through already-qualified boundaries without migrating', async () => {
    mockStore.getBoundaries.mockResolvedValue([
      'did:web:bebop.cowboy.space/bounty-hunters',
      'did:web:bebop.cowboy.space/red-dragon',
    ])
    const result = await resolver.getBoundaries('did:plc:spike' as any)
    expect(result).toEqual([
      'did:web:bebop.cowboy.space/bounty-hunters',
      'did:web:bebop.cowboy.space/red-dragon',
    ])
    expect(mockStore.setBoundaries).not.toHaveBeenCalled()
  })

  it('migrates legacy bare-name boundaries to qualified format', async () => {
    mockStore.getBoundaries.mockResolvedValue(['bounty-hunters', 'red-dragon'])
    mockStore.setBoundaries.mockResolvedValue(undefined)

    const result = await resolver.getBoundaries('did:plc:spike' as any)
    expect(result).toEqual([
      'did:web:bebop.cowboy.space/bounty-hunters',
      'did:web:bebop.cowboy.space/red-dragon',
    ])
    expect(mockStore.setBoundaries).toHaveBeenCalledWith(
      'did:plc:spike' as any,
      [
        'did:web:bebop.cowboy.space/bounty-hunters',
        'did:web:bebop.cowboy.space/red-dragon',
      ],
    )
  })

  it('migrates mixed bare and qualified boundaries', async () => {
    mockStore.getBoundaries.mockResolvedValue([
      'did:web:bebop.cowboy.space/bounty-hunters',
      'red-dragon',
    ])
    mockStore.setBoundaries.mockResolvedValue(undefined)

    const result = await resolver.getBoundaries('did:plc:spike' as any)
    expect(result).toEqual([
      'did:web:bebop.cowboy.space/bounty-hunters',
      'did:web:bebop.cowboy.space/red-dragon',
    ])
  })

  it('fires onMigrated callback after successful migration', async () => {
    mockStore.getBoundaries.mockResolvedValue(['bounty-hunters'])
    mockStore.setBoundaries.mockResolvedValue(undefined)
    const onMigrated = vi.fn()
    resolver.onMigrated = onMigrated

    await resolver.getBoundaries('did:plc:faye' as any)
    expect(onMigrated).toHaveBeenCalledWith('did:plc:faye' as any, [
      'did:web:bebop.cowboy.space/bounty-hunters',
    ])
  })

  it('returns qualified boundaries even if DB update fails', async () => {
    mockStore.getBoundaries.mockResolvedValue(['bounty-hunters'])
    mockStore.setBoundaries.mockRejectedValue(new Error('DB locked'))

    const result = await resolver.getBoundaries('did:plc:jet' as any)
    expect(result).toEqual(['did:web:bebop.cowboy.space/bounty-hunters'])
  })

  it('does not fire onMigrated if DB update fails', async () => {
    mockStore.getBoundaries.mockResolvedValue(['bounty-hunters'])
    mockStore.setBoundaries.mockRejectedValue(new Error('DB locked'))
    const onMigrated = vi.fn()
    resolver.onMigrated = onMigrated

    await resolver.getBoundaries('did:plc:jet' as any)
    expect(onMigrated).not.toHaveBeenCalled()
  })
})
