import { createHash } from "node:crypto"
import path from "node:path"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import { config } from "./config.js"

const failure = (message, status = 400) => Object.assign(new Error(message), { status, expose: true })

const textExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".go", ".gradle", ".graphql", ".h", ".hpp",
  ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".lock", ".md", ".mjs", ".mts",
  ".php", ".properties", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".swift", ".toml",
  ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"
])

const textNames = new Set(["dockerfile", "makefile", "procfile", "gemfile", "rakefile", "license", "readme"])
const ignoredSegments = new Set([".git", ".idea", ".next", ".turbo", ".vscode", "build", "coverage", "dist", "node_modules", "target", "vendor"])
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

const shouldReadText = name => {
  const segments = name.toLowerCase().split("/")
  if (segments.some(segment => ignoredSegments.has(segment))) return false
  const base = path.posix.basename(name).toLowerCase()
  if (base === ".env" || base.startsWith(".env.")) return false
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

  for (const file of files) {
    const name = normalizedEntryName(file.name).replace(/\/$/, "")
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

export const inspectZip = buffer => {
  const parsed = readEntries(buffer)
  const manifest = parsed.entries.map(entry => ({ path: entry.name, size: entry.uncompressedSize, directory: entry.directory }))
  const contextParts = []
  let contextBytes = 0

  for (const entry of parsed.entries) {
    if (entry.directory || !shouldReadText(entry.name) || entry.uncompressedSize > 262144) continue
    const remaining = config.chatAttachmentContextMaxBytes - contextBytes
    if (remaining <= 0) break
    const data = readEntryData(buffer, entry, Math.min(262144, remaining))
    if (binaryLike(data)) continue
    const value = data.toString("utf8").trim()
    if (!value) continue
    const block = `\n--- FILE ${entry.name} ---\n${value}\n`
    const bytes = Buffer.byteLength(block)
    if (bytes > remaining) {
      const partial = Buffer.from(block).subarray(0, remaining).toString("utf8")
      contextParts.push(partial)
      contextBytes += Buffer.byteLength(partial)
      break
    }
    contextParts.push(block)
    contextBytes += bytes
  }

  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    manifest,
    textContext: contextParts.join("").trim(),
    totalUncompressedBytes: parsed.totalUncompressed
  }
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
