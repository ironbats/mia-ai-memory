import http from "node:http"
import { URL } from "node:url"
import { config } from "./config.js"
import { core } from "./core-client.js"
import { repository } from "./repository.js"
import { createQueryEmbedding } from "./embedding-client.js"
import { integrationService } from "./integration-service.js"
import { chatService } from "./chat-service.js"
import { syncCognitiveReadModel } from "./sync-service.js"

const send = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Disposition"
  })
  res.end(payload)
}

const sendBinary = (res, status, body, contentType, fileName) => {
  const safeName = String(fileName || "download.bin").replace(/["\r\n]/g, "_")
  res.writeHead(status, {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Disposition"
  })
  res.end(body)
}

const readBuffer = async (req, maxBytes) => {
  const declared = Number.parseInt(req.headers["content-length"] || "0", 10)
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error("request body too large"), { status: 413, expose: true })
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error("request body too large"), { status: 413, expose: true })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const readJson = async (req, maxBytes = 2 * 1024 * 1024) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error("request body too large"), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

const requiredScope = url => {
  const workspace = url.searchParams.get("workspace")?.trim()
  const project = url.searchParams.get("project")?.trim()
  if (!workspace || !project) throw Object.assign(new Error("workspace and project are required"), { status: 400 })
  return { workspace, project }
}

const clamp = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value || "", 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const adminAllowed = req => !config.adminToken || req.headers["x-admin-token"] === config.adminToken

const requireAdmin = req => {
  if (!adminAllowed(req)) throw Object.assign(new Error("forbidden"), { status: 403 })
}

const pathId = (pathname, prefix) => {
  if (!pathname.startsWith(`${prefix}/`)) return null
  const id = pathname.slice(prefix.length + 1)
  return id && !id.includes("/") ? id : null
}

const buildBrain = raw => {
  const nodes = new Map()
  const edges = []
  const memoryIds = new Map()
  const entityFrequency = new Map()
  for (const memory of raw.memories) {
    const entities = Array.isArray(memory.frontmatter?.entities) ? memory.frontmatter.entities : []
    for (const entity of entities) {
      if (typeof entity !== "string" || !entity.trim()) continue
      const key = entity.trim()
      entityFrequency.set(key, (entityFrequency.get(key) || 0) + 1)
    }
  }
  const visibleEntities = new Set([...entityFrequency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 80).map(([entity]) => entity))
  const addNode = node => {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
  }
  const addEdge = edge => edges.push(edge)

  for (const memory of raw.memories) {
    const id = `memory:${memory.workspace}:${memory.project}:${memory.path}`
    memoryIds.set(memory.path, id)
    addNode({
      id,
      type: "memory",
      label: memory.title,
      path: memory.path,
      kind: memory.kind,
      tier: memory.tier,
      pinned: memory.pinned,
      health: memory.contradiction ? "contradiction" : memory.stale ? "stale" : memory.duplicate ? "duplicate" : memory.orphan ? "orphan" : "healthy",
      updatedAt: memory.source_updated_at
    })
    if (memory.source_agent) {
      const agentId = `agent:${memory.source_agent}`
      addNode({ id: agentId, type: "agent", label: memory.source_agent })
      if (memory.source_session_id) {
        const sessionId = `session:${memory.source_session_id}`
        addNode({ id: sessionId, type: "session", label: memory.source_session_id.slice(0, 8), sessionId: memory.source_session_id })
        addEdge({ id: `${agentId}->${sessionId}`, source: agentId, target: sessionId, type: "produced-session" })
        addEdge({ id: `${sessionId}->${id}`, source: sessionId, target: id, type: "produced-memory" })
      } else {
        addEdge({ id: `${agentId}->${id}`, source: agentId, target: id, type: "produced-memory" })
      }
    }
    const entities = Array.isArray(memory.frontmatter?.entities) ? memory.frontmatter.entities : []
    for (const entity of entities) {
      if (typeof entity !== "string" || !visibleEntities.has(entity.trim())) continue
      const normalized = entity.trim()
      const entityId = `entity:${normalized.toLowerCase()}`
      addNode({ id: entityId, type: "entity", label: normalized, frequency: entityFrequency.get(normalized) || 1 })
      addEdge({ id: `${id}->${entityId}`, source: id, target: entityId, type: "entity" })
    }
  }

  for (const agent of raw.configuredAgents || []) {
    const observedKind = agent.observedAgentKind || agent.name
    const agentId = `agent:${observedKind}`
    const current = nodes.get(agentId) || {}
    nodes.set(agentId, {
      ...current,
      id: agentId,
      type: "agent",
      label: agent.name,
      configured: true,
      enabled: agent.enabled,
      provider: agent.provider,
      model: agent.model,
      observedAgentKind: observedKind
    })
  }

  for (const session of raw.sessions) {
    const agentId = `agent:${session.agent_kind}`
    const sessionId = `session:${session.session_id}`
    addNode({ id: agentId, type: "agent", label: session.agent_kind })
    addNode({ id: sessionId, type: "session", label: session.session_id.slice(0, 8), sessionId: session.session_id, observations: Number(session.observation_count || 0) })
    addEdge({ id: `${agentId}->${sessionId}`, source: agentId, target: sessionId, type: "produced-session" })
  }

  for (const relation of raw.relations) {
    const source = memoryIds.get(relation.from_path)
    if (!source) continue
    let target = relation.to_workspace === raw.memories[0]?.workspace && relation.to_project === raw.memories[0]?.project ? memoryIds.get(relation.to_path) : null
    if (!target) {
      target = `external:${relation.to_workspace}:${relation.to_project}:${relation.to_path}`
      addNode({ id: target, type: "external", label: relation.to_path, workspace: relation.to_workspace, project: relation.to_project })
    }
    addEdge({ id: `${source}->${target}:${relation.relation_type}`, source, target, type: relation.relation_type, resolved: relation.resolved })
  }

  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(new Map(edges.map(edge => [edge.id, edge])).values())
  }
}

export const createServer = () => http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {})
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      await repository.ping()
      return send(res, 200, { status: "ok", database: "ok", credentialVault: integrationService.vaultStatus() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/scopes") {
      return send(res, 200, { scopes: await repository.scopes() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/summary") {
      const { workspace, project } = requiredScope(url)
      return send(res, 200, await repository.summary(workspace, project))
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/health") {
      const { workspace, project } = requiredScope(url)
      return send(res, 200, await repository.health(workspace, project))
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/agents") {
      const { workspace, project } = requiredScope(url)
      const [agents, clients] = await Promise.all([repository.agents(workspace, project), repository.clients()])
      return send(res, 200, { agents, clients })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/memories") {
      const { workspace, project } = requiredScope(url)
      const limit = clamp(url.searchParams.get("limit"), 100, 1, 500)
      const offset = clamp(url.searchParams.get("offset"), 0, 0, 1000000)
      return send(res, 200, { memories: await repository.memories(workspace, project, limit, offset) })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/memory") {
      const { workspace, project } = requiredScope(url)
      const path = url.searchParams.get("path")?.trim()
      if (!path) return send(res, 400, { error: "path is required" })
      const memory = await repository.memory(workspace, project, path)
      return memory ? send(res, 200, memory) : send(res, 404, { error: "memory not found" })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/brain") {
      const { workspace, project } = requiredScope(url)
      const limit = clamp(url.searchParams.get("limit"), config.brainNodeLimit, 50, 2000)
      const [brainData, configuredAgents] = await Promise.all([repository.brain(workspace, project, limit), integrationService.agents()])
      brainData.configuredAgents = configuredAgents.filter(agent => (!agent.workspace || agent.workspace === workspace) && (!agent.project || agent.project === project))
      return send(res, 200, buildBrain(brainData))
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/retrieval-traces") {
      const { workspace, project } = requiredScope(url)
      const limit = clamp(url.searchParams.get("limit"), 30, 1, 200)
      return send(res, 200, { traces: await repository.recentTraces(workspace, project, limit) })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/handoffs") {
      const { workspace, project } = requiredScope(url)
      const limit = clamp(url.searchParams.get("limit"), 50, 1, 300)
      return send(res, 200, { handoffs: await repository.handoffs(workspace, project, limit) })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/activity") {
      const { workspace, project } = requiredScope(url)
      const limit = clamp(url.searchParams.get("limit"), 50, 1, 300)
      return send(res, 200, { events: await repository.activity(workspace, project, limit) })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/evolution") {
      const { workspace, project } = requiredScope(url)
      const path = url.searchParams.get("path")?.trim()
      const limit = clamp(url.searchParams.get("limit"), 50, 1, 300)
      if (!path) return send(res, 400, { error: "path is required" })
      return send(res, 200, { versions: await repository.evolution(workspace, project, path, limit) })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/optimization") {
      const { workspace, project } = requiredScope(url)
      const limit = clamp(url.searchParams.get("limit"), 100, 1, 500)
      return send(res, 200, { recommendations: await repository.optimizations(workspace, project, limit) })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/sync/status") {
      return send(res, 200, { sync: await repository.latestSync() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/chat/bootstrap") {
      requireAdmin(req)
      const { workspace, project } = requiredScope(url)
      return send(res, 200, await chatService.bootstrap(workspace, project))
    }
    if (req.method === "POST" && url.pathname === "/api/v1/cognitive/chat/conversations") {
      requireAdmin(req)
      return send(res, 201, { conversation: await chatService.createConversation(await readJson(req)) })
    }
    const chatMessageMatch = url.pathname.match(/^\/api\/v1\/cognitive\/chat\/conversations\/([^/]+)\/messages$/)
    if (chatMessageMatch && req.method === "POST") {
      requireAdmin(req)
      return send(res, 200, await chatService.sendMessage(chatMessageMatch[1], await readJson(req, config.chatWorkspaceRequestMaxBytes)))
    }
    const chatCodeChangeExportMatch = url.pathname.match(/^\/api\/v1\/cognitive\/chat\/conversations\/([^/]+)\/messages\/([^/]+)\/code-change-export$/)
    if (chatCodeChangeExportMatch && req.method === "GET") {
      requireAdmin(req)
      const exported = await chatService.exportCodeChange(chatCodeChangeExportMatch[1], chatCodeChangeExportMatch[2])
      return sendBinary(res, 200, exported.content, "application/zip", exported.fileName)
    }
    const chatCodeChangeResultMatch = url.pathname.match(/^\/api\/v1\/cognitive\/chat\/conversations\/([^/]+)\/messages\/([^/]+)\/code-change-result$/)
    if (chatCodeChangeResultMatch && req.method === "POST") {
      requireAdmin(req)
      return send(res, 200, { message: await chatService.recordCodeChangeResult(chatCodeChangeResultMatch[1], chatCodeChangeResultMatch[2], await readJson(req)) })
    }
    const chatAttachmentMatch = url.pathname.match(/^\/api\/v1\/cognitive\/chat\/conversations\/([^/]+)\/attachments$/)
    if (chatAttachmentMatch && req.method === "POST") {
      requireAdmin(req)
      const fileName = url.searchParams.get("filename")?.trim() || "attachment.zip"
      const buffer = await readBuffer(req, config.chatAttachmentMaxBytes)
      return send(res, 201, { attachment: await chatService.uploadAttachment(chatAttachmentMatch[1], fileName, req.headers["content-type"], buffer) })
    }
    const chatExportMatch = url.pathname.match(/^\/api\/v1\/cognitive\/chat\/conversations\/([^/]+)\/export$/)
    if (chatExportMatch && req.method === "GET") {
      requireAdmin(req)
      const exported = await chatService.exportConversation(chatExportMatch[1])
      return sendBinary(res, 200, exported.content, "application/zip", exported.fileName)
    }
    const chatDownloadMatch = url.pathname.match(/^\/api\/v1\/cognitive\/chat\/attachments\/([^/]+)\/download$/)
    if (chatDownloadMatch && req.method === "GET") {
      requireAdmin(req)
      const attachment = await chatService.attachment(chatDownloadMatch[1])
      return sendBinary(res, 200, attachment.content, attachment.mediaType, attachment.fileName)
    }
    const chatConversationMatch = url.pathname.match(/^\/api\/v1\/cognitive\/chat\/conversations\/([^/]+)$/)
    if (chatConversationMatch && req.method === "GET") {
      requireAdmin(req)
      const { workspace, project } = requiredScope(url)
      return send(res, 200, await chatService.conversation(chatConversationMatch[1], workspace, project))
    }
    if (chatConversationMatch && req.method === "PATCH") {
      requireAdmin(req)
      return send(res, 200, { conversation: await chatService.updateConversation(chatConversationMatch[1], await readJson(req)) })
    }
    if (chatConversationMatch && req.method === "DELETE") {
      requireAdmin(req)
      return send(res, 200, await chatService.deleteConversation(chatConversationMatch[1]))
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/integrations/summary") {
      const summary = await integrationService.summary()
      return send(res, 200, { ...summary, credentialVault: integrationService.vaultStatus() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/config/agents") {
      return send(res, 200, { agents: await integrationService.agents() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/config/models") {
      return send(res, 200, { models: await integrationService.models() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/config/mcps") {
      return send(res, 200, { mcps: await integrationService.mcps() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/config/credentials") {
      return send(res, 200, { credentials: await integrationService.credentials(), vault: integrationService.vaultStatus() })
    }
    if (req.method === "GET" && url.pathname === "/api/v1/cognitive/config/audit") {
      requireAdmin(req)
      const limit = clamp(url.searchParams.get("limit"), 100, 1, 500)
      return send(res, 200, { events: await integrationService.audit(limit) })
    }
    if (req.method === "POST" && url.pathname === "/api/v1/cognitive/config/credentials") {
      requireAdmin(req)
      return send(res, 201, { credential: await integrationService.createCredential(await readJson(req)) })
    }
    const credentialId = pathId(url.pathname, "/api/v1/cognitive/config/credentials")
    if (credentialId && req.method === "PUT") {
      requireAdmin(req)
      return send(res, 200, { credential: await integrationService.rotateCredential(credentialId, await readJson(req)) })
    }
    if (credentialId && req.method === "DELETE") {
      requireAdmin(req)
      return send(res, 200, await integrationService.deleteCredential(credentialId))
    }
    if (req.method === "POST" && url.pathname === "/api/v1/cognitive/config/agents") {
      requireAdmin(req)
      return send(res, 201, { agent: await integrationService.createAgent(await readJson(req)) })
    }
    const agentStatusMatch = url.pathname.match(/^\/api\/v1\/cognitive\/config\/agents\/([^/]+)\/status$/)
    if (agentStatusMatch && req.method === "PATCH") {
      requireAdmin(req)
      const body = await readJson(req)
      return send(res, 200, { agent: await integrationService.setAgentEnabled(agentStatusMatch[1], body.enabled === true) })
    }
    const agentId = pathId(url.pathname, "/api/v1/cognitive/config/agents")
    if (agentId && req.method === "PUT") {
      requireAdmin(req)
      return send(res, 200, { agent: await integrationService.updateAgent(agentId, await readJson(req)) })
    }
    if (agentId && req.method === "DELETE") {
      requireAdmin(req)
      return send(res, 200, await integrationService.deleteAgent(agentId))
    }
    if (req.method === "POST" && url.pathname === "/api/v1/cognitive/config/mcps") {
      requireAdmin(req)
      return send(res, 201, { mcp: await integrationService.createMcp(await readJson(req)) })
    }
    const mcpStatusMatch = url.pathname.match(/^\/api\/v1\/cognitive\/config\/mcps\/([^/]+)\/status$/)
    if (mcpStatusMatch && req.method === "PATCH") {
      requireAdmin(req)
      const body = await readJson(req)
      return send(res, 200, { mcp: await integrationService.setMcpEnabled(mcpStatusMatch[1], body.enabled === true) })
    }
    const mcpId = pathId(url.pathname, "/api/v1/cognitive/config/mcps")
    if (mcpId && req.method === "PUT") {
      requireAdmin(req)
      return send(res, 200, { mcp: await integrationService.updateMcp(mcpId, await readJson(req)) })
    }
    if (mcpId && req.method === "DELETE") {
      requireAdmin(req)
      return send(res, 200, await integrationService.deleteMcp(mcpId))
    }
    if (req.method === "POST" && url.pathname === "/api/v1/cognitive/search/explain") {
      const body = await readJson(req)
      const workspace = String(body.workspace || "").trim()
      const project = String(body.project || "").trim()
      const query = String(body.query || body.q || "").trim()
      const limit = clamp(body.limit, 10, 1, 50)
      if (!workspace || !project || !query) return send(res, 400, { error: "workspace, project and query are required" })
      let embedding = null
      let vectorError = null
      try {
        embedding = await createQueryEmbedding(query)
      } catch (error) {
        vectorError = String(error?.message || error)
      }
      const hits = await core.explainedSearch(workspace, project, query, limit, embedding)
      await repository.insertRetrievalTrace(workspace, project, query, hits)
      return send(res, 200, {
        query,
        hits,
        vectorConfigured: Boolean(embedding || config.embeddingBaseUrl),
        vectorEnabled: hits.some(hit => hit.explain?.vector_rank != null),
        vectorError
      })
    }
    if (req.method === "POST" && url.pathname === "/api/v1/cognitive/sync") {
      requireAdmin(req)
      const body = await readJson(req)
      const result = await syncCognitiveReadModel({ workspace: body.workspace, project: body.project })
      return send(res, 200, result)
    }
    return send(res, 404, { error: "not found" })
  } catch (error) {
    let status = Number(error?.status || 500)
    if (error?.code === "23505") status = 409
    if (error?.code === "23503") status = 409
    if (error?.code === "23514" || error instanceof SyntaxError) status = 400
    console.error(JSON.stringify({ level: "error", event: "request_failed", method: req.method, path: url.pathname, error: String(error?.stack || error) }))
    const message = error?.expose === true ? String(error.message || error) : status >= 500 ? "internal server error" : status === 409 && error?.code === "23505" ? "a resource with this name already exists" : String(error.message || error)
    return send(res, status, { error: message })
  }
})
