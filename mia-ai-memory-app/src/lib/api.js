import { promptValue } from "./dialogService.js"

const request = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return body
}

const storedAdminToken = () => window.sessionStorage.getItem("cognitive-admin-token") || ""

const askAdminToken = async () => {
  const token = await promptValue({
    tone: "secure",
    title: "Autorizar ação administrativa",
    description: "Esta operação exige o token administrativo do Cognitive API. O valor será mantido apenas nesta sessão do navegador.",
    detail: "COGNITIVE_ADMIN_TOKEN",
    inputLabel: "Token administrativo",
    inputType: "password",
    placeholder: "Informe o token",
    confirmLabel: "Autorizar"
  })
  if (token) window.sessionStorage.setItem("cognitive-admin-token", token)
  return token
}

const adminRequest = async (path, options = {}) => {
  const execute = token => request(path, {
    ...options,
    headers: {
      ...(token ? { "X-Admin-Token": token } : {}),
      ...(options.headers || {})
    }
  })
  try {
    return await execute(storedAdminToken())
  } catch (error) {
    if (error.status !== 403) throw error
    const token = await askAdminToken()
    if (!token) throw error
    return execute(token)
  }
}

const rawAdminRequest = async (path, options = {}) => {
  const execute = async token => {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(token ? { "X-Admin-Token": token } : {}),
        ...(options.headers || {})
      }
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const error = new Error(body.error || `HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    return response
  }
  try {
    return await execute(storedAdminToken())
  } catch (error) {
    if (error.status !== 403) throw error
    const token = await askAdminToken()
    if (!token) throw error
    return execute(token)
  }
}

const scopeQuery = scope => `workspace=${encodeURIComponent(scope.workspace)}&project=${encodeURIComponent(scope.project)}`

const downloadName = (response, fallback) => {
  const disposition = response.headers.get("Content-Disposition") || ""
  const match = disposition.match(/filename="([^"]+)"/i)
  return match?.[1] || fallback
}

export const api = {
  scopes: () => request("/api/v1/cognitive/scopes"),
  summary: scope => request(`/api/v1/cognitive/summary?${scopeQuery(scope)}`),
  brain: (scope, limit = 320) => request(`/api/v1/cognitive/brain?${scopeQuery(scope)}&limit=${limit}`),
  health: scope => request(`/api/v1/cognitive/health?${scopeQuery(scope)}`),
  agents: scope => request(`/api/v1/cognitive/agents?${scopeQuery(scope)}`),
  memories: (scope, limit = 100, offset = 0) => request(`/api/v1/cognitive/memories?${scopeQuery(scope)}&limit=${limit}&offset=${offset}`),
  memory: (scope, path) => request(`/api/v1/cognitive/memory?${scopeQuery(scope)}&path=${encodeURIComponent(path)}`),
  traces: (scope, limit = 30) => request(`/api/v1/cognitive/retrieval-traces?${scopeQuery(scope)}&limit=${limit}`),
  handoffs: (scope, limit = 50) => request(`/api/v1/cognitive/handoffs?${scopeQuery(scope)}&limit=${limit}`),
  activity: (scope, limit = 50) => request(`/api/v1/cognitive/activity?${scopeQuery(scope)}&limit=${limit}`),
  evolution: (scope, path, limit = 50) => request(`/api/v1/cognitive/evolution?${scopeQuery(scope)}&path=${encodeURIComponent(path)}&limit=${limit}`),
  optimization: (scope, limit = 100) => request(`/api/v1/cognitive/optimization?${scopeQuery(scope)}&limit=${limit}`),
  search: (scope, query, limit = 10) => request("/api/v1/cognitive/search/explain", {
    method: "POST",
    body: JSON.stringify({ ...scope, query, limit })
  }),
  sync: scope => adminRequest("/api/v1/cognitive/sync", {
    method: "POST",
    body: JSON.stringify(scope || {})
  }),
  integrationsSummary: () => request("/api/v1/cognitive/integrations/summary"),
  configAgents: () => request("/api/v1/cognitive/config/agents"),
  configModels: () => request("/api/v1/cognitive/config/models"),
  createConfigAgent: payload => adminRequest("/api/v1/cognitive/config/agents", { method: "POST", body: JSON.stringify(payload) }),
  updateConfigAgent: (id, payload) => adminRequest(`/api/v1/cognitive/config/agents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }),
  setConfigAgentEnabled: (id, enabled) => adminRequest(`/api/v1/cognitive/config/agents/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  deleteConfigAgent: id => adminRequest(`/api/v1/cognitive/config/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  configMcps: () => request("/api/v1/cognitive/config/mcps"),
  createConfigMcp: payload => adminRequest("/api/v1/cognitive/config/mcps", { method: "POST", body: JSON.stringify(payload) }),
  updateConfigMcp: (id, payload) => adminRequest(`/api/v1/cognitive/config/mcps/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }),
  setConfigMcpEnabled: (id, enabled) => adminRequest(`/api/v1/cognitive/config/mcps/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  deleteConfigMcp: id => adminRequest(`/api/v1/cognitive/config/mcps/${encodeURIComponent(id)}`, { method: "DELETE" }),
  configCredentials: () => request("/api/v1/cognitive/config/credentials"),
  createCredential: payload => adminRequest("/api/v1/cognitive/config/credentials", { method: "POST", body: JSON.stringify(payload) }),
  rotateCredential: (id, payload) => adminRequest(`/api/v1/cognitive/config/credentials/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteCredential: id => adminRequest(`/api/v1/cognitive/config/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }),
  chatBootstrap: scope => adminRequest(`/api/v1/cognitive/chat/bootstrap?${scopeQuery(scope)}`),
  chatConversation: (id, scope) => adminRequest(`/api/v1/cognitive/chat/conversations/${encodeURIComponent(id)}?${scopeQuery(scope)}`),
  createChatConversation: payload => adminRequest("/api/v1/cognitive/chat/conversations", { method: "POST", body: JSON.stringify(payload) }),
  updateChatConversation: (id, payload) => adminRequest(`/api/v1/cognitive/chat/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteChatConversation: id => adminRequest(`/api/v1/cognitive/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  sendChatMessage: (id, payload) => adminRequest(`/api/v1/cognitive/chat/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify(payload) }),
  reportChatCodeChange: (conversationId, messageId, payload) => adminRequest(`/api/v1/cognitive/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/code-change-result`, { method: "POST", body: JSON.stringify(payload) }),
  uploadChatAttachment: async (conversationId, file) => {
    const response = await rawAdminRequest(`/api/v1/cognitive/chat/conversations/${encodeURIComponent(conversationId)}/attachments?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/zip", Accept: "application/json" },
      body: file
    })
    return response.json()
  },
  downloadChatAttachment: async (id, fallbackName = "attachment.zip") => {
    const response = await rawAdminRequest(`/api/v1/cognitive/chat/attachments/${encodeURIComponent(id)}/download`, { headers: { Accept: "application/zip" } })
    return { blob: await response.blob(), fileName: downloadName(response, fallbackName) }
  },
  exportChatConversation: async (id, fallbackName = "conversation.zip") => {
    const response = await rawAdminRequest(`/api/v1/cognitive/chat/conversations/${encodeURIComponent(id)}/export`, { headers: { Accept: "application/zip" } })
    return { blob: await response.blob(), fileName: downloadName(response, fallbackName) }
  }
}
