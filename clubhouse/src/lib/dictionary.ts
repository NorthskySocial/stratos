/**
 * A room ID from the catalogue, the configuration or a server answer can be
 * any string, `constructor` and `__proto__` included. A dictionary keyed by
 * one has no prototype, so a missing key reads as missing and a `__proto__`
 * key is stored like any other.
 */
export function emptyDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/**
 * Reads a key the dictionary holds itself. A caller may pass an ordinary
 * object, whose inherited `constructor` or `toString` must not count.
 */
export function ownValue<T>(
  dictionary: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return dictionary !== undefined && Object.hasOwn(dictionary, key)
    ? dictionary[key]
    : undefined
}
