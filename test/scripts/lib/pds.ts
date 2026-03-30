// PDS admin API helpers — account creation via pds.atverkackt.de

import { PDS_URL, PDS_ADMIN_PASSWORD } from './config.ts'

const adminAuth = `Basic ${btoa(`admin:${PDS_ADMIN_PASSWORD}`)}`

interface CreateAccountResponse {
  handle: string
  did: string
  accessJwt: string
  refreshJwt: string
}

interface CreateSessionResponse {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
}

interface InviteCodeResponse {
  code: string
}

/** Create an invite code via the PDS admin API */
export async function createInviteCode(useCount = 1): Promise<string> {
  const res = await fetch(
    `${PDS_URL}/xrpc/com.atproto.server.createInviteCode`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: adminAuth,
      },
      body: JSON.stringify({ useCount }),
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to create invite code: ${res.status} ${body}`)
  }

  const data = (await res.json()) as InviteCodeResponse
  return data.code
}

/** Create a new account on the PDS */
export async function createAccount(
  handle: string,
  email: string,
  password: string,
  inviteCode: string,
): Promise<CreateAccountResponse> {
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ handle, email, password, inviteCode }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to create account ${handle}: ${res.status} ${body}`)
  }

  return (await res.json()) as CreateAccountResponse
}

/** Create a session (login) on the PDS */
export async function createSession(
  identifier: string,
  password: string,
): Promise<CreateSessionResponse> {
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to create session: ${res.status} ${body}`)
  }

  return (await res.json()) as CreateSessionResponse
}

/** Check if an account already exists by trying to create a session */
export async function accountExists(
  handle: string,
  password: string,
): Promise<{ exists: boolean; did?: string }> {
  try {
    const session = await createSession(handle, password)
    return { exists: true, did: session.did }
  } catch {
    return { exists: false }
  }
}

/** Delete an account via the PDS admin API */
export async function deleteAccount(did: string): Promise<void> {
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.admin.deleteAccount`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: adminAuth,
    },
    body: JSON.stringify({ did }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to delete account ${did}: ${res.status} ${body}`)
  }
}

/** Check for enrollment record on PDS */
export async function getEnrollmentRecord(
  did: string,
  accessJwt: string,
): Promise<{ exists: boolean; value?: Record<string, unknown> }> {
  const collection = 'zone.stratos.actor.enrollment'
  const res = await fetch(
    `${PDS_URL}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=self`,
    {
      headers: {
        Authorization: `Bearer ${accessJwt}`,
      },
    },
  )

  if (res.status === 404) {
    return { exists: false }
  }

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to get enrollment record: ${res.status} ${body}`)
  }

  const data = await res.json()
  return { exists: true, value: data.value }
}
