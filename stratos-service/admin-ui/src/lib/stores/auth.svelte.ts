import { onUnauthorized, whoami } from '../api/client'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthState {
  did: string | null
  status: AuthStatus
}

export const auth: AuthState = $state({ did: null, status: 'loading' })

onUnauthorized(() => {
  auth.did = null
  auth.status = 'unauthenticated'
})

export async function refreshAuth(): Promise<void> {
  try {
    const res = await whoami()
    auth.did = res.did
    auth.status = 'authenticated'
  } catch {
    auth.did = null
    auth.status = 'unauthenticated'
  }
}

export function setUnauthenticated(): void {
  auth.did = null
  auth.status = 'unauthenticated'
}
