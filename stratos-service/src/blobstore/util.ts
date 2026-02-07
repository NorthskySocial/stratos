import {Readable} from 'node:stream'

/**
 * Convert a Node.js Readable stream to an AsyncIterable
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
 */
export function asyncIterableToReadable(
  iterable: AsyncIterable<Uint8Array>,
): Readable {
  return Readable.from(iterable)
}

/**
 * Collect an AsyncIterable into a Buffer
 */
export async function collectAsyncIterable(
  iterable: Readable,
): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of iterable) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}
