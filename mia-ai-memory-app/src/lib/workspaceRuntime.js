const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8791"
const TOKEN_KEY = "ai-memory.workspace-runtime.token"

const baseUrl = () => String(import.meta.env.VITE_WORKSPACE_RUNTIME_URL || DEFAULT_RUNTIME_URL).replace(/\/$/, "")

const runtimeToken = () => {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) || ""
  } catch {
    return ""
  }
}

const saveRuntimeToken = token => {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token)
    else window.sessionStorage.removeItem(TOKEN_KEY)
  } catch {
  }
}

const withTimeout = async (input, options = {}, timeoutMs = 1200) => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...options, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

const responseError = async response => {
  const body = await response.json().catch(() => ({}))
  const error = new Error(body.error || `Workspace Runtime HTTP ${response.status}`)
  error.status = response.status
  error.code = body.code || "WORKSPACE_RUNTIME_ERROR"
  throw error
}

const pair = async () => {
  const response = await withTimeout(`${baseUrl()}/api/v1/runtime/pair`, { method: "POST", headers: { Accept: "application/json" } }, 1800)
  if (!response.ok) return responseError(response)
  const body = await response.json()
  saveRuntimeToken(body.token || "")
  return body
}

const request = async (path, options = {}, responseType = "json") => {
  const execute = async token => {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...options,
      headers: {
        Accept: responseType === "arrayBuffer" ? "application/octet-stream" : "application/json",
        ...(token ? { "X-AI-Memory-Workspace-Token": token } : {}),
        ...(options.headers || {})
      }
    })
    if (!response.ok) return responseError(response)
    if (responseType === "arrayBuffer") return { buffer: await response.arrayBuffer(), response }
    return response.json()
  }
  try {
    return await execute(runtimeToken())
  } catch (error) {
    if (error.status !== 401) throw error
    const paired = await pair()
    return execute(paired.token)
  }
}

const normalizePath = value => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "")
const basename = value => normalizePath(value).split("/").pop() || ""

class RuntimeWritableFile {
  constructor(handle) {
    this.handle = handle
    this.parts = []
  }

  async write(value) {
    if (typeof value === "object" && value && "type" in value) {
      if (value.type === "truncate") {
        this.parts = []
        return
      }
      if (value.type === "write") {
        this.parts.push(value.data ?? "")
        return
      }
      throw new Error(`Operação de escrita não suportada: ${value.type}`)
    }
    this.parts.push(value ?? "")
  }

  async close() {
    const blob = new Blob(this.parts)
    await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.handle.workspaceId)}/file?path=${encodeURIComponent(this.handle.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob
    })
  }

  async abort() {
    this.parts = []
  }
}

class RuntimeFileHandle {
  constructor(workspaceId, workspaceName, path) {
    this.kind = "file"
    this.workspaceId = workspaceId
    this.workspaceName = workspaceName
    this.path = normalizePath(path)
    this.name = basename(this.path)
  }

  async getFile() {
    const { buffer, response } = await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/file?path=${encodeURIComponent(this.path)}`, {}, "arrayBuffer")
    const lastModified = Number(response.headers.get("X-File-Last-Modified") || Date.now())
    return new File([buffer], this.name, { type: response.headers.get("Content-Type") || "", lastModified })
  }

  async createWritable() {
    return new RuntimeWritableFile(this)
  }

  async isSameEntry(other) {
    return Boolean(other?.kind === "file" && other?.workspaceId === this.workspaceId && other?.path === this.path)
  }
}

class RuntimeDirectoryHandle {
  constructor(workspaceId, workspaceName, path = "") {
    this.kind = "directory"
    this.workspaceId = workspaceId
    this.workspaceName = workspaceName
    this.path = normalizePath(path)
    this.name = this.path ? basename(this.path) : workspaceName || "workspace"
    this.runtime = true
  }

  async *entries() {
    const body = await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/entries?path=${encodeURIComponent(this.path)}`)
    for (const entry of body.entries || []) {
      const childPath = normalizePath(this.path ? `${this.path}/${entry.name}` : entry.name)
      if (entry.kind === "directory") yield [entry.name, new RuntimeDirectoryHandle(this.workspaceId, this.workspaceName, childPath)]
      else yield [entry.name, new RuntimeFileHandle(this.workspaceId, this.workspaceName, childPath)]
    }
  }

  async getDirectoryHandle(name, options = {}) {
    const target = normalizePath(this.path ? `${this.path}/${name}` : name)
    if (options.create) await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/directory?path=${encodeURIComponent(target)}`, { method: "POST" })
    else {
      let body
      try {
        body = await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/stat?path=${encodeURIComponent(target)}`)
      } catch (error) {
        if (error.status === 404) throw Object.assign(new Error(`Diretório não encontrado: ${target}`), { name: "NotFoundError" })
        throw error
      }
      if (body.kind !== "directory") throw Object.assign(new Error(`Caminho não é um diretório: ${target}`), { name: "TypeMismatchError" })
    }
    return new RuntimeDirectoryHandle(this.workspaceId, this.workspaceName, target)
  }

  async getFileHandle(name, options = {}) {
    const target = normalizePath(this.path ? `${this.path}/${name}` : name)
    if (options.create) {
      try {
        const body = await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/stat?path=${encodeURIComponent(target)}`)
        if (body.kind !== "file") throw Object.assign(new Error(`Caminho não é um arquivo: ${target}`), { name: "TypeMismatchError" })
      } catch (error) {
        if (error.status !== 404) throw error
        await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/file?path=${encodeURIComponent(target)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([]) })
      }
    } else {
      let body
      try {
        body = await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/stat?path=${encodeURIComponent(target)}`)
      } catch (error) {
        if (error.status === 404) throw Object.assign(new Error(`Arquivo não encontrado: ${target}`), { name: "NotFoundError" })
        throw error
      }
      if (body.kind !== "file") throw Object.assign(new Error(`Caminho não é um arquivo: ${target}`), { name: "TypeMismatchError" })
    }
    return new RuntimeFileHandle(this.workspaceId, this.workspaceName, target)
  }

  async removeEntry(name, options = {}) {
    const target = normalizePath(this.path ? `${this.path}/${name}` : name)
    await request(`/api/v1/runtime/workspaces/${encodeURIComponent(this.workspaceId)}/path?path=${encodeURIComponent(target)}&recursive=${options.recursive ? "true" : "false"}`, { method: "DELETE" })
  }

  async queryPermission() {
    return "granted"
  }

  async requestPermission() {
    return "granted"
  }

  async isSameEntry(other) {
    return Boolean(other?.kind === "directory" && other?.workspaceId === this.workspaceId && other?.path === this.path)
  }
}

export const workspaceRuntime = {
  url: baseUrl,
  async health() {
    try {
      const response = await withTimeout(`${baseUrl()}/healthz`, { headers: { Accept: "application/json" } }, 1000)
      if (!response.ok) return { available: false }
      return { available: true, ...(await response.json()) }
    } catch {
      return { available: false }
    }
  },
  async list() {
    const body = await request("/api/v1/runtime/workspaces")
    return body.workspaces || []
  },
  async pick() {
    const body = await request("/api/v1/runtime/workspaces/pick", { method: "POST" })
    return body.workspace
  },
  async registerPath(pathValue) {
    const body = await request("/api/v1/runtime/workspaces/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pathValue })
    })
    return body.workspace
  },
  open(workspaceId, name) {
    if (!workspaceId) return null
    return new RuntimeDirectoryHandle(String(workspaceId), String(name || "workspace"), "")
  },
  async gitStatus(workspaceId) {
    const body = await request(`/api/v1/runtime/workspaces/${encodeURIComponent(workspaceId)}/git/status`)
    return body.git || { repository: false, branch: "", head: "", changes: [] }
  },
  async execute(workspaceId, command) {
    const body = await request(`/api/v1/runtime/workspaces/${encodeURIComponent(workspaceId)}/terminal/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command })
    })
    return body
  },
  async poll(workspaceId, sessionId, cursor = 0) {
    return request(`/api/v1/runtime/workspaces/${encodeURIComponent(workspaceId)}/terminal/sessions/${encodeURIComponent(sessionId)}?cursor=${encodeURIComponent(cursor)}`)
  },
  async stop(workspaceId, sessionId) {
    return request(`/api/v1/runtime/workspaces/${encodeURIComponent(workspaceId)}/terminal/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  }
}

export const openRuntimeWorkspace = (workspaceId, name) => workspaceRuntime.open(workspaceId, name)
