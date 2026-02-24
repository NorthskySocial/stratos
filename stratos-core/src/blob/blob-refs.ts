import { CID } from 'multiformats/cid'
import type { PreparedBlobRef } from '../types.js'

interface RawBlobRef {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

function isRawBlobRef(val: unknown): val is RawBlobRef {
  if (!val || typeof val !== 'object') return false
  const obj = val as Record<string, unknown>
  if (obj.$type !== 'blob') return false
  const ref = obj.ref as Record<string, unknown> | undefined
  if (!ref || typeof ref.$link !== 'string') return false
  if (typeof obj.mimeType !== 'string') return false
  return true
}

/**
 * Recursively walks a record value to find all blob references.
 * Detects raw blob objects ({ $type: "blob", ref: { $link }, mimeType, size })
 * and returns them as PreparedBlobRef[].
 */
export function findBlobRefs(
  val: unknown,
  layer = 0,
): PreparedBlobRef[] {
  if (layer > 32) return []

  if (Array.isArray(val)) {
    return val.flatMap((item) => findBlobRefs(item, layer + 1))
  }

  if (val && typeof val === 'object') {
    if (isRawBlobRef(val)) {
      try {
        const cid = CID.parse(val.ref.$link)
        return [{
          cid,
          mimeType: val.mimeType,
          constraints: {},
        }]
      } catch {
        return []
      }
    }

    if (val instanceof Uint8Array) return []

    return Object.values(val as Record<string, unknown>).flatMap((v) =>
      findBlobRefs(v, layer + 1),
    )
  }

  return []
}
