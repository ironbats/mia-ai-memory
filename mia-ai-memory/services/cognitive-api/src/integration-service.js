import { randomUUID } from "node:crypto"
import { decryptSecrets, encryptSecrets, vaultStatus } from "./credential-vault.js"
import { integrationRepository } from "./integration-repository.js"

const failure = (message, status = 400) => Object.assign(new Error(message), { status })

const text = (value, name, max = 255, required = false) => {
  const normalized = String(value ?? "").trim()
  if (required && !normalized) throw failure(`${name} is required`)
  if (normalized.length > max) throw failure(`${name} is too long`)
  return normalized
}

const optionalUrl = (value, name) => {
  const normalized = text(value, name, 2048, false)
  if (!normalized) return ""
  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    throw failure(`${name} must be a valid URL`)
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw failure(`${name} must use http or https`)
  return normalized
}

const stringMap = (value, name) => {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw failure(`${name} must be an object`)
  const entries = Object.entries(value)
  if (entries.length > 64) throw failure(`${name} has too many entries`)
  const result = {}
  for (const [rawKey, rawValue] of entries) {
    const key = text(rawKey, `${name} key`, 120, true)
    const item = String(rawValue ?? "")
    if (item.length > 8192) throw failure(`${name}.${key} is too large`)
    result[key] = item
  }
  return result
}

const settings = value => {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) throw failure("settings must be an object")
  if (JSON.stringify(value).length > 65536) throw failure("settings are too large")
  return value
}


const observedAgentDefault = provider => {
  const normalized = String(provider || "").trim().toLowerCase()
  const values = {
    "claude code": "claude-code",
    "codex": "codex",
    "openai": "codex",
    "anthropic": "claude-code",
    "google gemini": "gemini-cli",
    "cursor": "cursor",
    "xai": "grok",
    "grok": "grok",
    "opencode": "opencode"
  }
  return values[normalized] || ""
}

const idList = value => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw failure("mcpIds must be an array")
  const values = [...new Set(value.map(item => text(item, "mcp id", 64, true)))]
  if (values.length > 64) throw failure("too many MCP bindings")
  return values
}

const credentialRecord = (id, input, fallback = {}) => {
  const encrypted = encryptSecrets(input.secrets)
  return {
    id,
    name: text(input.name ?? fallback.name, "credential name", 180, true),
    kind: text(input.kind ?? fallback.kind ?? "api-key", "credential kind", 80, true),
    provider: text(input.provider ?? fallback.provider ?? "", "credential provider", 120, false),
    ...encrypted
  }
}

const resolveCredential = async (input, currentCredential = null) => {
  if (input === undefined) return { credentialId: currentCredential?.id || null, record: null, isNew: false }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("credential must be an object")
  const mode = text(input.mode || "existing", "credential mode", 20, true)
  if (mode === "none") return { credentialId: null, record: null, isNew: false }
  if (mode === "existing") {
    const id = text(input.id, "credential id", 64, true)
    const metadata = await integrationRepository.credentialMetadata(id)
    if (!metadata) throw failure("credential not found", 404)
    return { credentialId: id, record: null, isNew: false }
  }
  if (mode === "new") {
    const id = randomUUID()
    return { credentialId: id, record: credentialRecord(id, input), isNew: true }
  }
  if (mode === "rotate") {
    if (!currentCredential?.id) throw failure("agent or MCP has no credential to rotate", 409)
    return {
      credentialId: currentCredential.id,
      record: credentialRecord(currentCredential.id, input, currentCredential),
      isNew: false
    }
  }
  throw failure("unsupported credential mode")
}

const normalizeAgent = async (body, current = null) => {
  const connectionType = text(body.connectionType ?? current?.connectionType ?? "external", "connectionType", 30, true)
  if (!["api-key", "mcp", "hybrid", "external"].includes(connectionType)) throw failure("unsupported connectionType")
  const mcpIds = idList(body.mcpIds ?? current?.mcpServers?.map(item => item.id) ?? [])
  if (!(await integrationRepository.validateMcpIds(mcpIds))) throw failure("one or more MCP servers do not exist", 409)
  const credential = await resolveCredential(body.credential, current?.credential || null)
  return {
    id: current?.id || randomUUID(),
    isNew: !current,
    name: text(body.name ?? current?.name, "agent name", 180, true),
    description: text(body.description ?? current?.description ?? "", "agent description", 4000, false),
    connectionType,
    provider: text(body.provider ?? current?.provider ?? "", "provider", 120, false),
    model: text(body.model ?? current?.model ?? "", "model", 180, false),
    baseUrl: optionalUrl(body.baseUrl ?? current?.baseUrl ?? "", "baseUrl"),
    workspace: text(body.workspace ?? current?.workspace ?? "", "workspace", 180, false),
    project: text(body.project ?? current?.project ?? "", "project", 180, false),
    observedAgentKind: text(body.observedAgentKind ?? current?.observedAgentKind ?? observedAgentDefault(body.provider ?? current?.provider), "observedAgentKind", 180, false),
    credentialId: credential.credentialId,
    credentialRecord: credential.record,
    credentialIsNew: credential.isNew,
    mcpIds,
    settings: settings(body.settings ?? current?.settings ?? {}),
    enabled: body.enabled === undefined ? current?.enabled !== false : body.enabled === true
  }
}

const normalizeMcp = async (body, current = null) => {
  const transport = text(body.transport ?? current?.transport ?? "streamable-http", "transport", 40, true)
  if (!["streamable-http", "sse", "stdio"].includes(transport)) throw failure("unsupported MCP transport")
  const endpointUrl = optionalUrl(body.endpointUrl ?? current?.endpointUrl ?? "", "endpointUrl")
  const command = text(body.command ?? current?.command ?? "", "command", 2048, false)
  if (transport === "stdio" && !command) throw failure("command is required for stdio MCP")
  if (transport !== "stdio" && !endpointUrl) throw failure("endpointUrl is required for HTTP/SSE MCP")
  const rawArgs = body.args ?? current?.args ?? []
  if (!Array.isArray(rawArgs)) throw failure("args must be an array")
  if (rawArgs.length > 128) throw failure("too many MCP arguments")
  const args = rawArgs.map((item, index) => text(item, `args[${index}]`, 4096, false))
  const credential = await resolveCredential(body.credential, current?.credential || null)
  return {
    id: current?.id || randomUUID(),
    isNew: !current,
    name: text(body.name ?? current?.name, "MCP name", 180, true),
    description: text(body.description ?? current?.description ?? "", "MCP description", 4000, false),
    transport,
    endpointUrl: transport === "stdio" ? "" : endpointUrl,
    command: transport === "stdio" ? command : "",
    args,
    publicHeaders: stringMap(body.publicHeaders ?? current?.publicHeaders ?? {}, "publicHeaders"),
    publicEnv: stringMap(body.publicEnv ?? current?.publicEnv ?? {}, "publicEnv"),
    authType: text(body.authType ?? current?.authType ?? "none", "authType", 80, true),
    credentialId: credential.credentialId,
    credentialRecord: credential.record,
    credentialIsNew: credential.isNew,
    enabled: body.enabled === undefined ? current?.enabled !== false : body.enabled === true
  }
}

export const integrationService = {
  vaultStatus,

  summary: () => integrationRepository.summary(),
  agents: () => integrationRepository.listAgents(),
  models: () => integrationRepository.listModels(),
  mcps: () => integrationRepository.listMcps(),
  credentials: () => integrationRepository.listCredentials(),
  audit: limit => integrationRepository.audit(limit),

  async runtimeAgent(id) {
    const agent = await integrationRepository.agent(id)
    if (!agent) throw failure("agent not found", 404)
    if (!agent.enabled) throw failure("agent is disabled", 409)
    let secrets = {}
    if (agent.credentialId) {
      const credential = await integrationRepository.credential(agent.credentialId)
      if (!credential) throw failure("agent credential not found", 409)
      secrets = decryptSecrets(credential)
    }
    return { agent, secrets }
  },

  async createCredential(body) {
    const id = randomUUID()
    const credential = credentialRecord(id, body)
    await integrationRepository.createCredential(credential)
    return integrationRepository.credentialMetadata(id)
  },

  async rotateCredential(id, body) {
    const current = await integrationRepository.credentialMetadata(id)
    if (!current) throw failure("credential not found", 404)
    const credential = credentialRecord(id, body, current)
    const updated = await integrationRepository.rotateCredential(credential)
    if (!updated) throw failure("credential not found", 404)
    return integrationRepository.credentialMetadata(id)
  },

  async deleteCredential(id) {
    const usage = await integrationRepository.credentialUsage(id)
    if (usage.agents.length || usage.mcps.length) {
      throw failure("credential is in use by an agent or MCP server", 409)
    }
    if (!(await integrationRepository.deleteCredential(id))) throw failure("credential not found", 404)
    return { deleted: true }
  },

  async createAgent(body) {
    const agent = await normalizeAgent(body)
    await integrationRepository.saveAgent(agent, agent.credentialRecord, agent.credentialIsNew)
    return integrationRepository.agent(agent.id)
  },

  async updateAgent(id, body) {
    const current = await integrationRepository.agent(id)
    if (!current) throw failure("agent not found", 404)
    const agent = await normalizeAgent(body, current)
    await integrationRepository.saveAgent(agent, agent.credentialRecord, agent.credentialIsNew)
    return integrationRepository.agent(id)
  },

  async setAgentEnabled(id, enabled) {
    if (!(await integrationRepository.setAgentEnabled(id, enabled === true))) throw failure("agent not found", 404)
    return integrationRepository.agent(id)
  },

  async deleteAgent(id) {
    const current = await integrationRepository.agent(id)
    if (!current) throw failure("agent not found", 404)
    if (current.settings?.systemDefault === true) throw failure("default agents cannot be deleted; disable them instead", 409)
    if (!(await integrationRepository.deleteAgent(id))) throw failure("agent not found", 404)
    return { deleted: true }
  },

  async createMcp(body) {
    const mcp = await normalizeMcp(body)
    await integrationRepository.saveMcp(mcp, mcp.credentialRecord, mcp.credentialIsNew)
    return integrationRepository.mcp(mcp.id)
  },

  async updateMcp(id, body) {
    const current = await integrationRepository.mcp(id)
    if (!current) throw failure("MCP server not found", 404)
    const mcp = await normalizeMcp(body, current)
    await integrationRepository.saveMcp(mcp, mcp.credentialRecord, mcp.credentialIsNew)
    return integrationRepository.mcp(id)
  },

  async setMcpEnabled(id, enabled) {
    if (!(await integrationRepository.setMcpEnabled(id, enabled === true))) throw failure("MCP server not found", 404)
    return integrationRepository.mcp(id)
  },

  async deleteMcp(id) {
    if (!(await integrationRepository.deleteMcp(id))) throw failure("MCP server not found", 404)
    return { deleted: true }
  }
}
