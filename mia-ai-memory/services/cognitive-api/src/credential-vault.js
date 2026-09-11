import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { config } from "./config.js"

const failure = (message, status = 400) => Object.assign(new Error(message), { status })

const masterKey = () => {
  if (!config.credentialsMasterKeyBase64) throw failure("credential vault is not configured", 503)
  const key = Buffer.from(config.credentialsMasterKeyBase64, "base64")
  if (key.length !== 32) throw failure("COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64 must decode to exactly 32 bytes", 503)
  return key
}

const normalizedSecrets = secrets => {
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) throw failure("secrets must be an object")
  const entries = Object.entries(secrets)
  if (!entries.length) throw failure("at least one secret field is required")
  if (entries.length > 64) throw failure("too many secret fields")
  const output = {}
  let total = 0
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || "").trim()
    if (!key || key.length > 120) throw failure("invalid secret field name")
    if (rawValue === undefined || rawValue === null) throw failure(`secret field ${key} is required`)
    const value = String(rawValue)
    if (!value) throw failure(`secret field ${key} is required`)
    if (value.length > 65536) throw failure(`secret field ${key} is too large`)
    total += value.length
    if (total > 262144) throw failure("secret payload is too large")
    output[key] = value
  }
  return output
}

const mask = value => {
  const text = String(value)
  if (text.length <= 4) return "••••"
  return `••••${text.slice(-4)}`
}

export const vaultStatus = () => {
  if (!config.credentialsMasterKeyBase64) return { configured: false }
  try {
    return { configured: masterKey().length === 32 }
  } catch {
    return { configured: false }
  }
}

export const encryptSecrets = secrets => {
  const normalized = normalizedSecrets(secrets)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(normalized), "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    maskedFields: Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, mask(value)]))
  }
}

export const decryptSecrets = credential => {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(credential.iv, "base64"))
  decipher.setAuthTag(Buffer.from(credential.auth_tag || credential.authTag, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(credential.ciphertext, "base64")),
    decipher.final()
  ])
  return JSON.parse(plaintext.toString("utf8"))
}
