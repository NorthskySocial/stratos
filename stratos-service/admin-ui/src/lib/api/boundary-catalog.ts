import type {
  BoundaryDetails,
  BoundarySettings,
} from '@northskysocial/stratos-core/boundary/types'
import { post, request } from './client'

export type { BoundaryDetails, BoundarySettings }

interface BoundaryResponse {
  boundary: BoundaryDetails
}

export function listBoundaries(): Promise<{ boundaries: BoundaryDetails[] }> {
  return request('/xrpc/zone.stratos.admin.listBoundaries')
}

export function createBoundary(
  name: string,
  settings: BoundarySettings,
): Promise<BoundaryResponse> {
  return post('/xrpc/zone.stratos.admin.createBoundary', { name, settings })
}

export function updateBoundary(
  boundary: string,
  revision: number,
  settings: BoundarySettings,
): Promise<BoundaryResponse> {
  return post('/xrpc/zone.stratos.admin.updateBoundary', {
    boundary,
    revision,
    settings,
  })
}

export function deactivateBoundary(
  boundary: string,
  revision: number,
): Promise<BoundaryResponse> {
  return post('/xrpc/zone.stratos.admin.deactivateBoundary', {
    boundary,
    revision,
  })
}

export function reactivateBoundary(
  boundary: string,
  revision: number,
): Promise<BoundaryResponse> {
  return post('/xrpc/zone.stratos.admin.reactivateBoundary', {
    boundary,
    revision,
  })
}
