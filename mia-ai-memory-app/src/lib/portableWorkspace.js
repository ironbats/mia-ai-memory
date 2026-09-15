const DB_NAME = "ai-memory-portable-workspaces"
const DB_VERSION = 1
const WORKSPACE_STORE = "workspaces"
const FILE_STORE = "files"
const FILE_INDEX = "workspaceKey"
const MAX_PORTABLE_FILES = 20000
const STORAGE_HEADROOM = 1.2

const ignoredDirectories = new Set([
  "node_modules", "dist", "build", "target", "vendor", ".next", ".nuxt", ".cache", "coverage", ".gradle", ".terraform", ".idea", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv"
])

const protectedNames = new Set([".env", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519"])

const normalizePath = value => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "")
const basename = path => normalizePath(path).split("/").pop() || ""

const extension = path => {
  const name = basename(path)
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index + 1).toLowerCase() : ""
}

const notFoundError = message => {
  const error = new Error(message)
  error.name = "NotFoundError"
  return error
}

const isProtectedPath = path => {
  const normalized = normalizePath(path)
  const segments = normalized.split("/")
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")) return true
  if (segments.some(segment => ignoredDirectories.has(segment))) return true
  const name = basename(normalized).toLowerCase()
  if (protectedNames.has(name)) return true
  if (name.startsWith(".env.") && name !== ".env.example") return true
  if (["pem", "key", "p12", "pfx", "jks", "keystore"].includes(extension(name))) return true
  return false
}

const isAllowedGitMetadata = path => {
  const normalized = normalizePath(path)
  if (normalized === ".git" || normalized === ".git/refs" || normalized === ".git/refs/heads") return true
  if (!normalized.startsWith(".git/")) return true
  return normalized === ".git/HEAD" || normalized === ".git/packed-refs" || normalized === ".git/config" || normalized.startsWith(".git/refs/heads/")
}

const indexedDbSupported = () => typeof window !== "undefined" && Boolean(window.indexedDB)

export const portableWorkspaceSupported = () => typeof window !== "undefined"
  && indexedDbSupported()
  && typeof File !== "undefined"
  && typeof Blob !== "undefined"
  && typeof window.crypto?.randomUUID === "function"

const openDatabase = () => new Promise((resolve, reject) => {
  if (!indexedDbSupported()) {
    reject(new Error("IndexedDB indisponível neste navegador."))
    return
  }
  const request = window.indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(WORKSPACE_STORE)) database.createObjectStore(WORKSPACE_STORE, { keyPath: "key" })
    if (!database.objectStoreNames.contains(FILE_STORE)) {
      const store = database.createObjectStore(FILE_STORE, { keyPath: "id" })
      store.createIndex(FILE_INDEX, "workspaceKey", { unique: false })
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento portátil da IDE."))
})

const waitTransaction = (database, transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => {
    database.close()
    resolve(true)
  }
  transaction.onerror = () => {
    database.close()
    reject(transaction.error || new Error("Falha ao persistir o workspace portátil."))
  }
  transaction.onabort = () => {
    database.close()
    reject(transaction.error || new Error("Persistência do workspace portátil foi cancelada."))
  }
})

const readRequest = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error("Falha ao ler o workspace portátil."))
})

const persistWorkspace = async metadata => {
  const database = await openDatabase()
  const transaction = database.transaction(WORKSPACE_STORE, "readwrite")
  transaction.objectStore(WORKSPACE_STORE).put(metadata)
  await waitTransaction(database, transaction)
}

const persistFiles = async (workspaceKey, files) => {
  const database = await openDatabase()
  const transaction = database.transaction(FILE_STORE, "readwrite")
  const store = transaction.objectStore(FILE_STORE)
  for (const item of files) {
    store.put({
      id: `${workspaceKey}\u0000${item.path}`,
      workspaceKey,
      path: item.path,
      blob: item.blob,
      type: item.type || "",
      lastModified: Number(item.lastModified || Date.now())
    })
  }
  await waitTransaction(database, transaction)
}

const persistFile = async (workspaceKey, path, blob, type = "", lastModified = Date.now()) => {
  const database = await openDatabase()
  const transaction = database.transaction(FILE_STORE, "readwrite")
  transaction.objectStore(FILE_STORE).put({ id: `${workspaceKey}\u0000${path}`, workspaceKey, path, blob, type, lastModified })
  await waitTransaction(database, transaction)
}

const deleteFileRecords = async (workspaceKey, paths) => {
  if (!paths.length) return
  const database = await openDatabase()
  const transaction = database.transaction(FILE_STORE, "readwrite")
  const store = transaction.objectStore(FILE_STORE)
  for (const path of paths) store.delete(`${workspaceKey}\u0000${path}`)
  await waitTransaction(database, transaction)
}

const loadWorkspaceRecord = async workspaceKey => {
  const database = await openDatabase()
  const transaction = database.transaction(WORKSPACE_STORE, "readonly")
  const result = await readRequest(transaction.objectStore(WORKSPACE_STORE).get(String(workspaceKey)))
  database.close()
  return result || null
}

const loadWorkspaceFiles = async workspaceKey => {
  const database = await openDatabase()
  const transaction = database.transaction(FILE_STORE, "readonly")
  const store = transaction.objectStore(FILE_STORE)
  const index = store.index(FILE_INDEX)
  const records = await readRequest(index.getAll(String(workspaceKey)))
  database.close()
  return Array.isArray(records) ? records : []
}

const deleteWorkspaceRecords = async workspaceKey => {
  const database = await openDatabase()
  const transaction = database.transaction([WORKSPACE_STORE, FILE_STORE], "readwrite")
  transaction.objectStore(WORKSPACE_STORE).delete(String(workspaceKey))
  const fileStore = transaction.objectStore(FILE_STORE)
  const cursorRequest = fileStore.index(FILE_INDEX).openKeyCursor(String(workspaceKey))
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) return
    fileStore.delete(cursor.primaryKey)
    cursor.continue()
  }
  await waitTransaction(database, transaction)
}

const MAX_PORTABLE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50

const cleanProjectName = value => {
  const name = String(value || "workspace").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 96)
  return name || "workspace"
}

const candidateFromFile = (path, file) => ({
  path: normalizePath(path),
  blob: file instanceof Blob ? file : new Blob([file]),
  type: file?.type || "",
  lastModified: Number(file?.lastModified || Date.now())
})

const validateCandidate = (candidates, seenPaths, path, file) => {
  const normalized = normalizePath(path)
  if (!normalized || isProtectedPath(normalized) || !isAllowedGitMetadata(normalized)) return 0
  if (seenPaths.has(normalized)) throw new Error(`O projeto contém caminhos duplicados: ${normalized}`)
  seenPaths.add(normalized)
  if (candidates.length >= MAX_PORTABLE_FILES) throw new Error(`O projeto possui mais de ${MAX_PORTABLE_FILES} arquivos úteis. Remova dependências e artefatos gerados antes de importar.`)
  const candidate = candidateFromFile(normalized, file)
  candidates.push(candidate)
  return Number(candidate.blob.size || 0)
}

const readLegacyEntryFile = entry => new Promise((resolve, reject) => entry.file(resolve, reject))

const readLegacyDirectoryBatch = reader => new Promise((resolve, reject) => reader.readEntries(resolve, reject))

const readLegacyDirectoryEntries = async directoryEntry => {
  const reader = directoryEntry.createReader()
  const entries = []
  while (true) {
    const batch = await readLegacyDirectoryBatch(reader)
    if (!batch.length) break
    entries.push(...batch)
  }
  return entries
}

const collectLegacyDirectory = async (directoryEntry, candidates, prefix = "", seenPaths = new Set()) => {
  const entries = await readLegacyDirectoryEntries(directoryEntry)
  let bytes = 0
  for (const entry of entries) {
    const path = normalizePath(prefix ? `${prefix}/${entry.name}` : entry.name)
    if (!path || isProtectedPath(path) || !isAllowedGitMetadata(path)) continue
    if (entry.isDirectory) {
      bytes += await collectLegacyDirectory(entry, candidates, path, seenPaths)
      continue
    }
    if (!entry.isFile) continue
    const file = await readLegacyEntryFile(entry)
    bytes += validateCandidate(candidates, seenPaths, path, file)
  }
  return bytes
}

const collectHandleDirectory = async (directoryHandle, candidates, prefix = "", seenPaths = new Set()) => {
  let bytes = 0
  for await (const [name, child] of directoryHandle.entries()) {
    const path = normalizePath(prefix ? `${prefix}/${name}` : name)
    if (!path || isProtectedPath(path) || !isAllowedGitMetadata(path)) continue
    if (child.kind === "directory") {
      bytes += await collectHandleDirectory(child, candidates, path, seenPaths)
      continue
    }
    if (child.kind !== "file") continue
    const file = await child.getFile()
    bytes += validateCandidate(candidates, seenPaths, path, file)
  }
  return bytes
}

const droppedDirectoryDescriptor = async dataTransfer => {
  const items = [...(dataTransfer?.items || [])]
  if (!items.length) throw new Error("Nenhuma pasta foi detectada. Arraste a pasta raiz do projeto ou importe um arquivo ZIP.")

  const modernHandles = []
  for (const item of items) {
    if (item.kind !== "file" || typeof item.getAsFileSystemHandle !== "function") continue
    try {
      const handle = await item.getAsFileSystemHandle()
      if (handle) modernHandles.push(handle)
    } catch {
    }
  }
  const modernDirectories = modernHandles.filter(handle => handle?.kind === "directory")
  if (modernDirectories.length) {
    if (modernDirectories.length !== 1 || modernHandles.length !== 1) throw new Error("Arraste somente uma pasta raiz por vez.")
    return { type: "handle", source: modernDirectories[0], name: cleanProjectName(modernDirectories[0].name) }
  }

  const legacyEntries = items
    .filter(item => item.kind === "file" && typeof item.webkitGetAsEntry === "function")
    .map(item => {
      try {
        return item.webkitGetAsEntry()
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const legacyDirectories = legacyEntries.filter(entry => entry.isDirectory)
  if (legacyDirectories.length) {
    if (legacyDirectories.length !== 1 || legacyEntries.length !== 1) throw new Error("Arraste somente uma pasta raiz por vez.")
    return { type: "legacy", source: legacyDirectories[0], name: cleanProjectName(legacyDirectories[0].name) }
  }

  throw new Error("Este navegador não expôs a estrutura da pasta arrastada. Use a opção Importar ZIP, que funciona sem a confirmação nativa de upload de diretório.")
}

const utf8Decoder = new TextDecoder("utf-8")
const latin1Decoder = (() => {
  try {
    return new TextDecoder("iso-8859-1")
  } catch {
    return utf8Decoder
  }
})()

const readUint16 = (view, offset) => view.getUint16(offset, true)
const readUint32 = (view, offset) => view.getUint32(offset, true)

const findZipEocd = bytes => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimum = Math.max(0, bytes.byteLength - 65557)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(view, offset) === ZIP_EOCD_SIGNATURE) return offset
  }
  throw new Error("O arquivo ZIP é inválido ou não possui diretório central.")
}

const normalizeZipEntryName = value => {
  const name = String(value || "").replace(/\\/g, "/")
  if (!name || name.startsWith("/") || /^[A-Za-z]:\//.test(name)) throw new Error("O ZIP contém um caminho absoluto não permitido.")
  const segments = name.split("/").filter(Boolean)
  if (!segments.length || segments.some(segment => segment === "." || segment === "..")) throw new Error("O ZIP contém um caminho inseguro.")
  return `${segments.join("/")}${name.endsWith("/") ? "/" : ""}`
}

const zipCommonRoot = entries => {
  const roots = new Set()
  let files = 0
  for (const entry of entries) {
    if (entry.directory) continue
    const segments = entry.name.split("/").filter(Boolean)
    if (segments.length < 2) return ""
    roots.add(segments[0])
    files += 1
    if (roots.size > 1) return ""
  }
  return files ? [...roots][0] : ""
}

const parseZipDirectory = bytes => {
  if (bytes.byteLength < 22) throw new Error("O arquivo ZIP está vazio ou inválido.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findZipEocd(bytes)
  const disk = readUint16(view, eocd + 4)
  const centralDisk = readUint16(view, eocd + 6)
  const diskEntries = readUint16(view, eocd + 8)
  const totalEntries = readUint16(view, eocd + 10)
  const centralSize = readUint32(view, eocd + 12)
  const centralOffset = readUint32(view, eocd + 16)
  const commentLength = readUint16(view, eocd + 20)

  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("ZIPs multi-disco não são suportados.")
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 ainda não é suportado no Browser Workspace. Gere um ZIP padrão do projeto.")
  if (totalEntries > MAX_PORTABLE_FILES * 4) throw new Error(`O ZIP possui entradas demais para a IDE (${totalEntries}).`)
  if (eocd + 22 + commentLength > bytes.byteLength || centralOffset + centralSize > eocd) throw new Error("O diretório central do ZIP está corrompido.")

  const entries = []
  const seen = new Set()
  let offset = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.byteLength || readUint32(view, offset) !== ZIP_CENTRAL_SIGNATURE) throw new Error("Uma entrada do diretório central do ZIP está inválida.")
    const versionMadeBy = readUint16(view, offset + 4)
    const flags = readUint16(view, offset + 8)
    const method = readUint16(view, offset + 10)
    const dosTime = readUint16(view, offset + 12)
    const dosDate = readUint16(view, offset + 14)
    const crc = readUint32(view, offset + 16)
    const compressedSize = readUint32(view, offset + 20)
    const uncompressedSize = readUint32(view, offset + 24)
    const nameLength = readUint16(view, offset + 28)
    const extraLength = readUint16(view, offset + 30)
    const entryCommentLength = readUint16(view, offset + 32)
    const diskStart = readUint16(view, offset + 34)
    const externalAttributes = readUint32(view, offset + 38)
    const localOffset = readUint32(view, offset + 42)
    const end = offset + 46 + nameLength + extraLength + entryCommentLength
    if (end > bytes.byteLength || localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error("O ZIP contém uma entrada ZIP64 não suportada.")
    if (diskStart !== 0) throw new Error("ZIPs multi-disco não são suportados.")
    if ((flags & 0x1) !== 0) throw new Error("ZIPs criptografados não são suportados.")
    if (![0, 8].includes(method)) throw new Error(`O método de compressão ZIP ${method} não é suportado.`)

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const name = normalizeZipEntryName(((flags & 0x0800) !== 0 ? utf8Decoder : latin1Decoder).decode(rawName))
    if (seen.has(name)) throw new Error(`O ZIP contém um caminho duplicado: ${name}`)
    seen.add(name)
    const unixMode = (versionMadeBy >>> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : 0
    if ((unixMode & 0o170000) === 0o120000) throw new Error("Links simbólicos dentro do ZIP não são suportados no Browser Workspace.")

    entries.push({
      name,
      directory: name.endsWith("/"),
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      lastModified: dosDateTimeToTimestamp(dosDate, dosTime)
    })
    offset = end
  }
  if (offset > centralOffset + centralSize) throw new Error("O tamanho do diretório central do ZIP é inconsistente.")
  return entries
}

const dosDateTimeToTimestamp = (dateValue, timeValue) => {
  const year = 1980 + ((dateValue >>> 9) & 0x7f)
  const month = (dateValue >>> 5) & 0x0f
  const day = dateValue & 0x1f
  const hours = (timeValue >>> 11) & 0x1f
  const minutes = (timeValue >>> 5) & 0x3f
  const seconds = (timeValue & 0x1f) * 2
  const timestamp = new Date(year, Math.max(0, month - 1), Math.max(1, day), hours, minutes, seconds).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  return value >>> 0
})

const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const unzipEntry = async (archiveBytes, entry) => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength)
  const offset = entry.localOffset
  if (offset + 30 > archiveBytes.byteLength || readUint32(view, offset) !== ZIP_LOCAL_SIGNATURE) throw new Error(`Entrada ZIP inválida: ${entry.name}`)
  const nameLength = readUint16(view, offset + 26)
  const extraLength = readUint16(view, offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (start > archiveBytes.byteLength || end > archiveBytes.byteLength) throw new Error(`Conteúdo truncado no ZIP: ${entry.name}`)
  const compressed = archiveBytes.subarray(start, end)
  let data
  if (entry.method === 0) {
    data = compressed.slice()
  } else {
    if (typeof DecompressionStream !== "function") throw new Error("Este navegador não oferece descompressão ZIP local. Arraste a pasta do projeto ou use um navegador mais recente.")
    let stream
    try {
      stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    } catch {
      throw new Error("Este navegador não oferece descompressão ZIP deflate compatível. Arraste a pasta do projeto.")
    }
    try {
      data = new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
      throw new Error(`Não foi possível descompactar ${entry.name}.`)
    }
  }
  if (data.byteLength !== entry.uncompressedSize) throw new Error(`Tamanho inconsistente no ZIP: ${entry.name}`)
  if (crc32(data) !== entry.crc) throw new Error(`Falha de integridade no ZIP: ${entry.name}`)
  return data
}

const archiveName = file => cleanProjectName(String(file?.name || "workspace.zip").replace(/\.zip$/i, ""))

const ensureStorageCapacity = async totalBytes => {
  if (typeof navigator.storage?.estimate !== "function") return
  try {
    const estimate = await navigator.storage.estimate()
    const available = Math.max(0, Number(estimate.quota || 0) - Number(estimate.usage || 0))
    if (available && totalBytes * STORAGE_HEADROOM > available) {
      const requiredMb = Math.ceil((totalBytes * STORAGE_HEADROOM) / 1024 / 1024)
      const availableMb = Math.floor(available / 1024 / 1024)
      throw new Error(`Espaço insuficiente no armazenamento privado do navegador. Necessário aproximadamente ${requiredMb} MB; disponível ${availableMb} MB.`)
    }
  } catch (error) {
    if (String(error?.message || "").includes("Espaço insuficiente")) throw error
  }
}

const makeStorageKey = name => {
  const slug = String(name || "workspace").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace"
  return `${slug}-${crypto.randomUUID()}`
}

const blobFromWrite = value => {
  if (value instanceof Blob) return value
  if (value instanceof ArrayBuffer) return new Blob([value])
  if (ArrayBuffer.isView(value)) return new Blob([value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)])
  return new Blob([String(value ?? "")], { type: "text/plain;charset=utf-8" })
}

class VirtualWorkspaceStore {
  constructor(key, name, records) {
    this.key = key
    this.name = name
    this.files = new Map()
    this.directories = new Set([""])
    for (const record of records) this.seed(record.path, record.blob, record.type, record.lastModified)
  }

  seed(path, blob, type = "", lastModified = Date.now()) {
    const normalized = normalizePath(path)
    if (!normalized) return
    this.files.set(normalized, { blob, type, lastModified })
    const parts = normalized.split("/")
    parts.pop()
    let current = ""
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      this.directories.add(current)
    }
  }

  async write(path, value, type = "") {
    const normalized = normalizePath(path)
    const blob = blobFromWrite(value)
    const lastModified = Date.now()
    this.seed(normalized, blob, type || blob.type || "", lastModified)
    await persistFile(this.key, normalized, blob, type || blob.type || "", lastModified)
  }

  async remove(path, recursive = false) {
    const normalized = normalizePath(path)
    if (this.files.has(normalized)) {
      this.files.delete(normalized)
      await deleteFileRecords(this.key, [normalized])
      return
    }
    if (!this.directories.has(normalized)) throw notFoundError(`Caminho não encontrado: ${normalized}`)
    const prefix = `${normalized}/`
    const filePaths = [...this.files.keys()].filter(item => item.startsWith(prefix))
    const childDirectories = [...this.directories].filter(item => item.startsWith(prefix))
    if (!recursive && (filePaths.length || childDirectories.length)) {
      const error = new Error(`Diretório não está vazio: ${normalized}`)
      error.name = "InvalidModificationError"
      throw error
    }
    for (const filePath of filePaths) this.files.delete(filePath)
    for (const directory of childDirectories) this.directories.delete(directory)
    this.directories.delete(normalized)
    await deleteFileRecords(this.key, filePaths)
  }

  ensureDirectory(path) {
    const normalized = normalizePath(path)
    if (!normalized) return
    const parts = normalized.split("/")
    let current = ""
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      this.directories.add(current)
    }
  }
}

class VirtualWritableFile {
  constructor(store, path, type = "") {
    this.store = store
    this.path = path
    this.type = type
    this.value = null
  }

  async write(value) {
    if (value && typeof value === "object" && value.type === "write" && Object.prototype.hasOwnProperty.call(value, "data")) this.value = value.data
    else this.value = value
  }

  async close() {
    await this.store.write(this.path, this.value ?? "", this.type)
  }

  async abort() {
    this.value = null
  }
}

class VirtualFileHandle {
  constructor(store, path) {
    this.kind = "file"
    this.store = store
    this.path = normalizePath(path)
    this.name = basename(this.path)
  }

  async getFile() {
    const record = this.store.files.get(this.path)
    if (!record) throw notFoundError(`Arquivo não encontrado: ${this.path}`)
    return new File([record.blob], this.name, { type: record.type || record.blob?.type || "", lastModified: Number(record.lastModified || Date.now()) })
  }

  async createWritable() {
    const record = this.store.files.get(this.path)
    return new VirtualWritableFile(this.store, this.path, record?.type || "")
  }

  async isSameEntry(other) {
    return Boolean(other?.kind === "file" && other?.store?.key === this.store.key && other?.path === this.path)
  }
}

class VirtualDirectoryHandle {
  constructor(store, path = "", rootName = "") {
    this.kind = "directory"
    this.store = store
    this.path = normalizePath(path)
    this.name = this.path ? basename(this.path) : rootName || store.name || "workspace"
  }

  async *entries() {
    const prefix = this.path ? `${this.path}/` : ""
    const directories = new Set()
    const files = new Set()

    for (const directory of this.store.directories) {
      if (!directory || !directory.startsWith(prefix) || directory === this.path) continue
      const remainder = directory.slice(prefix.length)
      if (remainder && !remainder.includes("/")) directories.add(remainder)
    }

    for (const filePath of this.store.files.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const remainder = filePath.slice(prefix.length)
      if (remainder && !remainder.includes("/")) files.add(remainder)
    }

    for (const name of directories) yield [name, new VirtualDirectoryHandle(this.store, prefix ? `${prefix}${name}` : name)]
    for (const name of files) yield [name, new VirtualFileHandle(this.store, prefix ? `${prefix}${name}` : name)]
  }

  async getDirectoryHandle(name, options = {}) {
    const target = normalizePath(this.path ? `${this.path}/${name}` : name)
    if (!this.store.directories.has(target)) {
      if (!options.create) throw notFoundError(`Diretório não encontrado: ${target}`)
      this.store.ensureDirectory(target)
    }
    return new VirtualDirectoryHandle(this.store, target)
  }

  async getFileHandle(name, options = {}) {
    const target = normalizePath(this.path ? `${this.path}/${name}` : name)
    if (!this.store.files.has(target)) {
      if (!options.create) throw notFoundError(`Arquivo não encontrado: ${target}`)
      await this.store.write(target, "")
    }
    return new VirtualFileHandle(this.store, target)
  }

  async removeEntry(name, options = {}) {
    const target = normalizePath(this.path ? `${this.path}/${name}` : name)
    await this.store.remove(target, Boolean(options.recursive))
  }

  async queryPermission() {
    return "granted"
  }

  async requestPermission() {
    return "granted"
  }

  async isSameEntry(other) {
    return Boolean(other?.kind === "directory" && other?.store?.key === this.store.key && other?.path === this.path)
  }
}

const buildHandle = (key, name, records) => {
  const store = new VirtualWorkspaceStore(key, name, records)
  return new VirtualDirectoryHandle(store, "", name)
}

const persistImportedWorkspace = async ({ name, candidates, totalBytes, source }) => {
  const normalizedName = cleanProjectName(name)
  if (!candidates.length) throw new Error("Nenhum arquivo utilizável foi encontrado no projeto informado.")
  if (candidates.length > MAX_PORTABLE_FILES) throw new Error(`O projeto possui mais de ${MAX_PORTABLE_FILES} arquivos úteis. Remova dependências e artefatos gerados antes de importar.`)
  if (totalBytes > MAX_PORTABLE_UNCOMPRESSED_BYTES) throw new Error(`O projeto útil ultrapassa ${Math.round(MAX_PORTABLE_UNCOMPRESSED_BYTES / 1024 / 1024)} MB descompactados. Remova dependências e artefatos gerados antes de importar.`)
  await ensureStorageCapacity(totalBytes)

  const storageKey = makeStorageKey(normalizedName)
  const now = new Date().toISOString()
  await persistWorkspace({
    key: storageKey,
    name: normalizedName,
    createdAt: now,
    updatedAt: now,
    fileCount: candidates.length,
    bytes: totalBytes,
    source: String(source || "portable")
  })
  try {
    await persistFiles(storageKey, candidates)
  } catch (error) {
    try {
      await deleteWorkspaceRecords(storageKey)
    } catch {
    }
    throw error
  }

  return {
    handle: buildHandle(storageKey, normalizedName, candidates),
    name: normalizedName,
    storageKey,
    fileCount: candidates.length,
    importedBytes: totalBytes,
    source: String(source || "portable")
  }
}

export const importPortableWorkspaceFromHandle = async directoryHandle => {
  if (!portableWorkspaceSupported()) throw new Error("Este navegador não oferece armazenamento privado compatível com o Browser Workspace.")
  if (!directoryHandle || directoryHandle.kind !== "directory") throw new Error("Selecione uma pasta de projeto válida.")
  const candidates = []
  const totalBytes = await collectHandleDirectory(directoryHandle, candidates)
  return persistImportedWorkspace({ name: directoryHandle.name, candidates, totalBytes, source: "directory-handle" })
}

export const importPortableWorkspaceFromDrop = async dataTransfer => {
  if (!portableWorkspaceSupported()) throw new Error("Este navegador não oferece armazenamento privado compatível com o Browser Workspace.")
  const descriptor = await droppedDirectoryDescriptor(dataTransfer)
  const candidates = []
  const totalBytes = descriptor.type === "handle"
    ? await collectHandleDirectory(descriptor.source, candidates)
    : await collectLegacyDirectory(descriptor.source, candidates)
  return persistImportedWorkspace({ name: descriptor.name, candidates, totalBytes, source: "directory-drop" })
}

export const importPortableWorkspaceFromFileList = async files => {
  if (!portableWorkspaceSupported()) throw new Error("Este navegador não oferece armazenamento privado compatível com o Browser Workspace.")
  const selectedFiles = [...(files || [])].filter(file => file instanceof File)
  if (!selectedFiles.length) throw new Error("Nenhuma pasta foi selecionada.")

  const paths = selectedFiles.map(file => normalizePath(file.webkitRelativePath || file.name)).filter(Boolean)
  const roots = new Set(paths.map(path => path.split("/")[0]).filter(Boolean))
  const hasDirectoryStructure = selectedFiles.every(file => normalizePath(file.webkitRelativePath || "").includes("/"))
  if (!hasDirectoryStructure || roots.size !== 1) throw new Error("O navegador não forneceu a estrutura completa da pasta selecionada. Use arrastar e soltar ou importe um ZIP do projeto.")

  const root = [...roots][0]
  const candidates = []
  const seenPaths = new Set()
  let totalBytes = 0

  for (const file of selectedFiles) {
    const fullPath = normalizePath(file.webkitRelativePath || file.name)
    const path = normalizePath(fullPath.startsWith(`${root}/`) ? fullPath.slice(root.length + 1) : fullPath)
    if (!path) continue
    totalBytes += validateCandidate(candidates, seenPaths, path, file)
  }

  return persistImportedWorkspace({
    name: cleanProjectName(root),
    candidates,
    totalBytes,
    source: "directory-picker"
  })
}

export const importPortableWorkspaceFromZip = async file => {
  if (!portableWorkspaceSupported()) throw new Error("Este navegador não oferece armazenamento privado compatível com o Browser Workspace.")
  if (!(file instanceof Blob)) throw new Error("Selecione um arquivo ZIP válido.")
  if (!String(file.name || "").toLowerCase().endsWith(".zip")) throw new Error("Selecione um arquivo com extensão .zip.")
  const archiveBytes = new Uint8Array(await file.arrayBuffer())
  const entries = parseZipDirectory(archiveBytes)
  const root = zipCommonRoot(entries)
  const name = root ? cleanProjectName(root) : archiveName(file)
  const candidates = []
  let totalBytes = 0
  const usefulEntries = []

  for (const entry of entries) {
    if (entry.directory) continue
    const path = normalizePath(root && entry.name.startsWith(`${root}/`) ? entry.name.slice(root.length + 1) : entry.name)
    if (!path || isProtectedPath(path) || !isAllowedGitMetadata(path)) continue
    if (candidates.length + usefulEntries.length >= MAX_PORTABLE_FILES) throw new Error(`O projeto possui mais de ${MAX_PORTABLE_FILES} arquivos úteis. Remova dependências e artefatos gerados antes de importar.`)
    totalBytes += Number(entry.uncompressedSize || 0)
    if (totalBytes > MAX_PORTABLE_UNCOMPRESSED_BYTES) throw new Error(`O projeto útil ultrapassa ${Math.round(MAX_PORTABLE_UNCOMPRESSED_BYTES / 1024 / 1024)} MB descompactados. Remova dependências e artefatos gerados antes de importar.`)
    usefulEntries.push({ ...entry, path })
  }

  if (!usefulEntries.length) throw new Error("Nenhum arquivo utilizável foi encontrado dentro do ZIP.")
  await ensureStorageCapacity(totalBytes)

  for (const entry of usefulEntries) {
    const data = await unzipEntry(archiveBytes, entry)
    candidates.push({
      path: entry.path,
      blob: new Blob([data]),
      type: "",
      lastModified: Number(entry.lastModified || Date.now())
    })
  }

  return persistImportedWorkspace({ name, candidates, totalBytes, source: "zip" })
}

export const openPortableWorkspace = async storageKey => {
  if (!portableWorkspaceSupported() || !storageKey) return null
  try {
    const metadata = await loadWorkspaceRecord(storageKey)
    if (!metadata) return null
    const records = await loadWorkspaceFiles(storageKey)
    return buildHandle(String(storageKey), metadata.name || "workspace", records)
  } catch {
    return null
  }
}

export const deletePortableWorkspace = async storageKey => {
  if (!indexedDbSupported() || !storageKey) return false
  try {
    await deleteWorkspaceRecords(String(storageKey))
    return true
  } catch {
    return false
  }
}
