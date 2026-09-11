import { config } from "./config.js"

const headers = () => {
  const value = { Accept: "application/json" }
  if (config.coreToken) value.Authorization = `Bearer ${config.coreToken}`
  return value
}

const responseBody = async response => {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

const request = async (path, options = {}) => {
  const response = await fetch(`${config.coreBaseUrl}${path}`, {
    ...options,
    headers: {
      ...headers(),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeoutMs || 15000)
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`ai-memory core ${response.status} ${path}: ${body.slice(0, 500)}`)
  }
  return response.json()
}

const esc = value => encodeURIComponent(value)
const escPath = value => value.split("/").map(esc).join("/")

const hookEventUrl = (event, options) => {
  const base = config.coreHookUrl.endsWith("/batch") ? config.coreHookUrl.slice(0, -6) : config.coreHookUrl
  const url = new URL(base)
  url.searchParams.set("event", event)
  url.searchParams.set("agent", options.agent || "other")
  url.searchParams.set("workspace", options.workspace)
  url.searchParams.set("project", options.project)
  url.searchParams.set("session_id", options.sessionId)
  url.searchParams.set("cwd", options.cwd)
  url.searchParams.set("ingest_key", options.ingestKey)
  if (options.extension) url.searchParams.set("extension", options.extension)
  if (options.sourceEvent) url.searchParams.set("source_event", options.sourceEvent)
  return url.toString()
}

const captureBatch = async ({ workspace, project, agent, sessionId, model, userPrompt, assistantResponse }) => {
  const cwd = `/web-chat/${project}`
  const base = { workspace, project, agent, sessionId, cwd }
  const events = [
    {
      url: hookEventUrl("session-start", { ...base, ingestKey: `${sessionId}:start` }),
      body: { session_id: sessionId, cwd, model }
    },
    {
      url: hookEventUrl("user-prompt", { ...base, ingestKey: `${sessionId}:user` }),
      body: { session_id: sessionId, cwd, prompt: userPrompt, model }
    },
    {
      url: hookEventUrl("assistant-response", { ...base, ingestKey: `${sessionId}:assistant`, extension: "ai-memory-web-chat", sourceEvent: "assistant-response" }),
      body: { session_id: sessionId, cwd, body: assistantResponse, message: assistantResponse, model }
    },
    {
      url: hookEventUrl("session-end", { ...base, ingestKey: `${sessionId}:end` }),
      body: { session_id: sessionId, cwd, model }
    }
  ]
  const response = await fetch(config.coreHookUrl, {
    method: "POST",
    headers: {
      ...headers(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(events),
    signal: AbortSignal.timeout(30000)
  })
  const body = await responseBody(response)
  if (!response.ok) {
    const detail = String(body?.error || body?.raw || "hook capture failed").slice(0, 500)
    throw new Error(`ai-memory hook ${response.status}: ${detail}`)
  }
  return body
}

export const core = {
  workspaces: () => request("/workspaces"),
  projects: workspace => request(`/projects?workspace=${esc(workspace)}`),
  pages: (workspace, project) => request(`/workspaces/${esc(workspace)}/projects/${esc(project)}/pages`),
  page: (workspace, project, path) => request(`/workspaces/${esc(workspace)}/projects/${esc(project)}/pages/${escPath(path)}`),
  overview: (workspace, project) => request(`/workspaces/${esc(workspace)}/projects/${esc(project)}/overview?limit=100`),
  contradictions: (workspace, project) => request(`/workspaces/${esc(workspace)}/projects/${esc(project)}/contradictions`),
  sessions: (workspace, project, limit, offset) => request(`/workspaces/${esc(workspace)}/projects/${esc(project)}/sessions?include_open=true&limit=${limit}&offset=${offset}`),
  handoffs: (workspace, project) => request(`/workspaces/${esc(workspace)}/projects/${esc(project)}/handoffs?limit=200`),
  graph: () => request("/graph"),
  activity: () => request("/activity"),
  explainedSearch: (workspace, project, query, limit, embedding) => request(`/workspaces/${esc(workspace)}/projects/${esc(project)}/search/explain`, {
    method: "POST",
    body: JSON.stringify({
      q: query,
      limit,
      query_vector: embedding?.vector,
      embedding_provider: embedding?.provider,
      embedding_model: embedding?.model,
      embedding_dim: embedding?.dim
    })
  }),
  captureBatch
}
