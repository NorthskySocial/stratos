import type { BoundaryDefinition, BoundarySettings } from './types.js'

export interface BoundaryCatalogStore {
  initialize(definitions: BoundaryDefinition[]): Promise<void>
  list(): Promise<BoundaryDefinition[]>
  get(boundary: string): Promise<BoundaryDefinition | null>
  create(definition: BoundaryDefinition): Promise<void>
  update(
    boundary: string,
    settings: BoundarySettings,
    revision: number,
  ): Promise<boolean>
  beginDeactivation(boundary: string, revision: number): Promise<boolean>
  finishDeactivation(boundary: string): Promise<boolean>
  reactivate(boundary: string, revision: number): Promise<boolean>
  listDeactivationMembers(boundary: string, limit: number): Promise<string[]>
  completeDeactivationMember(boundary: string, did: string): Promise<void>
  countMembers(boundary: string): Promise<number>
}
