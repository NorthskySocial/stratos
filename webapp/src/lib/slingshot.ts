const SLINGSHOT_URL = 'https://slingshot.microcosm.blue'

export interface SlingshotProfile {
  displayName: string
  description: string
  avatarCid: string | null
  bannerCid: string | null
}

export interface MiniDoc {
  did: string
  handle: string
  pds: string
  signing_key: string
}

export function avatarUrl(did: string, cid: string): string {
  return `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg`
}

export function blobUrl(did: string, cid: string): string {
  return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`
}

export function thumbUrl(did: string, cid: string): string {
  return `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${cid}@jpeg`
}

export function bannerUrl(did: string, cid: string): string {
  return `https://cdn.bsky.app/img/banner/plain/${did}/${cid}@jpeg`
}

export async function fetchProfileViaSlingshot(
  did: string,
): Promise<SlingshotProfile | null> {
  try {
    const params = new URLSearchParams({
      repo: did,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
    })
    const res = await fetch(
      `${SLINGSHOT_URL}/xrpc/com.atproto.repo.getRecord?${params}`,
    )
    if (!res.ok) return null
    const data = await res.json()
    const val = data.value as Record<string, unknown>

    let avatarCid: string | null = null
    let bannerCid: string | null = null

    const avatar = val.avatar as Record<string, unknown> | undefined
    if (avatar?.ref) {
      const ref = avatar.ref as Record<string, unknown>
      avatarCid = (ref.$link as string) ?? null
    }

    const banner = val.banner as Record<string, unknown> | undefined
    if (banner?.ref) {
      const ref = banner.ref as Record<string, unknown>
      bannerCid = (ref.$link as string) ?? null
    }

    return {
      displayName: (val.displayName as string) ?? '',
      description: (val.description as string) ?? '',
      avatarCid,
      bannerCid,
    }
  } catch {
    return null
  }
}

export async function resolveMiniDoc(
  identifier: string,
): Promise<MiniDoc | null> {
  try {
    const params = new URLSearchParams({ identifier })
    const res = await fetch(
      `${SLINGSHOT_URL}/xrpc/blue.microcosm.identity.resolveMiniDoc?${params}`,
    )
    if (!res.ok) return null
    return (await res.json()) as MiniDoc
  } catch {
    return null
  }
}
