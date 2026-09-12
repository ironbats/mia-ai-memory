import { createHash } from "node:crypto"
import path from "node:path"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import { config } from "./config.js"

const failure = (message, status = 400) => Object.assign(new Error(message), { status, expose: true })

const textExtensions = new Set([
  ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv", ".dart", ".ex", ".exs", ".go", ".gradle",
  ".graphql", ".groovy", ".h", ".hpp", ".hrl", ".html", ".http", ".ini", ".java", ".js", ".json",
  ".jsx", ".kt", ".kts", ".lock", ".lua", ".md", ".mjs", ".mod", ".mts", ".php", ".pl", ".properties",
  ".proto", ".py", ".r", ".rb", ".rs", ".scala", ".scss", ".sh", ".sol", ".sql", ".sum", ".svelte",
  ".swift", ".tf", ".tfvars", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".zig"
])

const textNames = new Set([
  "agents.md", "cargo.toml", "claude.md", "cmakelists.txt", "composer.json", "dockerfile", "gemfile", "go.mod",
  "go.sum", "gradle.properties", "makefile", "package-lock.json", "package.json", "pnpm-lock.yaml", "procfile",
  "pyproject.toml", "rakefile", "readme", "requirements.txt", "settings.gradle", "settings.gradle.kts", "yarn.lock"
])
const priorityNames = new Set([
  "agents.md", "cargo.toml", "claude.md", "composer.json", "docker-compose.yml", "docker-compose.yaml", "dockerfile",
  "go.mod", "go.sum", "package-lock.json", "package.json", "pnpm-lock.yaml", "pom.xml", "pyproject.toml", "readme.md",
  "requirements.txt", "settings.gradle", "settings.gradle.kts", "vite.config.js", "vite.config.ts", "yarn.lock"
])
const ignoredSegments = new Set([
  ".cache", ".git", ".gradle", ".idea", ".next", ".nuxt", ".pytest_cache", ".terraform", ".turbo", ".venv",
  ".vscode", "__pycache__", "build", "coverage", "dist", "node_modules", "target", "vendor", "venv"
])
const sourceSegments = new Set(["app", "cmd", "components", "crates", "internal", "lib", "pkg", "server", "services", "src"])
const queryStopWords = new Set([
  "para", "com", "sem", "que", "uma", "uns", "das", "dos", "por", "the", "and", "for", "with", "from", "this",
  "that", "como", "isso", "essa", "esse", "faca", "fazer", "preciso", "quero", "arquivo", "arquivos", "projeto"
])
const localSignature = 0x04034b50
const centralSignature = 0x02014b50
const eocdSignature = 0x06054b50

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  return value >>> 0
})

const crc32 = buffer => {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const normalizedEntryName = value => {
  const name = String(value || "").replaceAll("\\", "/")
  if (!name || name.startsWith("/") || /^[A-Za-z]:\//.test(name)) throw failure("ZIP contains an unsafe path")
  const segments = name.split("/").filter(Boolean)
  if (!segments.length || segments.some(segment => segment === ".." || segment === ".")) throw failure("ZIP contains an unsafe path")
  return segments.join("/") + (name.endsWith("/") ? "/" : "")
}

const ignoredPath = name => name.toLowerCase().split("/").some(segment => ignoredSegments.has(segment))

const shouldReadText = name => {
  if (ignoredPath(name)) return false
  const base = path.posix.basename(name).toLowerCase()
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return false
  const extension = path.posix.extname(base)
  return textExtensions.has(extension) || textNames.has(base) || [...textNames].some(prefix => base.startsWith(`${prefix}.`))
}

const binaryLike = buffer => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (!sample.length) return false
  let nul = 0
  for (const byte of sample) if (byte === 0) nul += 1
  return nul > 0 || nul / sample.length > 0.01
}

const safeFileName = value => {
  const base = path.posix.basename(String(value || "attachment.zip").replaceAll("\\", "/"))
  return base.replace(/[^A-Za-z0-9._() -]+/g, "_").slice(0, 180) || "attachment.zip"
}

const archiveRootName = value => {
  const name = safeFileName(value).replace(/\.zip$/i, "").trim()
  return name || "attached-project"
}

const findEocd = buffer => {
  const minimum = Math.max(0, buffer.length - 65557)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) return offset
  }
  throw failure("ZIP central directory was not found")
}

const readEntries = buffer => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw failure("ZIP is empty or invalid")
  if (buffer.length > config.chatAttachmentMaxBytes) throw failure(`ZIP exceeds ${Math.round(config.chatAttachmentMaxBytes / 1024 / 1024)} MB`, 413)
  if (buffer.readUInt32LE(0) !== localSignature && buffer.readUInt32LE(0) !== eocdSignature) throw failure("only ZIP attachments are supported")

  const eocd = findEocd(buffer)
  const disk = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const diskEntries = buffer.readUInt16LE(eocd + 8)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const commentLength = buffer.readUInt16LE(eocd + 20)

  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw failure("multi-disk ZIP files are not supported")
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw failure("ZIP64 attachments are not supported")
  if (totalEntries > config.chatZipMaxEntries) throw failure(`ZIP has more than ${config.chatZipMaxEntries} entries`, 413)
  if (eocd + 22 + commentLength > buffer.length || centralOffset + centralSize > eocd) throw failure("ZIP directory is malformed")

  let offset = centralOffset
  let totalUncompressed = 0
  const entries = []
  const seenNames = new Set()
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== centralSignature) throw failure("ZIP directory entry is malformed")
    const versionMadeBy = buffer.readUInt16LE(offset + 4)
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const entryCommentLength = buffer.readUInt16LE(offset + 32)
    const diskStart = buffer.readUInt16LE(offset + 34)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + entryCommentLength
    if (end > buffer.length || localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw failure("ZIP64 entries are not supported")
    if (diskStart !== 0) throw failure("multi-disk ZIP entries are not supported")
    if ((flags & 0x1) !== 0) throw failure("encrypted ZIP entries are not supported")
    if (![0, 8].includes(method)) throw failure(`ZIP compression method ${method} is not supported`)

    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength)
    const name = normalizedEntryName(rawName.toString((flags & 0x0800) !== 0 ? "utf8" : "latin1"))
    if (seenNames.has(name)) throw failure(`ZIP contains a duplicate path: ${name}`)
    seenNames.add(name)
    const unixMode = (versionMadeBy >>> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : 0
    if ((unixMode & 0o170000) === 0o120000) throw failure("ZIP symbolic links are not supported")

    const directory = name.endsWith("/")
    totalUncompressed += directory ? 0 : uncompressedSize
    if (totalUncompressed > config.chatZipMaxUncompressedBytes) throw failure("ZIP uncompressed size exceeds the configured limit", 413)
    entries.push({ name, directory, method, crc, compressedSize, uncompressedSize, localOffset })
    offset = end
  }
  if (offset > centralOffset + centralSize) throw failure("ZIP central directory size is inconsistent")
  return { entries, totalUncompressed }
}

const readEntryData = (buffer, entry, maxOutputBytes) => {
  if (entry.directory) return Buffer.alloc(0)
  if (entry.uncompressedSize > maxOutputBytes) throw failure("ZIP entry exceeds the permitted contextual size", 413)
  const offset = entry.localOffset
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== localSignature) throw failure("ZIP local entry is malformed")
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (start > buffer.length || end > buffer.length) throw failure("ZIP entry data is truncated")
  const compressed = buffer.subarray(start, end)
  let data
  try {
    data = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maxOutputBytes })
  } catch {
    throw failure("ZIP entry could not be decompressed")
  }
  if (data.length !== entry.uncompressedSize) throw failure("ZIP entry size is inconsistent")
  if (crc32(data) !== entry.crc) throw failure("ZIP entry failed integrity validation")
  return data
}

const queryTokens = value => [...new Set(String(value || "").toLowerCase().match(/[a-z0-9_.-]{3,}/g) || [])]
  .filter(token => !queryStopWords.has(token))
  .slice(0, 48)

const commonRoot = entries => {
  const roots = new Set()
  let files = 0
  for (const entry of entries) {
    if (entry.directory || ignoredPath(entry.name)) continue
    const segments = entry.name.split("/").filter(Boolean)
    if (segments.length < 2) return ""
    roots.add(segments[0])
    files += 1
    if (roots.size > 1) return ""
  }
  return files ? [...roots][0] : ""
}

const relativeEntryPath = (name, root) => root && name.startsWith(`${root}/`) ? name.slice(root.length + 1) : name

const priorityFor = (name, tokens) => {
  const lower = name.toLowerCase()
  const base = path.posix.basename(lower)
  const segments = lower.split("/")
  let score = 0
  if (priorityNames.has(base)) score += 240
  if (base.startsWith("readme")) score += 170
  if (base === "agents.md" || base === "claude.md") score += 240
  if (segments.length <= 2) score += 80
  if (segments.some(segment => sourceSegments.has(segment))) score += 55
  if (segments.some(segment => ["test", "tests", "spec", "specs", "fixtures"].includes(segment))) score -= 18
  for (const token of tokens) {
    if (lower.includes(token)) score += 130
    if (base.includes(token)) score += 90
  }
  score -= Math.min(40, Math.max(0, segments.length - 2) * 3)
  return score
}

const languageFor = name => {
  const base = path.posix.basename(name).toLowerCase()
  if (base === "dockerfile") return "dockerfile"
  const extension = path.posix.extname(base).replace(/^\./, "")
  return extension || "text"
}

const contextualize = (buffer, parsed, options = {}) => {
  const maxBytes = Math.max(32768, Number(options.maxBytes || config.chatAttachmentContextMaxBytes))
  const maxFiles = Math.max(1, Number(options.maxFiles || config.chatAttachmentContextMaxFiles))
  const tokens = queryTokens(options.query)
  const root = commonRoot(parsed.entries)
  const sourceEntries = parsed.entries
    .filter(entry => !entry.directory && !ignoredPath(entry.name))
    .map(entry => ({ ...entry, relativePath: relativeEntryPath(entry.name, root) }))
    .filter(entry => entry.relativePath)
  const manifest = sourceEntries
    .slice(0, config.chatWorkspaceManifestMaxFiles)
    .map(entry => ({ path: entry.relativePath, size: entry.uncompressedSize, directory: false }))
  const manifestTruncated = sourceEntries.length > manifest.length
  const manifestBudget = Math.min(131072, Math.max(16384, Math.floor(maxBytes * 0.24)))
  const manifestLines = []
  let manifestBytes = 0
  for (const item of manifest) {
    const line = `${item.path}\n`
    const bytes = Buffer.byteLength(line)
    if (manifestBytes + bytes > manifestBudget) break
    manifestLines.push(item.path)
    manifestBytes += bytes
  }
  const manifestHeader = [
    `ARCHIVE MANIFEST · ${sourceEntries.length} source files${manifestTruncated || manifestLines.length < sourceEntries.length ? " · truncated" : ""}`,
    ...manifestLines
  ].join("\n")
  const contextParts = [manifestHeader]
  let contextBytes = Buffer.byteLength(manifestHeader)
  const contextFiles = []
  const maxEntryBytes = Math.min(524288, config.chatWorkspaceFileMaxBytes)
  const candidates = sourceEntries
    .filter(entry => shouldReadText(entry.relativePath) && entry.uncompressedSize <= maxEntryBytes)
    .sort((left, right) => priorityFor(right.relativePath, tokens) - priorityFor(left.relativePath, tokens) || left.relativePath.localeCompare(right.relativePath))

  for (const entry of candidates) {
    if (contextFiles.length >= maxFiles) break
    const remaining = maxBytes - contextBytes
    if (remaining <= 1024) break
    const data = readEntryData(buffer, entry, maxEntryBytes)
    if (binaryLike(data)) continue
    const content = data.toString("utf8")
    if (!content.trim()) continue
    const block = `\n\n--- FILE ${entry.relativePath} ---\n${content}`
    const bytes = Buffer.byteLength(block)
    if (bytes > remaining) continue
    contextParts.push(block)
    contextBytes += bytes
    contextFiles.push({
      path: entry.relativePath,
      content,
      sha256: createHash("sha256").update(data).digest("hex"),
      language: languageFor(entry.relativePath)
    })
  }

  return {
    root,
    manifest,
    manifestTruncated,
    sourceFileCount: sourceEntries.length,
    contextFiles,
    contextBytes,
    textContext: contextParts.join("").trim()
  }
}

const dosDateTime = date => {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.min(2107, Math.max(1980, value.getFullYear()))
  const month = value.getMonth() + 1
  const day = value.getDate()
  const hours = value.getHours()
  const minutes = value.getMinutes()
  const seconds = Math.floor(value.getSeconds() / 2)
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  }
}

const buildZip = files => {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  const stamp = dosDateTime(new Date())
  const usedNames = new Set()

  for (const file of files) {
    const name = normalizedEntryName(file.name).replace(/\/$/, "")
    if (usedNames.has(name)) throw failure(`duplicate ZIP export path: ${name}`, 409)
    usedNames.add(name)
    const nameBuffer = Buffer.from(name, "utf8")
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || "")
    const deflated = content.length ? deflateRawSync(content, { level: 6 }) : Buffer.alloc(0)
    const useDeflate = content.length > 0 && deflated.length < content.length
    const compressed = useDeflate ? deflated : content
    const method = useDeflate ? 8 : 0
    const crc = crc32(content)
    const flags = 0x0800

    const local = Buffer.alloc(30)
    local.writeUInt32LE(localSignature, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuffer, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(centralSignature, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, nameBuffer)
    localOffset += local.length + nameBuffer.length + compressed.length
  }

  if (files.length > 0xffff) throw failure("too many files for ZIP export", 413)
  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(eocdSignature, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralBuffer, eocd])
}

export const inspectZip = (buffer, options = {}) => {
  const parsed = readEntries(buffer)
  const contextual = contextualize(buffer, parsed, options)
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    manifest: contextual.manifest,
    manifestTruncated: contextual.manifestTruncated,
    sourceFileCount: contextual.sourceFileCount,
    textContext: contextual.textContext,
    contextFiles: contextual.contextFiles,
    contextBytes: contextual.contextBytes,
    archiveRoot: contextual.root,
    totalUncompressedBytes: parsed.totalUncompressed
  }
}

export const attachmentWorkspaceContext = (inspection, attachment) => ({
  source: "attachment",
  sourceAttachmentId: attachment.id,
  sourceAttachmentIds: [attachment.id],
  sourceAttachmentName: attachment.fileName,
  sourceAttachmentNames: [attachment.fileName],
  rootName: inspection.archiveRoot || archiveRootName(attachment.fileName),
  activeFile: null,
  git: null,
  manifest: inspection.manifest.map(item => item.path),
  manifestTruncated: inspection.manifestTruncated,
  files: inspection.contextFiles,
  stats: {
    fileCount: inspection.sourceFileCount,
    contextFileCount: inspection.contextFiles.length,
    contextBytes: inspection.contextBytes
  }
})

export const attachmentsWorkspaceContext = analyses => {
  const values = (analyses || []).filter(item => item?.inspection && item?.attachment)
  if (!values.length || values.length !== (analyses || []).length) return null
  if (values.length === 1) return attachmentWorkspaceContext(values[0].inspection, values[0].attachment)

  const manifest = []
  const files = []
  const usedPrefixes = new Set()
  let manifestTruncated = false
  let fileCount = 0
  let contextBytes = 0

  for (let index = 0; index < values.length; index += 1) {
    const { inspection, attachment } = values[index]
    const base = archiveRootName(attachment.fileName).replace(/\s+/g, "-").toLowerCase() || `archive-${index + 1}`
    let prefix = `zip-${index + 1}-${base}`
    while (usedPrefixes.has(prefix)) prefix = `${prefix}-${index + 1}`
    usedPrefixes.add(prefix)
    for (const item of inspection.manifest) manifest.push(`${prefix}/${item.path}`)
    for (const item of inspection.contextFiles) files.push({ ...item, path: `${prefix}/${item.path}` })
    manifestTruncated = manifestTruncated || inspection.manifestTruncated
    fileCount += inspection.sourceFileCount
    contextBytes += inspection.contextBytes
  }

  return {
    source: "attachment",
    sourceAttachmentId: null,
    sourceAttachmentIds: values.map(item => item.attachment.id),
    sourceAttachmentName: null,
    sourceAttachmentNames: values.map(item => item.attachment.fileName),
    rootName: "attached-workspace",
    activeFile: null,
    git: null,
    manifest,
    manifestTruncated,
    files,
    stats: { fileCount, contextFileCount: files.length, contextBytes }
  }
}

export const buildCodeChangeZip = plan => {
  const files = (plan?.operations || [])
    .filter(operation => operation?.type === "write" && typeof operation.content === "string")
    .map(operation => ({ name: operation.path, content: Buffer.from(operation.content, "utf8") }))
  if (!files.length) throw failure("code change plan has no downloadable files", 409)
  return buildZip(files)
}

export const buildConversationZip = ({ conversation, messages, attachments }) => {
  const markdown = [
    `# ${conversation.title}`,
    "",
    `Workspace: ${conversation.workspace}`,
    `Project: ${conversation.project}`,
    `Conversation: ${conversation.id}`,
    "",
    ...messages.flatMap(message => [
      `## ${message.role === "assistant" ? message.agentName || "Assistant" : message.role === "user" ? "User" : message.role}`,
      "",
      message.model ? `Model: ${message.model}` : "",
      message.createdAt ? `Timestamp: ${new Date(message.createdAt).toISOString()}` : "",
      "",
      message.content,
      ""
    ].filter(Boolean))
  ].join("\n")

  const payload = JSON.stringify({
    conversation,
    messages: messages.map(message => ({
      ...message,
      attachments: message.attachments?.map(({ id, fileName, mediaType, sizeBytes, sha256, manifest, createdAt }) => ({ id, fileName, mediaType, sizeBytes, sha256, manifest, createdAt })) || []
    }))
  }, null, 2)

  const files = [
    { name: "conversation.md", content: Buffer.from(markdown, "utf8") },
    { name: "conversation.json", content: Buffer.from(payload, "utf8") }
  ]
  const usedNames = new Set()
  for (const attachment of attachments) {
    let name = safeFileName(attachment.fileName)
    if (usedNames.has(name)) name = `${attachment.id.slice(0, 8)}-${name}`
    usedNames.add(name)
    files.push({ name: `attachments/${name}`, content: attachment.content })
  }
  return buildZip(files)
}
