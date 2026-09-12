import type {
  BoundaryDefinition,
  BoundaryCatalogStore,
  EnrollmentStoreReader,
  ServiceEnrollment,
} from '@northskysocial/stratos-core'
import type { StratosServiceConfig } from '../../config.js'
import type { RoomCatalog } from '../../oauth/room-catalog.js'

export function initialBoundaryDefinitions(
  cfg: StratosServiceConfig,
): BoundaryDefinition[] {
  const rooms = cfg.roomCatalog?.list() ?? []
  const automatic =
    (cfg.enrollment.autoEnrollDomains?.length ?? 0) > 0
      ? cfg.enrollment.autoEnrollDomains!
      : cfg.stratos.allowedDomains
  const now = new Date().toISOString()
  return cfg.stratos.allowedDomains.map((boundary) => {
    const room = rooms.find((entry) => entry.boundary === boundary)
    const name = boundary.slice(cfg.service.did.length + 1)
    const access = cfg.stratos.spaceAppAccess?.byBoundary.get(boundary)
    return {
      boundary,
      roomId: room?.id ?? name,
      displayName: room?.displayName ?? name,
      description: room?.description ?? '',
      listed: room !== undefined,
      joinable: room?.available ?? false,
      autoEnroll:
        boundary === cfg.stratos.reservedDomain || automatic.includes(boundary),
      appAccess: access?.kind ?? 'open',
      clientIds: access?.kind === 'allowList' ? access.clientIds : [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
  })
}

/** Config files seed the catalog once; future reads use its durable definitions. */
export class BoundaryConfiguration {
  private definitions: BoundaryDefinition[] = []
  private refreshing: Promise<void> = Promise.resolve()
  readonly rooms: RoomCatalog = {
    list: () =>
      this.definitions
        .filter((d) => d.listed)
        .map((d) => ({
          id: d.roomId,
          boundary: d.boundary,
          displayName: d.displayName,
          description: d.description,
          available: d.status === 'active' && d.joinable,
        })),
    get: (id) => this.rooms.list().find((room) => room.id === id),
  }

  constructor(
    private readonly store: BoundaryCatalogStore,
    private readonly cfg: StratosServiceConfig,
  ) {}

  async serviceMemberships(
    enrollment: ServiceEnrollment,
    members: EnrollmentStoreReader,
  ): Promise<string[]> {
    const definitions = await this.store.list()
    for (const boundary of enrollment.boundaries) {
      if (!definitions.some((d) => d.boundary === boundary)) {
        throw new Error(
          `Service enrollment references unknown boundary: ${boundary}`,
        )
      }
    }
    // After the initial grant, membership belongs to the admin surface.
    if (await members.getEnrollment(enrollment.did))
      return members.getBoundaries(enrollment.did)
    const active = new Set(
      definitions.filter((d) => d.status === 'active').map((d) => d.boundary),
    )
    return enrollment.boundaries.filter((boundary) => active.has(boundary))
  }

  refresh(): Promise<void> {
    this.refreshing = this.refreshing.catch(() => {}).then(() => this.load())
    return this.refreshing
  }

  private async load(): Promise<void> {
    const definitions = await this.store.list()
    const reserved = definitions.find(
      (d) => d.boundary === this.cfg.stratos.reservedDomain,
    )
    if (reserved?.status !== 'active')
      throw new Error(
        'The reserved boundary must be active in the boundary catalog',
      )
    this.definitions = definitions
    const active = definitions.filter((d) => d.status === 'active')
    this.cfg.stratos.allowedDomains.splice(
      0,
      this.cfg.stratos.allowedDomains.length,
      ...active.map((d) => d.boundary),
    )
    this.cfg.enrollment.autoEnrollDomains ??= []
    this.cfg.enrollment.autoEnrollDomains.splice(
      0,
      this.cfg.enrollment.autoEnrollDomains.length,
      ...active
        .filter(
          (d) => d.autoEnroll || d.boundary === this.cfg.stratos.reservedDomain,
        )
        .map((d) => d.boundary),
    )
    this.cfg.roomCatalog = this.rooms
    const policies = this.cfg.stratos.spaceAppAccess ?? {
      byBoundary: new Map(),
    }
    policies.byBoundary.clear()
    for (const d of active)
      policies.byBoundary.set(
        d.boundary,
        d.appAccess === 'open'
          ? { kind: 'open' }
          : { kind: 'allowList', clientIds: d.clientIds },
      )
    this.cfg.stratos.spaceAppAccess = policies
  }
}
