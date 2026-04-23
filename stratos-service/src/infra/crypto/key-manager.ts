import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as atprotoCrypto from '@atproto/crypto'
import { fileExists } from '@atproto/common'

const PBKDF2_ITERATIONS = 100_000
const SALT_SIZE = 16
const IV_SIZE = 12
const KEY_SIZE = 32 // AES-256

/**
 * KeyManager handles the service signing key with optional encryption at rest.
 */
export class KeyManager {
  constructor(
    private readonly keyPath: string,
    private readonly masterPassword?: string,
  ) {}

  /**
   * Loads the signing key from storage or creates a new one.
   */
  async loadOrCreate(): Promise<atprotoCrypto.Keypair> {
    if (await fileExists(this.keyPath)) {
      const data = await fs.readFile(this.keyPath)
      const importedBytes = this.masterPassword
        ? await this.decrypt(data)
        : data
      return await atprotoCrypto.Secp256k1Keypair.import(importedBytes)
    }

    const signingKey = await atprotoCrypto.Secp256k1Keypair.create({
      exportable: true,
    })
    const exported = await (
      signingKey as atprotoCrypto.ExportableKeypair
    ).export()
    const dataToSave = this.masterPassword
      ? await this.encrypt(exported)
      : exported

    await fs.mkdir(path.dirname(this.keyPath), { recursive: true })
    await fs.writeFile(this.keyPath, dataToSave)
    return signingKey
  }

  private async encrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.masterPassword)
      throw new Error('Master password required for encryption')

    const salt = crypto.randomBytes(SALT_SIZE)
    const iv = crypto.randomBytes(IV_SIZE)
    const key = crypto.pbkdf2Sync(
      this.masterPassword,
      salt,
      PBKDF2_ITERATIONS,
      KEY_SIZE,
      'sha256',
    )

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
    const tag = cipher.getAuthTag()

    // Format: salt(16) | iv(12) | tag(16) | encrypted(...)
    return Buffer.concat([salt, iv, tag, encrypted])
  }

  private async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.masterPassword)
      throw new Error('Master password required for decryption')

    const salt = data.slice(0, SALT_SIZE)
    const iv = data.slice(SALT_SIZE, SALT_SIZE + IV_SIZE)
    const tag = data.slice(SALT_SIZE + IV_SIZE, SALT_SIZE + IV_SIZE + 16)
    const encrypted = data.slice(SALT_SIZE + IV_SIZE + 16)

    const key = crypto.pbkdf2Sync(
      this.masterPassword,
      salt,
      PBKDF2_ITERATIONS,
      KEY_SIZE,
      'sha256',
    )

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted), decipher.final()])
  }
}
