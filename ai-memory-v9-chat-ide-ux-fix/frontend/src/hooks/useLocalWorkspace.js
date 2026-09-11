import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const MAX_TREE_FILES = 5000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_CONTEXT_FILES = 28
const MAX_CONTEXT_BYTES = 1536 * 1024

const ignoredDirectories = new Set([
  ".git", "node_modules", "dist", "build", "target", "vendor", ".next", ".nuxt", ".cache", "coverage", ".gradle", ".terraform", ".idea", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv"
])

const binaryExtensions = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "pdf", "zip", "gz", "tgz", "tar", "7z", "rar", "jar", "war", "class", "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "sqlite3", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "ogg", "pyc", "o", "a", "wasm", "lockb"
])

const protectedNames = new Set([".env", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519"])

const normalizePath = value => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "")
const basename = path => normalizePath(path).split("/").pop() || ""
const extension = path => {
  const name = basename(path)
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index + 1).toLowerCase() : ""
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

const hashText = async value => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

const looksBinary = async file => {
  if (binaryExtensions.has(extension(file.name))) return true
  const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer())
  for (const byte of sample) if (byte === 0) return true
  return false
}

const compareNodes = (a, b) => {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
}

const tokenize = value => [...new Set(String(value || "").toLowerCase().match(/[a-z0-9_.\-/]{3,}/g) || [])].slice(0, 40)

const languageFor = path => {
  const ext = extension(path)
  const map = {
    js: "JavaScript", jsx: "React JSX", ts: "TypeScript", tsx: "React TSX", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", py: "Python", rb: "Ruby", php: "PHP", cs: "C#", cpp: "C++", cc: "C++", c: "C", h: "C/C++ Header", hpp: "C++ Header", swift: "Swift", scala: "Scala", sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", sql: "SQL", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less", vue: "Vue", svelte: "Svelte", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML", md: "Markdown", mdx: "MDX", graphql: "GraphQL", gql: "GraphQL", proto: "Protocol Buffers", tf: "Terraform", dockerfile: "Dockerfile"
  }
  if (basename(path).toLowerCase() === "dockerfile") return "Dockerfile"
  if (basename(path).toLowerCase() === "makefile") return "Makefile"
  return map[ext] || (ext ? ext.toUpperCase() : "Plain Text")
}

const safeRelativePath = value => {
  const normalized = normalizePath(value)
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || normalized.startsWith("/") || isProtectedPath(normalized)) throw new Error(`Caminho não permitido: ${value}`)
  return normalized
}

const parentPath = path => {
  const values = normalizePath(path).split("/")
  values.pop()
  return values.join("/")
}

export default function useLocalWorkspace() {
  const supported = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"
  const [rootHandle, setRootHandle] = useState(null)
  const [rootName, setRootName] = useState("")
  const [tree, setTree] = useState([])
  const [filePaths, setFilePaths] = useState([])
  const [tabs, setTabs] = useState([])
  const [activePath, setActivePath] = useState("")
  const [contextPaths, setContextPaths] = useState([])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState("")
  const [autoApply, setAutoApply] = useState(true)
  const [workspaceSession, setWorkspaceSession] = useState(0)
  const fileHandlesRef = useRef(new Map())
  const directoryHandlesRef = useRef(new Map())
  const tabsRef = useRef([])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  const scan = useCallback(async (handle, resetWorkspace = false) => {
    if (!handle) return
    setScanning(true)
    setError("")
    const fileHandles = new Map()
    const directoryHandles = new Map([["", handle]])
    const paths = []
    let count = 0

    const walk = async (directoryHandle, prefix = "") => {
      const entries = []
      for await (const [name, child] of directoryHandle.entries()) {
        if (child.kind === "directory" && ignoredDirectories.has(name)) continue
        const path = normalizePath(prefix ? `${prefix}/${name}` : name)
        if (isProtectedPath(path)) continue
        if (child.kind === "file") {
          if (count >= MAX_TREE_FILES) continue
          count += 1
          fileHandles.set(path, child)
          paths.push(path)
          entries.push({ type: "file", name, path, language: languageFor(path) })
        } else {
          directoryHandles.set(path, child)
          const children = await walk(child, path)
          if (children.length) entries.push({ type: "directory", name, path, children })
        }
      }
      return entries.sort(compareNodes)
    }

    try {
      const nextTree = await walk(handle)
      fileHandlesRef.current = fileHandles
      directoryHandlesRef.current = directoryHandles
      const sortedPaths = paths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
      setTree(nextTree)
      setFilePaths(sortedPaths)
      setRootHandle(handle)
      setRootName(handle.name || "workspace")
      if (resetWorkspace) {
        tabsRef.current = []
        setTabs([])
        setActivePath("")
        setContextPaths([])
      } else {
        const refreshedTabs = []
        for (const tab of tabsRef.current.filter(item => fileHandles.has(item.path))) {
          if (tab.dirty) {
            refreshedTabs.push(tab)
            continue
          }
          try {
            const file = await fileHandles.get(tab.path).getFile()
            if (file.size <= MAX_FILE_BYTES && !(await looksBinary(file))) {
              const content = await file.text()
              refreshedTabs.push({ ...tab, content, savedContent: content, dirty: false })
            } else {
              refreshedTabs.push(tab)
            }
          } catch {
            refreshedTabs.push(tab)
          }
        }
        tabsRef.current = refreshedTabs
        setTabs(refreshedTabs)
        setActivePath(current => refreshedTabs.some(tab => tab.path === current) ? current : refreshedTabs[0]?.path || "")
        setContextPaths(current => current.filter(path => fileHandles.has(path)))
      }
    } catch (scanError) {
      setError(scanError.message || String(scanError))
      throw scanError
    } finally {
      setScanning(false)
    }
  }, [])

  const selectDirectory = useCallback(async () => {
    if (!supported) throw new Error("Seu navegador não oferece File System Access API. Use Chrome ou Edge recente para editar arquivos locais.")
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "ai-memory-local-workspace" })
    const permission = await handle.requestPermission({ mode: "readwrite" })
    if (permission !== "granted") throw new Error("Acesso de leitura e escrita à pasta não foi autorizado.")
    await scan(handle, true)
    setWorkspaceSession(current => current + 1)
    return handle
  }, [scan, supported])

  const refresh = useCallback(async () => {
    if (rootHandle) await scan(rootHandle)
  }, [rootHandle, scan])

  const readPath = useCallback(async path => {
    const normalized = safeRelativePath(path)
    const handle = fileHandlesRef.current.get(normalized)
    if (!handle) throw new Error(`Arquivo não encontrado: ${normalized}`)
    const file = await handle.getFile()
    if (file.size > MAX_FILE_BYTES) throw new Error(`Arquivo maior que ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB: ${normalized}`)
    if (await looksBinary(file)) throw new Error(`Arquivo binário não pode ser aberto no editor: ${normalized}`)
    return file.text()
  }, [])

  const openFile = useCallback(async path => {
    const normalized = safeRelativePath(path)
    const current = tabsRef.current.find(tab => tab.path === normalized)
    if (current) {
      setActivePath(normalized)
      return current
    }
    const content = await readPath(normalized)
    const tab = { path: normalized, name: basename(normalized), content, savedContent: content, dirty: false, language: languageFor(normalized) }
    setTabs(values => [...values, tab])
    setActivePath(normalized)
    return tab
  }, [readPath])

  const updateContent = useCallback((path, content) => {
    const normalized = normalizePath(path)
    setTabs(values => values.map(tab => tab.path === normalized ? { ...tab, content, dirty: content !== tab.savedContent } : tab))
  }, [])

  const getDirectoryForPath = useCallback(async (path, create = false) => {
    if (!rootHandle) throw new Error("Selecione uma pasta de projeto primeiro.")
    const normalized = normalizePath(path)
    if (!normalized) return rootHandle
    const cached = directoryHandlesRef.current.get(normalized)
    if (cached && !create) return cached
    let directory = rootHandle
    let current = ""
    for (const segment of normalized.split("/").filter(Boolean)) {
      directory = await directory.getDirectoryHandle(segment, { create })
      current = current ? `${current}/${segment}` : segment
      directoryHandlesRef.current.set(current, directory)
    }
    return directory
  }, [rootHandle])

  const getFileHandle = useCallback(async (path, create = false) => {
    const normalized = safeRelativePath(path)
    const cached = fileHandlesRef.current.get(normalized)
    if (cached && !create) return cached
    const directory = await getDirectoryForPath(parentPath(normalized), create)
    const handle = await directory.getFileHandle(basename(normalized), { create })
    fileHandlesRef.current.set(normalized, handle)
    return handle
  }, [getDirectoryForPath])

  const writePath = useCallback(async (path, content) => {
    const normalized = safeRelativePath(path)
    const handle = await getFileHandle(normalized, true)
    const writable = await handle.createWritable()
    await writable.write(String(content ?? ""))
    await writable.close()
    return normalized
  }, [getFileHandle])

  const saveFile = useCallback(async path => {
    const normalized = normalizePath(path)
    const tab = tabsRef.current.find(item => item.path === normalized)
    if (!tab) return
    await writePath(normalized, tab.content)
    setTabs(values => values.map(item => item.path === normalized ? { ...item, savedContent: item.content, dirty: false } : item))
  }, [writePath])

  const saveAll = useCallback(async () => {
    const dirty = tabsRef.current.filter(tab => tab.dirty)
    for (const tab of dirty) await writePath(tab.path, tab.content)
    if (dirty.length) setTabs(values => values.map(tab => tab.dirty ? { ...tab, savedContent: tab.content, dirty: false } : tab))
    return dirty.length
  }, [writePath])

  const closeTab = useCallback(path => {
    const normalized = normalizePath(path)
    const current = tabsRef.current.find(tab => tab.path === normalized)
    if (current?.dirty && !window.confirm(`Descartar alterações não salvas em ${current.name}?`)) return
    setTabs(values => {
      const index = values.findIndex(tab => tab.path === normalized)
      const next = values.filter(tab => tab.path !== normalized)
      setActivePath(active => active === normalized ? (next[Math.max(0, index - 1)]?.path || next[0]?.path || "") : active)
      return next
    })
  }, [])

  const createFile = useCallback(async path => {
    const normalized = safeRelativePath(path)
    let exists = false
    try {
      await getFileHandle(normalized, false)
      exists = true
    } catch (lookupError) {
      if (lookupError?.name !== "NotFoundError") throw lookupError
    }
    if (exists) throw new Error(`O arquivo ${normalized} já existe.`)
    await writePath(normalized, "")
    await scan(rootHandle)
    await openFile(normalized)
  }, [getFileHandle, openFile, rootHandle, scan, writePath])

  const toggleContext = useCallback(path => {
    const normalized = normalizePath(path)
    setContextPaths(values => values.includes(normalized) ? values.filter(item => item !== normalized) : [...values, normalized].slice(-MAX_CONTEXT_FILES))
  }, [])

  const buildAgentContext = useCallback(async prompt => {
    if (!rootHandle) return null
    await saveAll()
    const tokens = tokenize(prompt)
    const priority = []
    const add = path => {
      const normalized = normalizePath(path)
      if (normalized && fileHandlesRef.current.has(normalized) && !priority.includes(normalized)) priority.push(normalized)
    }
    add(activePath)
    for (const tab of tabsRef.current) add(tab.path)
    for (const path of contextPaths) add(path)

    const scored = filePaths.map(path => {
      const lower = path.toLowerCase()
      const name = basename(path).toLowerCase()
      let score = 0
      for (const token of tokens) {
        if (name.includes(token)) score += 6
        else if (lower.includes(token)) score += 2
      }
      if (/^(readme|package\.json|cargo\.toml|go\.mod|pom\.xml|build\.gradle|pyproject\.toml|requirements\.txt|dockerfile)$/i.test(basename(path))) score += 1
      return { path, score }
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    for (const item of scored) add(item.path)

    const files = []
    let totalBytes = 0
    for (const path of priority) {
      if (files.length >= MAX_CONTEXT_FILES || totalBytes >= MAX_CONTEXT_BYTES) break
      try {
        const tab = tabsRef.current.find(item => item.path === path)
        const content = tab ? tab.content : await readPath(path)
        const bytes = new TextEncoder().encode(content).byteLength
        if (bytes > MAX_FILE_BYTES || totalBytes + bytes > MAX_CONTEXT_BYTES) continue
        files.push({ path, content, sha256: await hashText(content), language: languageFor(path) })
        totalBytes += bytes
      } catch {
      }
    }

    return {
      rootName,
      activeFile: activePath || null,
      manifest: filePaths.slice(0, MAX_TREE_FILES),
      manifestTruncated: filePaths.length >= MAX_TREE_FILES,
      files,
      stats: { fileCount: filePaths.length, contextFileCount: files.length, contextBytes: totalBytes }
    }
  }, [activePath, contextPaths, filePaths, readPath, rootHandle, rootName, saveAll])

  const removePath = useCallback(async path => {
    const normalized = safeRelativePath(path)
    const directory = await getDirectoryForPath(parentPath(normalized), false)
    await directory.removeEntry(basename(normalized), { recursive: false })
    fileHandlesRef.current.delete(normalized)
  }, [getDirectoryForPath])

  const readCurrentDisk = useCallback(async path => {
    try {
      const handle = await getFileHandle(path, false)
      const file = await handle.getFile()
      if (await looksBinary(file)) throw new Error(`Arquivo binário não pode ser alterado: ${path}`)
      if (file.size > MAX_FILE_BYTES) throw new Error(`Arquivo excede o limite do editor: ${path}`)
      return { exists: true, content: await file.text() }
    } catch (readError) {
      if (readError?.name === "NotFoundError") return { exists: false, content: "" }
      throw readError
    }
  }, [getFileHandle])

  const applyChangePlan = useCallback(async plan => {
    if (!rootHandle) throw new Error("Selecione a pasta do projeto antes de aplicar alterações.")
    const operations = Array.isArray(plan?.operations) ? plan.operations : []
    if (!operations.length) throw new Error("O agente não retornou operações de código aplicáveis.")
    const preflight = []
    const conflicts = []

    for (const operation of operations) {
      const path = safeRelativePath(operation.path)
      const current = await readCurrentDisk(path)
      const currentHash = current.exists ? await hashText(current.content) : null
      const openTab = tabsRef.current.find(tab => tab.path === path)
      const editorHash = openTab?.dirty ? await hashText(openTab.content) : null
      if (operation.expectedExists === true && !operation.baseSha256) conflicts.push({ path, expected: "verified source context", actual: "file was not supplied to the agent" })
      if (operation.baseSha256 && currentHash !== operation.baseSha256) conflicts.push({ path, expected: operation.baseSha256, actual: currentHash })
      if (openTab?.dirty && (!operation.baseSha256 || editorHash !== operation.baseSha256)) conflicts.push({ path, expected: operation.baseSha256 || "unchanged editor state", actual: `unsaved:${editorHash}` })
      if (operation.expectedExists === true && !current.exists) conflicts.push({ path, expected: "existing file", actual: "missing" })
      if (operation.expectedExists === false && current.exists && !operation.baseSha256) conflicts.push({ path, expected: "new file", actual: "already exists" })
      preflight.push({ operation: { ...operation, path }, before: current })
    }

    if (conflicts.length) {
      const conflictError = new Error(`Conflito detectado em ${conflicts.length} arquivo(s). Atualize o contexto antes de aplicar.`)
      conflictError.code = "WORKSPACE_CONFLICT"
      conflictError.conflicts = conflicts
      throw conflictError
    }

    const applied = []
    const attempted = []
    try {
      for (const item of preflight) {
        attempted.push(item)
        if (item.operation.type === "write") {
          await writePath(item.operation.path, item.operation.content)
          applied.push({ type: "write", path: item.operation.path })
        } else if (item.operation.type === "delete") {
          if (item.before.exists) await removePath(item.operation.path)
          applied.push({ type: "delete", path: item.operation.path })
        } else {
          throw new Error(`Operação não suportada: ${item.operation.type}`)
        }
      }
    } catch (applyError) {
      for (const item of [...attempted].reverse()) {
        try {
          if (item.before.exists) await writePath(item.operation.path, item.before.content)
          else {
            const current = await readCurrentDisk(item.operation.path)
            if (current.exists) await removePath(item.operation.path)
          }
        } catch {
        }
      }
      throw new Error(`Falha ao aplicar alterações; rollback executado: ${applyError.message || applyError}`)
    }

    await scan(rootHandle)
    const appliedPaths = new Set(applied.map(item => item.path))
    const nextTabs = []
    for (const tab of tabsRef.current) {
      if (!appliedPaths.has(tab.path)) {
        nextTabs.push(tab)
        continue
      }
      if (applied.find(item => item.path === tab.path && item.type === "delete")) continue
      const content = await readPath(tab.path)
      nextTabs.push({ ...tab, content, savedContent: content, dirty: false })
    }
    setTabs(nextTabs)
    setActivePath(current => nextTabs.some(tab => tab.path === current) ? current : nextTabs[0]?.path || "")
    return { status: "applied", workspace: rootName, files: applied, appliedAt: new Date().toISOString() }
  }, [readCurrentDisk, readPath, removePath, rootHandle, rootName, scan, writePath])

  const activeTab = useMemo(() => tabs.find(tab => tab.path === activePath) || null, [activePath, tabs])
  const dirtyCount = useMemo(() => tabs.filter(tab => tab.dirty).length, [tabs])

  return {
    supported,
    isReady: Boolean(rootHandle),
    rootName,
    tree,
    filePaths,
    tabs,
    activePath,
    activeTab,
    contextPaths,
    scanning,
    error,
    dirtyCount,
    autoApply,
    workspaceSession,
    setAutoApply,
    selectDirectory,
    refresh,
    openFile,
    setActivePath,
    updateContent,
    saveFile,
    saveAll,
    closeTab,
    createFile,
    toggleContext,
    buildAgentContext,
    applyChangePlan
  }
}
