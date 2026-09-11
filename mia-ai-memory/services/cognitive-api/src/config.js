const integer = (name, fallback, min, max) => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const boolean = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase())
}

const coreBaseUrl = (process.env.AI_MEMORY_CORE_URL || "http://localhost:3000/api/v1").replace(/\/$/, "")
const coreOrigin = coreBaseUrl.replace(/\/api\/v1$/, "")

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: integer("PORT", 8787, 1, 65535),
  databaseUrl: process.env.DATABASE_URL || "postgres://ai_memory:ai_memory@localhost:5432/ai_memory",
  coreBaseUrl,
  coreHookUrl: (process.env.AI_MEMORY_HOOK_URL || `${coreOrigin}/hook/batch`).replace(/\/$/, ""),
  coreToken: process.env.AI_MEMORY_API_TOKEN || "",
  syncEnabled: boolean("COGNITIVE_SYNC_ENABLED", true),
  syncIntervalMs: integer("COGNITIVE_SYNC_INTERVAL_MS", 30000, 5000, 3600000),
  syncPageConcurrency: integer("COGNITIVE_SYNC_PAGE_CONCURRENCY", 8, 1, 32),
  brainNodeLimit: integer("COGNITIVE_BRAIN_NODE_LIMIT", 320, 50, 2000),
  adminToken: process.env.COGNITIVE_ADMIN_TOKEN || "",
  migrationsFile: process.env.COGNITIVE_MIGRATIONS_FILE || "",
  migrationsDir: process.env.COGNITIVE_MIGRATIONS_DIR || new URL("../../../db/migrations", import.meta.url).pathname,
  corsOrigin: process.env.CORS_ORIGIN || "*",
  embeddingBaseUrl: (process.env.COGNITIVE_EMBEDDING_BASE_URL || "").replace(/\/$/, ""),
  embeddingApiKey: process.env.COGNITIVE_EMBEDDING_API_KEY || "",
  embeddingProvider: process.env.COGNITIVE_EMBEDDING_PROVIDER || "",
  embeddingModel: process.env.COGNITIVE_EMBEDDING_MODEL || "",
  embeddingDim: integer("COGNITIVE_EMBEDDING_DIM", 0, 0, 65536),
  credentialsMasterKeyBase64: process.env.COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64 || "",
  chatAgentTimeoutMs: integer("COGNITIVE_CHAT_AGENT_TIMEOUT_MS", 180000, 10000, 1800000),
  cursorPollIntervalMs: integer("COGNITIVE_CURSOR_POLL_INTERVAL_MS", 1500, 500, 10000),
  cursorTimeoutMs: integer("COGNITIVE_CURSOR_TIMEOUT_MS", 900000, 30000, 1800000),
  chatAttachmentMaxBytes: integer("COGNITIVE_CHAT_ATTACHMENT_MAX_BYTES", 52428800, 1048576, 104857600),
  chatZipMaxEntries: integer("COGNITIVE_CHAT_ZIP_MAX_ENTRIES", 800, 1, 5000),
  chatZipMaxUncompressedBytes: integer("COGNITIVE_CHAT_ZIP_MAX_UNCOMPRESSED_BYTES", 157286400, 1048576, 524288000),
  chatAttachmentContextMaxBytes: integer("COGNITIVE_CHAT_ATTACHMENT_CONTEXT_MAX_BYTES", 393216, 32768, 2097152),
  chatHistoryLimit: integer("COGNITIVE_CHAT_HISTORY_LIMIT", 24, 4, 100),
  chatMemoryRecallLimit: integer("COGNITIVE_CHAT_MEMORY_RECALL_LIMIT", 6, 1, 20)
}
