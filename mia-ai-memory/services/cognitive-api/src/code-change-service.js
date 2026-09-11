import { randomUUID } from "node:crypto"
import { config } from "./config.js"

const MARKER_START = "<<<AI_MEMORY_CODE_CHANGE>>>"
const MARKER_END = "<<<END_AI_MEMORY_CODE_CHANGE>>>"

const ignoredDirectories = new Set([
  ".git", "node_modules", "dist", "build", "target", "vendor", ".next", ".nuxt", ".cache", "coverage", ".gradle", ".terraform", ".idea", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv"
])

const protectedNames = new Set([".env", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519"])
const protectedExtensions = new Set(["pem", "key", "p12", "pfx", "jks", "keystore"])

const failure = (message, status = 400) => Object.assign(new Error(message), { status, expose: true })
const normalizePath = value => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "")
const basename = path => normalizePath(path).split("/").pop() || ""
const extension = path => {
  const name = basename(path)
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index + 1).toLowerCase() : ""
}

const safePath = value => {
  const path = normalizePath(value)
  if (!path || path.startsWith("../") || path.includes("/../") || path.startsWith("/") || path.includes("\0")) throw failure(`workspace path is not allowed: ${value}`)
  const segments = path.split("/")
  if (segments.some(segment => ignoredDirectories.has(segment))) throw failure(`workspace path is ignored: ${path}`)
  const name = basename(path).toLowerCase()
  if (protectedNames.has(name) || (name.startsWith(".env.") && name !== ".env.example") || protectedExtensions.has(extension(name))) throw failure(`workspace path is protected: ${path}`)
  return path
}

const limitedText = (value, max, name) => {
  const text = String(value ?? "")
  if (text.length > max) throw failure(`${name} exceeds the allowed size`)
  return text
}

export const normalizeWorkspaceContext = input => {
  if (!input || typeof input !== "object") return null
  const rootName = limitedText(input.rootName, 180, "workspace root name").trim()
  if (!rootName) return null
  const rawManifest = Array.isArray(input.manifest) ? input.manifest : []
  const manifest = []
  const manifestSet = new Set()
  for (const value of rawManifest.slice(0, config.chatWorkspaceManifestMaxFiles)) {
    try {
      const path = safePath(value)
      if (!manifestSet.has(path)) {
        manifestSet.add(path)
        manifest.push(path)
      }
    } catch {
    }
  }

  const files = []
  let contextBytes = 0
  for (const raw of Array.isArray(input.files) ? input.files.slice(0, config.chatWorkspaceContextMaxFiles) : []) {
    if (!raw || typeof raw !== "object") continue
    let path
    try {
      path = safePath(raw.path)
    } catch {
      continue
    }
    const content = String(raw.content ?? "")
    const bytes = Buffer.byteLength(content)
    if (bytes > config.chatWorkspaceFileMaxBytes) continue
    if (contextBytes + bytes > config.chatWorkspaceContextMaxBytes) break
    files.push({
      path,
      content,
      sha256: /^[a-f0-9]{64}$/i.test(String(raw.sha256 || "")) ? String(raw.sha256).toLowerCase() : null,
      language: String(raw.language || "").slice(0, 80)
    })
    contextBytes += bytes
  }

  let activeFile = null
  try {
    if (input.activeFile) activeFile = safePath(input.activeFile)
  } catch {
    activeFile = null
  }

  return {
    rootName,
    activeFile,
    manifest,
    manifestTruncated: input.manifestTruncated === true,
    files,
    stats: {
      fileCount: Number(input.stats?.fileCount || manifest.length),
      contextFileCount: files.length,
      contextBytes
    }
  }
}

export const workspacePromptSection = workspace => {
  if (!workspace) return "No local developer workspace is connected for this turn."
  const manifest = workspace.manifest.length ? workspace.manifest.join("\n") : "No project manifest supplied."
  const files = workspace.files.length
    ? workspace.files.map(file => `FILE ${file.path}\nSHA256 ${file.sha256 || "unknown"}\nLANGUAGE ${file.language || "unknown"}\n${file.content}`).join("\n\n")
    : "No source file contents were selected for this turn."
  return [
    `LOCAL WORKSPACE ${workspace.rootName}`,
    `Active file: ${workspace.activeFile || "none"}`,
    `Project files: ${workspace.stats.fileCount}${workspace.manifestTruncated ? "+" : ""}`,
    "PROJECT MANIFEST",
    manifest,
    "SOURCE CONTEXT",
    files
  ].join("\n\n")
}

export const codeChangeInstructions = workspace => {
  if (!workspace) return ""
  return [
    "A local developer workspace is connected to this conversation.",
    "When the user explicitly asks you to create, modify, refactor, delete, fix, or implement code in that workspace, produce an executable local code-change plan in addition to your concise explanation.",
    "Do not claim that local files were already changed. The browser applies the plan after your response.",
    "Only change files for which the supplied workspace context is sufficient. If required code is missing, explain which file is needed and do not invent a destructive plan.",
    "Return complete file contents for every write operation. Never use placeholders such as omitted code, rest of file, unchanged code, TODO-only stubs, or ellipses in place of existing implementation.",
    "Do not add explanatory comments inside code unless they are required by the source language or existing project convention.",
    "Never write secrets, .env files, private keys, certificates, dependency directories, build output, or .git content.",
    "Use paths relative to the workspace root only.",
    "Allowed operations are write and delete.",
    `Append exactly one machine-readable block using these markers when code changes are ready:\n${MARKER_START}\n{\"summary\":\"short summary\",\"operations\":[{\"type\":\"write\",\"path\":\"src/example.js\",\"content\":\"complete file content\"},{\"type\":\"delete\",\"path\":\"src/obsolete.js\"}]}\n${MARKER_END}`,
    "Do not put Markdown fences around the machine-readable block. Keep it as the final part of the response."
  ].join("\n")
}

const parseBlock = content => {
  const text = String(content || "")
  const start = text.lastIndexOf(MARKER_START)
  if (start < 0) return null
  const end = text.indexOf(MARKER_END, start + MARKER_START.length)
  if (end < 0) return null
  const jsonText = text.slice(start + MARKER_START.length, end).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  const cleaned = `${text.slice(0, start)}${text.slice(end + MARKER_END.length)}`.trim()
  return { parsed, cleaned }
}

export const extractCodeChangePlan = (content, workspace) => {
  if (!workspace) return { content: String(content || "").trim(), plan: null }
  const block = parseBlock(content)
  if (!block || !block.parsed || typeof block.parsed !== "object") return { content: String(content || "").trim(), plan: null }
  const rawOperations = Array.isArray(block.parsed.operations) ? block.parsed.operations : []
  if (!rawOperations.length) return { content: block.cleaned || String(block.parsed.summary || "").trim(), plan: null }
  if (rawOperations.length > config.chatCodeChangeMaxOperations) throw failure(`code change plan exceeds ${config.chatCodeChangeMaxOperations} operations`, 502)

  const contextByPath = new Map(workspace.files.map(file => [file.path, file]))
  const manifest = new Set(workspace.manifest)
  const operations = []
  let totalBytes = 0

  for (const raw of rawOperations) {
    if (!raw || typeof raw !== "object") throw failure("code change plan contains an invalid operation", 502)
    const type = String(raw.type || "").toLowerCase()
    if (!["write", "delete"].includes(type)) throw failure(`unsupported code change operation: ${raw.type}`, 502)
    const path = safePath(raw.path)
    const source = contextByPath.get(path)
    const expectedExists = manifest.has(path)
    if (type === "write") {
      const fileContent = String(raw.content ?? "")
      const bytes = Buffer.byteLength(fileContent)
      if (bytes > config.chatCodeChangeMaxFileBytes) throw failure(`generated file exceeds the allowed size: ${path}`, 502)
      totalBytes += bytes
      if (totalBytes > config.chatCodeChangeMaxTotalBytes) throw failure("generated code change plan exceeds the allowed total size", 502)
      operations.push({ type, path, content: fileContent, baseSha256: source?.sha256 || null, expectedExists })
    } else {
      operations.push({ type, path, baseSha256: source?.sha256 || null, expectedExists })
    }
  }

  const summary = limitedText(block.parsed.summary || "Alterações de código prontas para aplicação", 500, "code change summary").trim() || "Alterações de código prontas para aplicação"
  return {
    content: block.cleaned || summary,
    plan: {
      id: randomUUID(),
      summary,
      status: "proposed",
      workspace: {
        rootName: workspace.rootName,
        activeFile: workspace.activeFile,
        fileCount: workspace.stats.fileCount,
        contextFileCount: workspace.stats.contextFileCount
      },
      operations,
      generatedAt: new Date().toISOString()
    }
  }
}
