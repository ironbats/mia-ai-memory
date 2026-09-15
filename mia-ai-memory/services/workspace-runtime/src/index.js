import http from "node:http"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFile, spawn, spawnSync } from "node:child_process"
import { URL } from "node:url"

const HOST = process.env.AI_MEMORY_WORKSPACE_RUNTIME_HOST || "127.0.0.1"
const PORT = Number.parseInt(process.env.AI_MEMORY_WORKSPACE_RUNTIME_PORT || "8791", 10)
const MAX_JSON_BYTES = 1024 * 1024
const MAX_WRITE_BYTES = 16 * 1024 * 1024
const MAX_TERMINAL_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_TERMINAL_SESSIONS = 80
const RUNTIME_DIR = path.join(os.homedir(), ".ai-memory")
const REGISTRY_FILE = process.env.AI_MEMORY_WORKSPACE_RUNTIME_REGISTRY || path.join(RUNTIME_DIR, "workspace-runtime.json")
const configuredOrigins = String(process.env.AI_MEMORY_WORKSPACE_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean)

const workspaces = new Map()
const terminals = new Map()
const terminalCwds = new Map()
const runtimeToken = crypto.randomBytes(32).toString("base64url")

const allowedOrigin = origin => {
  if (!origin) return true
  if (configuredOrigins.includes("*")) return true
  return configuredOrigins.includes(origin)
}

const corsHeaders = req => {
  const origin = req.headers.origin || ""
  return {
    "Access-Control-Allow-Origin": allowedOrigin(origin) && origin ? origin : configuredOrigins[0] || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AI-Memory-Workspace-Token, Access-Control-Request-Private-Network",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  }
}

const sendJson = (req, res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  })
  res.end(payload)
}

const sendBinary = (req, res, status, body, headers = {}) => {
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": headers.contentType || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-File-Last-Modified": String(headers.lastModified || Date.now()),
    ...headers.extra
  })
  res.end(body)
}

const failure = (message, status = 400, code = "BAD_REQUEST") => Object.assign(new Error(message), { status, code, expose: true })

const readBuffer = async (req, maxBytes) => {
  const declared = Number.parseInt(req.headers["content-length"] || "0", 10)
  if (Number.isFinite(declared) && declared > maxBytes) throw failure("request body too large", 413, "BODY_TOO_LARGE")
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw failure("request body too large", 413, "BODY_TOO_LARGE")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const readJson = async req => {
  const body = await readBuffer(req, MAX_JSON_BYTES)
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString("utf8"))
  } catch {
    throw failure("invalid JSON body", 400, "INVALID_JSON")
  }
}

const normalizeRelative = value => {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "")
  if (normalized.includes("\0") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) throw failure("invalid workspace path", 400, "INVALID_PATH")
  return normalized
}

const insideRoot = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`)

const realWorkspaceRoot = async input => {
  const requested = path.resolve(String(input || ""))
  let resolved
  try {
    resolved = await fsp.realpath(requested)
  } catch {
    throw failure("workspace path does not exist", 404, "WORKSPACE_NOT_FOUND")
  }
  const stat = await fsp.stat(resolved)
  if (!stat.isDirectory()) throw failure("workspace path is not a directory", 400, "WORKSPACE_NOT_DIRECTORY")
  return resolved
}

const resolveWorkspacePath = async (workspace, relative, options = {}) => {
  const normalized = normalizeRelative(relative)
  const candidate = path.resolve(workspace.root, normalized || ".")
  if (!insideRoot(workspace.root, candidate)) throw failure("path escapes workspace root", 403, "PATH_ESCAPE")
  if (!normalized) return workspace.root
  try {
    const resolved = await fsp.realpath(candidate)
    if (!insideRoot(workspace.root, resolved)) throw failure("symlink escapes workspace root", 403, "SYMLINK_ESCAPE")
    return resolved
  } catch (error) {
    if (error?.code === "ENOENT" && !options.allowMissing) throw failure("workspace path not found", 404, "PATH_NOT_FOUND")
    if (error?.code !== "ENOENT") throw error
    const parent = path.dirname(candidate)
    let parentReal
    try {
      parentReal = await fsp.realpath(parent)
    } catch {
      throw failure("parent directory does not exist", 404, "PARENT_NOT_FOUND")
    }
    if (!insideRoot(workspace.root, parentReal)) throw failure("path escapes workspace root", 403, "PATH_ESCAPE")
    return candidate
  }
}

const workspaceIdFor = root => crypto.createHash("sha256").update(root).digest("hex").slice(0, 24)

const persistRegistry = async () => {
  await fsp.mkdir(path.dirname(REGISTRY_FILE), { recursive: true })
  const payload = [...workspaces.values()].map(item => ({
    id: item.id,
    name: item.name,
    root: item.root,
    createdAt: item.createdAt,
    lastOpenedAt: item.lastOpenedAt
  }))
  await fsp.writeFile(REGISTRY_FILE, JSON.stringify({ version: 1, workspaces: payload }, null, 2), "utf8")
}

const registerWorkspace = async input => {
  const root = await realWorkspaceRoot(input)
  const id = workspaceIdFor(root)
  const now = new Date().toISOString()
  const existing = workspaces.get(id)
  const workspace = {
    id,
    name: path.basename(root) || "workspace",
    root,
    createdAt: existing?.createdAt || now,
    lastOpenedAt: now
  }
  workspaces.set(id, workspace)
  await persistRegistry()
  return workspace
}

const loadRegistry = async () => {
  try {
    const raw = JSON.parse(await fsp.readFile(REGISTRY_FILE, "utf8"))
    for (const item of Array.isArray(raw?.workspaces) ? raw.workspaces : []) {
      try {
        const root = await realWorkspaceRoot(item.root)
        const id = workspaceIdFor(root)
        workspaces.set(id, {
          id,
          name: path.basename(root) || item.name || "workspace",
          root,
          createdAt: item.createdAt || new Date().toISOString(),
          lastOpenedAt: item.lastOpenedAt || new Date().toISOString()
        })
      } catch {
      }
    }
  } catch {
  }
}

const workspaceById = id => {
  const workspace = workspaces.get(String(id || ""))
  if (!workspace) throw failure("workspace not registered in local runtime", 404, "WORKSPACE_NOT_REGISTERED")
  return workspace
}

const execFilePromise = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
      return
    }
    resolve(String(stdout || "").trim())
  })
})

const commandExists = command => {
  const checker = process.platform === "win32" ? "where" : "which"
  return spawnSync(checker, [command], { stdio: "ignore" }).status === 0
}

const executePicker = async (file, args) => {
  try {
    const result = await execFilePromise(file, args)
    if (!result) throw failure("folder selection cancelled", 499, "PICKER_CANCELLED")
    return result
  } catch (error) {
    if (error?.status === 499) throw error
    const detail = `${error?.stderr || ""} ${error?.message || ""}`.toLowerCase()
    if (Number(error?.code) === 1 && !/(display|gtk|qt|gui|cannot open)/i.test(detail)) throw failure("folder selection cancelled", 499, "PICKER_CANCELLED")
    return ""
  }
}

const pickDirectory = async () => {
  if (process.platform === "darwin") {
    const result = await executePicker("osascript", ["-e", "POSIX path of (choose folder with prompt \"AI Memory: selecione o projeto\")"])
    if (result) return result.replace(/\/$/, "")
    throw failure("native folder picker unavailable; register an absolute path instead", 501, "PICKER_UNAVAILABLE")
  }
  if (process.platform === "win32") {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='AI Memory: selecione o projeto'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}"
    const result = await executePicker("powershell.exe", ["-NoProfile", "-STA", "-Command", script])
    if (result) return result
    throw failure("native folder picker unavailable; register an absolute path instead", 501, "PICKER_UNAVAILABLE")
  }
  if (commandExists("zenity")) {
    const result = await executePicker("zenity", ["--file-selection", "--directory", "--title=AI Memory - Selecionar projeto"])
    if (result) return result
  }
  if (commandExists("kdialog")) {
    const result = await executePicker("kdialog", ["--getexistingdirectory", os.homedir(), "--title", "AI Memory - Selecionar projeto"])
    if (result) return result
  }
  if (commandExists("yad")) {
    const result = await executePicker("yad", ["--file-selection", "--directory", "--title=AI Memory - Selecionar projeto"])
    if (result) return result
  }
  if (commandExists("python3")) {
    const script = "import tkinter as tk; from tkinter import filedialog; r=tk.Tk(); r.withdraw(); p=filedialog.askdirectory(title='AI Memory - Selecionar projeto'); print(p); r.destroy()"
    const result = await executePicker("python3", ["-c", script])
    if (result) return result
  }
  throw failure("native folder picker unavailable; register an absolute path instead", 501, "PICKER_UNAVAILABLE")
}

const gitInfo = workspace => {
  const execute = args => spawnSync("git", ["-C", workspace.root, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 })
  const run = args => {
    const result = execute(args)
    return result.status === 0 ? String(result.stdout || "").trim() : ""
  }
  const runRaw = args => {
    const result = execute(args)
    return result.status === 0 ? String(result.stdout || "").replace(/\r?\n$/, "") : ""
  }
  const inside = run(["rev-parse", "--is-inside-work-tree"]) === "true"
  if (!inside) return { repository: false, branch: "", head: "", changes: [] }
  const branch = run(["branch", "--show-current"])
  const head = run(["rev-parse", "HEAD"])
  const porcelain = runRaw(["status", "--porcelain=v1", "-z", "-uall"])
  const records = porcelain ? porcelain.split("\0").filter(Boolean) : []
  const changes = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    const status = record.slice(0, 2)
    const item = { status, path: record.slice(3) }
    if (/[RC]/.test(status) && records[index + 1]) {
      item.sourcePath = records[index + 1]
      index += 1
    }
    changes.push(item)
  }
  return { repository: true, branch, head, changes }
}

const stripAnsi = value => String(value || "").replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")

const terminalCwdFor = workspace => {
  const current = terminalCwds.get(workspace.id) || ""
  const resolved = path.resolve(workspace.root, current || ".")
  return insideRoot(workspace.root, resolved) ? resolved : workspace.root
}

const relativeCwd = (workspace, absolute) => {
  const rel = path.relative(workspace.root, absolute).replace(/\\/g, "/")
  return rel === "." ? "" : rel
}

const parseCdTarget = command => {
  const match = String(command || "").trim().match(/^cd(?:\s+(.+))?$/)
  if (!match) return null
  const raw = String(match[1] || "").trim()
  if (!raw || raw === "~") return ""
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1)
  return raw
}

const pruneTerminalSessions = () => {
  const values = [...terminals.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  for (const item of values.slice(MAX_TERMINAL_SESSIONS)) {
    if (item.running) continue
    terminals.delete(item.id)
  }
}

const startTerminalCommand = async (workspace, command) => {
  const normalized = String(command || "").trim()
  if (!normalized) throw failure("command is required", 400, "COMMAND_REQUIRED")
  const currentCwd = terminalCwdFor(workspace)
  const cdTarget = parseCdTarget(normalized)
  if (cdTarget !== null) {
    const requested = cdTarget ? path.resolve(currentCwd, cdTarget) : workspace.root
    let resolved
    try {
      resolved = await fsp.realpath(requested)
    } catch {
      throw failure("directory does not exist", 404, "DIRECTORY_NOT_FOUND")
    }
    if (!insideRoot(workspace.root, resolved)) throw failure("terminal cannot leave workspace root", 403, "TERMINAL_PATH_ESCAPE")
    const stat = await fsp.stat(resolved)
    if (!stat.isDirectory()) throw failure("target is not a directory", 400, "NOT_DIRECTORY")
    terminalCwds.set(workspace.id, relativeCwd(workspace, resolved))
    return {
      id: `builtin-${crypto.randomUUID()}`,
      command: normalized,
      cwd: relativeCwd(workspace, resolved),
      running: false,
      exitCode: 0,
      output: "",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      builtin: true
    }
  }

  const id = crypto.randomUUID()
  const shell = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/bash")
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", normalized] : ["-lc", normalized]
  const child = spawn(shell, args, {
    cwd: currentCwd,
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  })
  const session = {
    id,
    workspaceId: workspace.id,
    command: normalized,
    cwd: relativeCwd(workspace, currentCwd),
    running: true,
    exitCode: null,
    signal: null,
    output: "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    pid: child.pid,
    child
  }
  const append = chunk => {
    session.output += stripAnsi(chunk.toString("utf8"))
    if (Buffer.byteLength(session.output, "utf8") > MAX_TERMINAL_OUTPUT_BYTES) session.output = session.output.slice(-MAX_TERMINAL_OUTPUT_BYTES)
  }
  child.stdout.on("data", append)
  child.stderr.on("data", append)
  child.on("error", error => append(`${error.message || error}\n`))
  child.on("close", (code, signal) => {
    session.running = false
    session.exitCode = Number.isInteger(code) ? code : null
    session.signal = signal || null
    session.endedAt = new Date().toISOString()
    session.child = null
    pruneTerminalSessions()
  })
  terminals.set(id, session)
  pruneTerminalSessions()
  return session
}

const terminalPayload = (session, cursor = 0) => {
  const safeCursor = Math.max(0, Math.min(Number(cursor || 0), session.output.length))
  return {
    id: session.id,
    command: session.command,
    cwd: session.cwd,
    running: session.running,
    exitCode: session.exitCode,
    signal: session.signal,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    output: session.output.slice(safeCursor),
    nextCursor: session.output.length,
    pid: session.pid || null
  }
}

const stopTerminal = session => {
  if (!session?.running || !session.child) return false
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(session.pid), "/T", "/F"], { stdio: "ignore" })
    else process.kill(-session.pid, "SIGTERM")
    return true
  } catch {
    try {
      session.child.kill("SIGTERM")
      return true
    } catch {
      return false
    }
  }
}

const authenticated = req => {
  const token = String(req.headers["x-ai-memory-workspace-token"] || "")
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")
  const candidate = Buffer.from(token || bearer || "")
  const expected = Buffer.from(runtimeToken)
  if (candidate.length !== expected.length) return false
  return crypto.timingSafeEqual(candidate, expected)
}

await loadRegistry()

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedOrigin(req.headers.origin || "")) throw failure("origin not allowed", 403, "ORIGIN_NOT_ALLOWED")
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req))
      res.end()
      return
    }
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`)
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(req, res, 200, { status: "ok", service: "ai-memory-workspace-runtime", version: "1.0.0", workspaces: workspaces.size, terminal: true, picker: true })
    }
    if (req.method === "POST" && url.pathname === "/api/v1/runtime/pair") {
      return sendJson(req, res, 200, { token: runtimeToken, runtime: { version: "1.0.0", host: HOST, port: PORT, terminal: true, picker: true } })
    }
    if (!authenticated(req)) throw failure("workspace runtime authorization required", 401, "UNAUTHORIZED")

    if (req.method === "GET" && url.pathname === "/api/v1/runtime/workspaces") {
      return sendJson(req, res, 200, { workspaces: [...workspaces.values()].map(item => ({ ...item, git: gitInfo(item) })) })
    }
    if (req.method === "POST" && url.pathname === "/api/v1/runtime/workspaces/pick") {
      const selected = await pickDirectory()
      const workspace = await registerWorkspace(selected)
      return sendJson(req, res, 201, { workspace: { ...workspace, git: gitInfo(workspace) } })
    }
    if (req.method === "POST" && url.pathname === "/api/v1/runtime/workspaces/register") {
      const body = await readJson(req)
      if (!body.path) throw failure("path is required", 400, "PATH_REQUIRED")
      const workspace = await registerWorkspace(body.path)
      return sendJson(req, res, 201, { workspace: { ...workspace, git: gitInfo(workspace) } })
    }

    const workspaceMatch = url.pathname.match(/^\/api\/v1\/runtime\/workspaces\/([^/]+)(.*)$/)
    if (!workspaceMatch) throw failure("not found", 404, "NOT_FOUND")
    const workspace = workspaceById(decodeURIComponent(workspaceMatch[1]))
    const suffix = workspaceMatch[2] || ""
    workspace.lastOpenedAt = new Date().toISOString()

    if (req.method === "GET" && suffix === "") return sendJson(req, res, 200, { workspace: { ...workspace, git: gitInfo(workspace) } })
    if (req.method === "DELETE" && suffix === "") {
      workspaces.delete(workspace.id)
      terminalCwds.delete(workspace.id)
      await persistRegistry()
      return sendJson(req, res, 200, { removed: true })
    }
    if (req.method === "GET" && suffix === "/git/status") return sendJson(req, res, 200, { git: gitInfo(workspace) })
    if (req.method === "GET" && suffix === "/stat") {
      const target = await resolveWorkspacePath(workspace, url.searchParams.get("path") || "")
      const stat = await fsp.stat(target)
      return sendJson(req, res, 200, { kind: stat.isDirectory() ? "directory" : "file", size: stat.size, lastModified: stat.mtimeMs })
    }
    if (req.method === "GET" && suffix === "/entries") {
      const target = await resolveWorkspacePath(workspace, url.searchParams.get("path") || "")
      const stat = await fsp.stat(target)
      if (!stat.isDirectory()) throw failure("path is not a directory", 400, "NOT_DIRECTORY")
      const entries = await fsp.readdir(target, { withFileTypes: true })
      return sendJson(req, res, 200, { entries: entries.filter(item => item.isDirectory() || item.isFile()).map(item => ({ name: item.name, kind: item.isDirectory() ? "directory" : "file" })) })
    }
    if (req.method === "POST" && suffix === "/directory") {
      const target = await resolveWorkspacePath(workspace, url.searchParams.get("path") || "", { allowMissing: true })
      await fsp.mkdir(target, { recursive: true })
      return sendJson(req, res, 201, { created: true })
    }
    if (suffix === "/file" && req.method === "GET") {
      const target = await resolveWorkspacePath(workspace, url.searchParams.get("path") || "")
      const stat = await fsp.stat(target)
      if (!stat.isFile()) throw failure("path is not a file", 400, "NOT_FILE")
      const body = await fsp.readFile(target)
      return sendBinary(req, res, 200, body, { lastModified: stat.mtimeMs })
    }
    if (suffix === "/file" && req.method === "PUT") {
      const target = await resolveWorkspacePath(workspace, url.searchParams.get("path") || "", { allowMissing: true })
      const body = await readBuffer(req, MAX_WRITE_BYTES)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, body)
      return sendJson(req, res, 200, { written: true, bytes: body.length })
    }
    if (suffix === "/path" && req.method === "DELETE") {
      const target = await resolveWorkspacePath(workspace, url.searchParams.get("path") || "")
      if (target === workspace.root) throw failure("workspace root cannot be deleted", 403, "ROOT_DELETE_DENIED")
      const stat = await fsp.lstat(target)
      if (stat.isDirectory()) await fsp.rm(target, { recursive: url.searchParams.get("recursive") === "true", force: false })
      else await fsp.unlink(target)
      return sendJson(req, res, 200, { removed: true })
    }
    if (suffix === "/terminal/commands" && req.method === "POST") {
      const body = await readJson(req)
      const session = await startTerminalCommand(workspace, body.command)
      return sendJson(req, res, 201, { session: terminalPayload(session, 0), cwd: terminalCwds.get(workspace.id) || "" })
    }
    const terminalMatch = suffix.match(/^\/terminal\/sessions\/([^/]+)$/)
    if (terminalMatch && req.method === "GET") {
      const session = terminals.get(terminalMatch[1])
      if (!session || session.workspaceId !== workspace.id) throw failure("terminal session not found", 404, "TERMINAL_NOT_FOUND")
      return sendJson(req, res, 200, { session: terminalPayload(session, Number(url.searchParams.get("cursor") || 0)), cwd: terminalCwds.get(workspace.id) || "" })
    }
    if (terminalMatch && req.method === "DELETE") {
      const session = terminals.get(terminalMatch[1])
      if (!session || session.workspaceId !== workspace.id) throw failure("terminal session not found", 404, "TERMINAL_NOT_FOUND")
      return sendJson(req, res, 200, { stopped: stopTerminal(session) })
    }

    throw failure("not found", 404, "NOT_FOUND")
  } catch (error) {
    const status = Number(error?.status || 500)
    const expose = error?.expose || status < 500
    sendJson(req, res, status, { error: expose ? error.message || String(error) : "workspace runtime failed", code: error?.code || "WORKSPACE_RUNTIME_FAILED" })
  }
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`AI Memory Workspace Runtime: http://${HOST}:${PORT}\n`)
  process.stdout.write(`Registered workspaces: ${workspaces.size}\n`)
})

const shutdown = () => {
  for (const session of terminals.values()) stopTerminal(session)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
