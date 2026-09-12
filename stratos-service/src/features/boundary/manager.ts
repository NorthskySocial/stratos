import {
  BoundaryManagementError,
  validateBoundarySettings,
  qualifyNewBoundary,
  type BoundaryCatalogStore,
  type BoundaryDefinition,
  type BoundaryDetails,
  type BoundarySettings,
} from '@northskysocial/stratos-core'
import type { BoundaryConfiguration } from './configuration.js'

export interface BoundaryManagerDeps {
  store: BoundaryCatalogStore
  configuration: BoundaryConfiguration
  serviceDid: string
  reservedBoundary: string
  removeMembership: (did: string, boundary: string) => Promise<void>
  onError?: (error: unknown) => void
}

export class BoundaryManager {
  private draining: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false

  constructor(private readonly deps: BoundaryManagerDeps) {}

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => {
      void this.drain().catch((err: unknown) => this.deps.onError?.(err))
    }, 5_000)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await this.draining
  }

  async list(): Promise<BoundaryDetails[]> {
    return Promise.all(
      (await this.deps.store.list()).map((d) => this.details(d)),
    )
  }

  async create(
    name: string,
    settings: BoundarySettings,
  ): Promise<BoundaryDetails> {
    const boundary = qualifyNewBoundary(this.deps.serviceDid, name)
    validateBoundarySettings(settings)
    if (await this.deps.store.get(boundary))
      throw new BoundaryManagementError(
        'This boundary already exists',
        'BoundaryExists',
      )
    const now = new Date().toISOString()
    const definition: BoundaryDefinition = {
      ...settings,
      boundary,
      roomId: name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    await this.deps.store.create(definition)
    await this.deps.configuration.refresh()
    return this.details(definition)
  }

  async update(
    boundary: string,
    settings: BoundarySettings,
    revision: number,
  ): Promise<BoundaryDetails> {
    validateBoundarySettings(settings)
    const existing = await this.requireBoundary(boundary)
    if (
      existing.boundary === this.deps.reservedBoundary &&
      !settings.autoEnroll
    )
      throw new BoundaryManagementError(
        'The all-members boundary must enroll every member',
        'ReservedBoundary',
      )
    if (!(await this.deps.store.update(boundary, settings, revision)))
      throw conflict()
    await this.deps.configuration.refresh()
    return this.details(await this.requireBoundary(boundary))
  }

  async deactivate(
    boundary: string,
    revision: number,
  ): Promise<BoundaryDetails> {
    this.requireMutableBoundary(boundary)
    const existing = await this.requireBoundary(boundary)
    if (
      existing.status === 'active' &&
      !(await this.deps.store.beginDeactivation(boundary, revision))
    )
      throw conflict()
    await this.deps.configuration.refresh()
    await this.drain()
    return this.details(await this.requireBoundary(boundary))
  }

  async reactivate(
    boundary: string,
    revision: number,
  ): Promise<BoundaryDetails> {
    this.requireMutableBoundary(boundary)
    await this.requireBoundary(boundary)
    if (!(await this.deps.store.reactivate(boundary, revision)))
      throw conflict()
    await this.deps.configuration.refresh()
    return this.details(await this.requireBoundary(boundary))
  }

  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.draining) return this.draining
    this.draining = this.drainBatch().finally(() => {
      this.draining = null
    })
    return this.draining
  }

  private async drainBatch(): Promise<void> {
    const pending = (await this.deps.store.list()).filter(
      (d) => d.status === 'deactivating',
    )
    for (const definition of pending) {
      try {
        const members = await this.deps.store.listDeactivationMembers(
          definition.boundary,
          100,
        )
        for (const did of members) {
          await this.deps.removeMembership(did, definition.boundary)
          await this.deps.store.completeDeactivationMember(
            definition.boundary,
            did,
          )
        }
        await this.deps.store.finishDeactivation(definition.boundary)
      } catch (err) {
        this.deps.onError?.(err)
      }
    }
    await this.deps.configuration.refresh()
  }

  private requireMutableBoundary(boundary: string): void {
    if (boundary === this.deps.reservedBoundary)
      throw new BoundaryManagementError(
        'The all-members boundary cannot be deactivated',
        'ReservedBoundary',
      )
  }

  private async requireBoundary(boundary: string): Promise<BoundaryDefinition> {
    const definition = await this.deps.store.get(boundary)
    if (!definition)
      throw new BoundaryManagementError(
        'Boundary not found',
        'BoundaryNotFound',
      )
    return definition
  }

  private async details(
    definition: BoundaryDefinition,
  ): Promise<BoundaryDetails> {
    return {
      ...definition,
      reserved: definition.boundary === this.deps.reservedBoundary,
      memberCount: await this.deps.store.countMembers(definition.boundary),
    }
  }
}

function conflict(): BoundaryManagementError {
  return new BoundaryManagementError(
    'The boundary changed. Reload it before making this change.',
    'BoundaryConflict',
  )
}
