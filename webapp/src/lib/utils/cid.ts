export interface StratosImage {
  image:
    | {
        ref?: { $link: string }
        cid?: string
        mimeType?: string
        url?: string
        original?: {
          ref: { $link: string } | string
          mimeType: string
        }
        $link?: string
        image?: unknown
      }
    | string
  alt?: string
  fullsize?: string
  thumb?: string
}

export function getCid(image: StratosImage['image']): string | undefined {
  if (!image) return undefined
  if (typeof image === 'string') return image

  const img = image as Record<string, unknown>

  function getStr(obj: unknown): string | undefined {
    if (!obj) return undefined
    // Check if it's a string (CID or string-encoded link)
    if (typeof obj === 'string') {
      return obj
    }
    // Check for $link property (common in ATProto JSON)
    const record = obj as Record<string, unknown>
    if (record.$link && typeof record.$link === 'string') {
      return record.$link
    }
    // Check for CID object with toString method
    if (typeof record.toString === 'function') {
      const s = record.toString()
      // Ensure we don't return "[object Object]" as a CID
      if (
        s &&
        s !== '[object Object]' &&
        (s.startsWith('baf') || s.length > 20)
      ) {
        return s
      }
    }
    return undefined
  }

  // Check top-level properties
  let cid = getStr(img.cid) || getStr(img.$link)
  if (cid) return cid

  // Check standard ref (ATProto blob)
  cid = getStr(img.ref)
  if (cid) return cid

  // Check original.ref
  const original = img.original as Record<string, unknown> | undefined
  cid = getStr(original?.ref)
  if (cid) return cid

  // Check nested image property
  if (img.image) {
    const nestedImage = img.image as Record<string, unknown>
    cid =
      getStr(nestedImage.cid) ||
      getStr(nestedImage.$link) ||
      getStr(nestedImage.ref) ||
      getStr(img.image)
    if (cid) return cid
  }

  return undefined
}
