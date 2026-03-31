import { Readable } from 'node:stream'

/**
 * Converts a Node.js Readable stream into an AsyncIterable that yields Uint8Array chunks.
 *
 * @param readable - The Node.js Readable stream to convert.
 * @returns An AsyncIterable that yields Uint8Array chunks.
 */
export async function* readableToAsyncIterable(
  readable: Readable,
): AsyncIterable<Uint8Array> {
  for await (const chunk of readable) {
    yield new Uint8Array(chunk)
  }
}

/**
 * Convert an AsyncIterable to a Node.js Readable stream
 *
 * @param iterable - The AsyncIterable to convert.
 * @returns A Node.js Readable stream.
 */
export function asyncIterableToReadable(
  iterable: AsyncIterable<Uint8Array>,
): Readable {
  const iterator = iterable[Symbol.asyncIterator]()

  return new Readable({
    async read() {
      try {
        const { value, done } = await iterator.next()
        if (done) {
          this.push(null)
        } else {
          this.push(Buffer.from(value))
        }
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)))
      }
    },
  })
}

/**
 * Collect an AsyncIterable into a Uint8Array
 *
 * @param iterable - The AsyncIterable to collect.
 * @returns A Uint8Array containing all chunks from the iterable.
 */
export async function collectAsyncIterable(
  iterable: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }

  // Calculate total length
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)

  // Concatenate
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}
