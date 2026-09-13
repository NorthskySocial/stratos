export async function readKeyHistoryResponse(
  response: Response,
): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing service key history response')
  const decoder = new TextDecoder()
  let json = ''
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2_000_000)
        throw new Error('Service key history response is too large')
      json += decoder.decode(value, { stream: true })
    }
    json += decoder.decode()
  } finally {
    await reader.cancel()
  }
  return JSON.parse(json) as unknown
}
