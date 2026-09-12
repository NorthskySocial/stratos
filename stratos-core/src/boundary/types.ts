export type BoundaryStatus = 'active' | 'deactivating' | 'inactive'

export interface BoundaryDefinition {
  boundary: string
  roomId: string
  displayName: string
  description: string
  listed: boolean
  joinable: boolean
  autoEnroll: boolean
  appAccess: 'open' | 'allowList'
  clientIds: string[]
  status: BoundaryStatus
  createdAt: string
  updatedAt: string
  revision: number
}

export interface BoundaryDetails extends BoundaryDefinition {
  memberCount: number
  reserved: boolean
}

export interface BoundarySettings {
  displayName: string
  description: string
  listed: boolean
  joinable: boolean
  autoEnroll: boolean
  appAccess: 'open' | 'allowList'
  clientIds: string[]
}
