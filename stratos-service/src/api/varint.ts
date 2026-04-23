/**
 * Encodes a number as a varint (LEB128).
 * @param value - The number to encode.
 * @returns A Uint8Array containing the varint.
 */
export function encodeVarint(value: number): Uint8Array {
  const result: number[] = []
  let v = value
  while (v >= 0x80) {
    result.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  result.push(v)
  return new Uint8Array(result)
}

/**
 * Decodes a varint (LEB128) from a Uint8Array.
 * @param data - The Uint8Array to decode from.
 * @param offset - The offset to start decoding from.
 * @returns An object containing the decoded value and the number of bytes read.
 */
export function decodeVarint(
  data: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let result = 0
  let shift = 0
  let currentOffset = offset

  while (currentOffset < data.length) {
    const byte = data[currentOffset++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) {
      return { value: result, bytesRead: currentOffset - offset }
    }
    shift += 7
    if (shift >= 32) {
      throw new Error('Varint is too large')
    }
  }

  throw new Error('Unexpected end of data while decoding varint')
}
