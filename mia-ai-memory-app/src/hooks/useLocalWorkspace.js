import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { listWorkspaceProjects, readActiveWorkspaceProjectId, removeWorkspaceProject as removeWorkspaceProjectRecord, sameWorkspaceHandle, saveActiveWorkspaceProjectId, saveWorkspaceProject } from "../lib/workspaceProjectRegistry.js"

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

const readHandleFile = async (directoryHandle, filePath) => {
  let current = directoryHandle
  const segments = normalizePath(filePath).split("/").filter(Boolean)
  for (const segment of segments.slice(0, -1)) current = await current.getDirectoryHandle(segment)
  const handle = await current.getFileHandle(segments[segments.length - 1])
  return (await handle.getFile()).text()
}

const detectGit = async rootHandle => {
  if (!rootHandle) return { repository: false, branch: "", head: "", detached: false, worktree: false }
  try {
    const gitDirectory = await rootHandle.getDirectoryHandle(".git")
    const headText = (await readHandleFile(gitDirectory, "HEAD")).trim()
    if (headText.startsWith("ref:")) {
      const ref = headText.slice(4).trim()
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
      let head = ""
      try {
        head = (await readHandleFile(gitDirectory, ref)).trim()
      } catch {
        try {
          const packed = await readHandleFile(gitDirectory, "packed-refs")
          const match = packed.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith("#") && !line.startsWith("^") && line.endsWith(` ${ref}`))
          head = match ? match.split(/\s+/)[0] : ""
        } catch {
        }
      }
      return { repository: true, branch, head, detached: false, worktree: false }
    }
    return { repository: true, branch: "", head: /^[a-f0-9]{40,64}$/i.test(headText) ? headText : "", detached: true, worktree: false }
  } catch (directoryError) {
    if (directoryError?.name !== "TypeMismatchError" && directoryError?.name !== "NotFoundError") return { repository: false, branch: "", head: "", detached: false, worktree: false }
  }
  try {
    const gitFile = await rootHandle.getFileHandle(".git")
    const content = await (await gitFile.getFile()).text()
    const worktree = /^gitdir:\s*/im.test(content)
    return { repository: worktree, branch: "", head: "", detached: false, worktree }
  } catch {
    return { repository: false, branch: "", head: "", detached: false, worktree: false }
  }
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
  const [gitRepository, setGitRepository] = useState(false)
  const [gitBranch, setGitBranch] = useState("")
  const [gitHead, setGitHead] = useState("")
  const [gitDetached, setGitDetached] = useState(false)
  const [gitWorktree, setGitWorktree] = useState(false)
  const [sessionChanges, setSessionChanges] = useState([])
  const [projects, setProjects] = useState([])
  const [activeProjectId, setActiveProjectId] = useState("")
  const [projectSwitching, setProjectSwitching] = useState(false)
  const [projectRegistryReady, setProjectRegistryReady] = useState(false)
  const [projectRegistryPersistent, setProjectRegistryPersistent] = useState(true)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const fileHandlesRef = useRef(new Map())
  const directoryHandlesRef = useRef(new Map())
  const tabsRef = useRef([])
  const baselineRef = useRef(new Map())
  const sessionChangesRef = useRef([])
  const projectsRef = useRef([])
  const activeProjectIdRef = useRef("")
  const projectSessionsRef = useRef(new Map())
  const workspaceOperationsRef = useRef(0)
  const projectTransitionRef = useRef(false)

  const runWorkspaceOperation = useCallback(async operation => {
    if (projectTransitionRef.current) throw new Error("Aguarde a troca de projeto terminar antes de executar esta ação.")
    workspaceOperationsRef.current += 1
    setWorkspaceBusy(true)
    try {
      return await operation()
    } finally {
      workspaceOperationsRef.current = Math.max(0, workspaceOperationsRef.current - 1)
      if (!workspaceOperationsRef.current) setWorkspaceBusy(false)
    }
  }, [])

  const commitProjects = useCallback(updater => {
    const current = projectsRef.current
    const next = typeof updater === "function" ? updater(current) : updater
    const normalized = Array.isArray(next) ? next : []
    projectsRef.current = normalized
    setProjects(normalized)
    return normalized
  }, [])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    sessionChangesRef.current = sessionChanges
  }, [sessionChanges])

  const trackChange = useCallback(({ path, before = "", beforeExists = true, after = "", afterExists = true, origin = "editor" }) => {
    const normalized = normalizePath(path)
    if (!normalized) return
    if (!baselineRef.current.has(normalized)) baselineRef.current.set(normalized, { exists: beforeExists, content: String(before ?? "") })
    const baseline = baselineRef.current.get(normalized)
    const changed = baseline.exists !== afterExists || baseline.content !== String(after ?? "")
    setSessionChanges(values => {
      const remaining = values.filter(item => item.path !== normalized)
      const next = changed ? [...remaining, {
        path: normalized,
        before: baseline.content,
        beforeExists: baseline.exists,
        after: String(after ?? ""),
        afterExists,
        origin,
        updatedAt: new Date().toISOString()
      }].sort((a, b) => a.path.localeCompare(b.path)) : remaining
      sessionChangesRef.current = next
      return next
    })
  }, [])

  const captureActiveProject = useCallback(() => {
    const projectId = activeProjectIdRef.current
    if (!projectId || !rootHandle) return null
    const snapshot = {
      id: projectId,
      handle: rootHandle,
      rootName,
      tree,
      filePaths,
      tabs,
      activePath,
      contextPaths,
      gitRepository,
      gitBranch,
      gitHead,
      gitDetached,
      gitWorktree,
      sessionChanges,
      fileHandles: new Map(fileHandlesRef.current),
      directoryHandles: new Map(directoryHandlesRef.current),
      baseline: new Map(baselineRef.current)
    }
    projectSessionsRef.current.set(projectId, snapshot)
    commitProjects(values => values.map(project => project.id === projectId ? {
      ...project,
      name: rootName || project.name,
      fileCount: filePaths.length,
      dirtyCount: tabs.filter(tab => tab.dirty).length,
      gitRepository,
      gitBranch,
      loaded: true
    } : project))
    return snapshot
  }, [activePath, commitProjects, contextPaths, filePaths, gitBranch, gitDetached, gitHead, gitRepository, gitWorktree, rootHandle, rootName, sessionChanges, tabs, tree])

  const restoreWorkspaceSession = useCallback(snapshot => {
    if (!snapshot?.handle) return false
    fileHandlesRef.current = new Map(snapshot.fileHandles || [])
    directoryHandlesRef.current = new Map(snapshot.directoryHandles || [["", snapshot.handle]])
    baselineRef.current = new Map(snapshot.baseline || [])
    tabsRef.current = Array.isArray(snapshot.tabs) ? snapshot.tabs : []
    sessionChangesRef.current = Array.isArray(snapshot.sessionChanges) ? snapshot.sessionChanges : []
    setRootHandle(snapshot.handle)
    setRootName(snapshot.rootName || snapshot.handle.name || "workspace")
    setTree(Array.isArray(snapshot.tree) ? snapshot.tree : [])
    setFilePaths(Array.isArray(snapshot.filePaths) ? snapshot.filePaths : [])
    setTabs(tabsRef.current)
    setActivePath(snapshot.activePath || "")
    setContextPaths(Array.isArray(snapshot.contextPaths) ? snapshot.contextPaths : [])
    setGitRepository(snapshot.gitRepository === true)
    setGitBranch(snapshot.gitBranch || "")
    setGitHead(snapshot.gitHead || "")
    setGitDetached(snapshot.gitDetached === true)
    setGitWorktree(snapshot.gitWorktree === true)
    setSessionChanges(sessionChangesRef.current)
    setError("")
    setWorkspaceSession(current => current + 1)
    return true
  }, [])

  const clearWorkspace = useCallback(() => {
    fileHandlesRef.current = new Map()
    directoryHandlesRef.current = new Map()
    baselineRef.current = new Map()
    tabsRef.current = []
    sessionChangesRef.current = []
    setRootHandle(null)
    setRootName("")
    setTree([])
    setFilePaths([])
    setTabs([])
    setActivePath("")
    setContextPaths([])
    setGitRepository(false)
    setGitBranch("")
    setGitHead("")
    setGitDetached(false)
    setGitWorktree(false)
    setSessionChanges([])
    setError("")
    setWorkspaceSession(current => current + 1)
  }, [])

  const ensureDirectoryPermission = useCallback(async (handle, request = true) => {
    if (!handle) return "denied"
    let permission = "prompt"
    if (typeof handle.queryPermission === "function") {
      try {
        permission = await handle.queryPermission({ mode: "readwrite" })
      } catch {
        permission = "prompt"
      }
    }
    if (permission !== "granted" && request && typeof handle.requestPermission === "function") {
      permission = await handle.requestPermission({ mode: "readwrite" })
    }
    return permission
  }, [])

  const scan = useCallback(async (handle, resetWorkspace = false, targetProjectId = activeProjectIdRef.current) => {
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
      const git = await detectGit(handle)
      fileHandlesRef.current = fileHandles
      directoryHandlesRef.current = directoryHandles
      const sortedPaths = paths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
      setTree(nextTree)
      setFilePaths(sortedPaths)
      setRootHandle(handle)
      setRootName(handle.name || "workspace")
      setGitRepository(git.repository)
      setGitBranch(git.branch)
      setGitHead(git.head)
      setGitDetached(git.detached)
      setGitWorktree(git.worktree)
      if (resetWorkspace) {
        baselineRef.current = new Map()
        sessionChangesRef.current = []
        setSessionChanges([])
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
      if (targetProjectId) {
        commitProjects(values => values.map(project => project.id === targetProjectId ? {
          ...project,
          name: handle.name || project.name,
          fileCount: sortedPaths.length,
          dirtyCount: resetWorkspace ? 0 : tabsRef.current.filter(tab => tab.dirty).length,
          gitRepository: git.repository,
          gitBranch: git.branch,
          loaded: true,
          permission: "granted"
        } : project))
      }
    } catch (scanError) {
      setError(scanError.message || String(scanError))
      throw scanError
    } finally {
      setScanning(false)
    }
  }, [commitProjects])

  const switchProject = useCallback(async projectId => {
    const targetId = String(projectId || "")
    const target = projectsRef.current.find(project => project.id === targetId)
    if (!target) throw new Error("Projeto local não encontrado na IDE.")
    if (targetId === activeProjectIdRef.current && rootHandle) return target
    if (workspaceOperationsRef.current) throw new Error("Aguarde a operação atual da IDE terminar antes de trocar de projeto.")
    const previousId = activeProjectIdRef.current
    const previousSnapshot = captureActiveProject()
    projectTransitionRef.current = true
    setProjectSwitching(true)
    setError("")
    try {
      const permission = await ensureDirectoryPermission(target.handle, true)
      commitProjects(values => values.map(project => project.id === targetId ? { ...project, permission } : project))
      if (permission !== "granted") throw new Error(`Acesso de leitura e escrita ao projeto ${target.name} não foi autorizado.`)
      activeProjectIdRef.current = targetId
      setActiveProjectId(targetId)
      saveActiveWorkspaceProjectId(targetId)
      const snapshot = projectSessionsRef.current.get(targetId)
      if (snapshot?.handle) restoreWorkspaceSession(snapshot)
      else await scan(target.handle, true, targetId)
      const lastOpenedAt = new Date().toISOString()
      const persisted = { ...target, name: target.handle.name || target.name, lastOpenedAt, permission: "granted" }
      commitProjects(values => values.map(project => project.id === targetId ? { ...project, ...persisted } : project))
      saveWorkspaceProject(persisted).catch(() => setProjectRegistryPersistent(false))
      return persisted
    } catch (switchError) {
      if (previousId && previousSnapshot?.handle) {
        activeProjectIdRef.current = previousId
        setActiveProjectId(previousId)
        saveActiveWorkspaceProjectId(previousId)
        restoreWorkspaceSession(previousSnapshot)
      } else if (!previousId) {
        activeProjectIdRef.current = ""
        setActiveProjectId("")
        saveActiveWorkspaceProjectId("")
        clearWorkspace()
      }
      throw switchError
    } finally {
      projectTransitionRef.current = false
      setProjectSwitching(false)
    }
  }, [captureActiveProject, clearWorkspace, commitProjects, ensureDirectoryPermission, restoreWorkspaceSession, rootHandle, scan])

  const selectDirectory = useCallback(async () => {
    if (!supported) throw new Error("Seu navegador não oferece File System Access API. Use Chrome ou Edge recente para editar arquivos locais.")
    if (!projectRegistryReady) throw new Error("Aguarde a IDE carregar o registro local de projetos antes de adicionar outra pasta.")
    if (workspaceOperationsRef.current) throw new Error("Aguarde a operação atual da IDE terminar antes de adicionar outro projeto.")
    projectTransitionRef.current = true
    setProjectSwitching(true)
    setError("")
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "ai-memory-local-workspace" })
      const permission = await ensureDirectoryPermission(handle, true)
      if (permission !== "granted") throw new Error("Acesso de leitura e escrita à pasta não foi autorizado.")
      let existing = null
      for (const project of projectsRef.current) {
        if (await sameWorkspaceHandle(project.handle, handle)) {
          existing = project
          break
        }
      }
      if (existing) {
        projectTransitionRef.current = false
        setProjectSwitching(false)
        await switchProject(existing.id)
        return existing.handle
      }
      captureActiveProject()
      const now = new Date().toISOString()
      const project = {
        id: crypto.randomUUID(),
        name: handle.name || "workspace",
        handle,
        createdAt: now,
        lastOpenedAt: now,
        permission: "granted",
        fileCount: 0,
        dirtyCount: 0,
        gitRepository: false,
        gitBranch: "",
        loaded: false
      }
      commitProjects(values => [...values, project])
      activeProjectIdRef.current = project.id
      setActiveProjectId(project.id)
      saveActiveWorkspaceProjectId(project.id)
      saveWorkspaceProject(project).catch(() => setProjectRegistryPersistent(false))
      await scan(handle, true, project.id)
      return handle
    } finally {
      projectTransitionRef.current = false
      setProjectSwitching(false)
    }
  }, [captureActiveProject, commitProjects, ensureDirectoryPermission, projectRegistryReady, scan, supported, switchProject])

  const removeProject = useCallback(async projectId => {
    if (workspaceOperationsRef.current) throw new Error("Aguarde a operação atual da IDE terminar antes de remover um projeto.")
    const targetId = String(projectId || "")
    const currentProjects = projectsRef.current
    const index = currentProjects.findIndex(project => project.id === targetId)
    if (index < 0) return false
    const wasActive = activeProjectIdRef.current === targetId
    projectSessionsRef.current.delete(targetId)
    const remaining = currentProjects.filter(project => project.id !== targetId)
    commitProjects(remaining)
    removeWorkspaceProjectRecord(targetId).catch(() => setProjectRegistryPersistent(false))
    if (!wasActive) return true
    activeProjectIdRef.current = ""
    setActiveProjectId("")
    saveActiveWorkspaceProjectId("")
    clearWorkspace()
    const next = remaining[Math.min(index, remaining.length - 1)] || remaining[0] || null
    if (next) await switchProject(next.id)
    return true
  }, [clearWorkspace, commitProjects, switchProject])

  useEffect(() => {
    if (!supported) {
      setProjectRegistryReady(true)
      return undefined
    }
    let cancelled = false
    const loadRegistry = async () => {
      try {
        const records = await listWorkspaceProjects()
        if (cancelled) return
        const ordered = [...records].sort((left, right) => String(right.lastOpenedAt || "").localeCompare(String(left.lastOpenedAt || "")))
        const hydrated = []
        for (const record of ordered) {
          if (!record?.id || !record?.handle) continue
          const permission = await ensureDirectoryPermission(record.handle, false)
          hydrated.push({
            ...record,
            name: record.name || record.handle.name || "workspace",
            permission,
            fileCount: 0,
            dirtyCount: 0,
            gitRepository: false,
            gitBranch: "",
            loaded: false
          })
        }
        if (cancelled) return
        commitProjects(hydrated)
        setProjectRegistryReady(true)
        const rememberedId = readActiveWorkspaceProjectId()
        const preferred = hydrated.find(project => project.id === rememberedId && project.permission === "granted") || hydrated.find(project => project.permission === "granted") || null
        if (!preferred || cancelled) return
        activeProjectIdRef.current = preferred.id
        setActiveProjectId(preferred.id)
        saveActiveWorkspaceProjectId(preferred.id)
        projectTransitionRef.current = true
        setProjectSwitching(true)
        try {
          await scan(preferred.handle, true, preferred.id)
          const lastOpenedAt = new Date().toISOString()
          const persisted = { ...preferred, lastOpenedAt }
          commitProjects(values => values.map(project => project.id === preferred.id ? { ...project, lastOpenedAt } : project))
          saveWorkspaceProject(persisted).catch(() => setProjectRegistryPersistent(false))
        } finally {
          projectTransitionRef.current = false
          if (!cancelled) setProjectSwitching(false)
        }
      } catch {
        if (!cancelled) {
          setProjectRegistryPersistent(false)
          setProjectRegistryReady(true)
        }
      }
    }
    loadRegistry()
    return () => {
      cancelled = true
    }
  }, [commitProjects, ensureDirectoryPermission, scan, supported])

  const refresh = useCallback(async () => runWorkspaceOperation(async () => {
    if (!rootHandle) return
    const expectedProjectId = activeProjectId
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou antes da atualização da IDE.")
    await scan(rootHandle)
  }), [activeProjectId, rootHandle, runWorkspaceOperation, scan])

  useEffect(() => {
    if (!rootHandle) return undefined
    let disposed = false
    const refreshGitState = async () => {
      try {
        const git = await detectGit(rootHandle)
        if (disposed) return
        setGitRepository(git.repository)
        setGitBranch(git.branch)
        setGitHead(git.head)
        setGitDetached(git.detached)
        setGitWorktree(git.worktree)
      } catch {
      }
    }
    const timer = window.setInterval(refreshGitState, 4000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [rootHandle])

  const readPath = useCallback(async path => {
    const expectedProjectId = activeProjectId
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou durante a leitura do arquivo.")
    const normalized = safeRelativePath(path)
    const handle = fileHandlesRef.current.get(normalized)
    if (!handle) throw new Error(`Arquivo não encontrado: ${normalized}`)
    const file = await handle.getFile()
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou durante a leitura do arquivo.")
    if (file.size > MAX_FILE_BYTES) throw new Error(`Arquivo maior que ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB: ${normalized}`)
    if (await looksBinary(file)) throw new Error(`Arquivo binário não pode ser aberto no editor: ${normalized}`)
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou durante a leitura do arquivo.")
    const content = await file.text()
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou durante a leitura do arquivo.")
    return content
  }, [activeProjectId])

  const openFile = useCallback(async path => {
    const expectedProjectId = activeProjectId
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou antes da abertura do arquivo.")
    const normalized = safeRelativePath(path)
    const current = tabsRef.current.find(tab => tab.path === normalized)
    if (current) {
      setActivePath(normalized)
      return current
    }
    const content = await readPath(normalized)
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou durante a abertura do arquivo.")
    if (!baselineRef.current.has(normalized)) baselineRef.current.set(normalized, { exists: true, content })
    const tab = { path: normalized, name: basename(normalized), content, savedContent: content, dirty: false, language: languageFor(normalized) }
    setTabs(values => {
      const next = [...values, tab]
      tabsRef.current = next
      return next
    })
    setActivePath(normalized)
    return tab
  }, [activeProjectId, readPath])

  const updateContent = useCallback((path, content) => {
    const normalized = normalizePath(path)
    const current = tabsRef.current.find(tab => tab.path === normalized)
    const baseline = baselineRef.current.get(normalized) || { exists: true, content: current?.savedContent || "" }
    if (!baselineRef.current.has(normalized)) baselineRef.current.set(normalized, baseline)
    setTabs(values => {
      const next = values.map(tab => tab.path === normalized ? { ...tab, content, dirty: content !== tab.savedContent } : tab)
      tabsRef.current = next
      return next
    })
    trackChange({ path: normalized, before: baseline.content, beforeExists: baseline.exists, after: content, afterExists: true, origin: "editor" })
  }, [trackChange])

  const getDirectoryForPath = useCallback(async (path, create = false) => {
    if (!rootHandle) throw new Error("Selecione uma pasta de projeto primeiro.")
    if (activeProjectId && activeProjectIdRef.current !== activeProjectId) throw new Error("O projeto ativo mudou durante a operação de arquivos.")
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
  }, [activeProjectId, rootHandle])

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

  const saveFile = useCallback(async path => runWorkspaceOperation(async () => {
    const expectedProjectId = activeProjectId
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou antes de salvar o arquivo.")
    const normalized = normalizePath(path)
    const tab = tabsRef.current.find(item => item.path === normalized)
    if (!tab) return
    await writePath(normalized, tab.content)
    setTabs(values => {
      const next = values.map(item => item.path === normalized ? { ...item, savedContent: item.content, dirty: false } : item)
      tabsRef.current = next
      return next
    })
  }), [activeProjectId, runWorkspaceOperation, writePath])

  const saveAll = useCallback(async () => runWorkspaceOperation(async () => {
    const expectedProjectId = activeProjectId
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou antes de salvar os arquivos.")
    const dirty = tabsRef.current.filter(tab => tab.dirty)
    for (const tab of dirty) await writePath(tab.path, tab.content)
    if (dirty.length) setTabs(values => {
      const next = values.map(tab => tab.dirty ? { ...tab, savedContent: tab.content, dirty: false } : tab)
      tabsRef.current = next
      return next
    })
    return dirty.length
  }), [activeProjectId, runWorkspaceOperation, writePath])

  const closeTab = useCallback(path => {
    const normalized = normalizePath(path)
    const current = tabsRef.current.find(tab => tab.path === normalized)
    if (current?.dirty) {
      const baseline = baselineRef.current.get(normalized) || { exists: true, content: current.savedContent || "" }
      trackChange({ path: normalized, before: baseline.content, beforeExists: baseline.exists, after: current.savedContent || "", afterExists: true, origin: "editor" })
    }
    setTabs(values => {
      const index = values.findIndex(tab => tab.path === normalized)
      const next = values.filter(tab => tab.path !== normalized)
      tabsRef.current = next
      setActivePath(active => active === normalized ? (next[Math.max(0, index - 1)]?.path || next[0]?.path || "") : active)
      return next
    })
  }, [trackChange])

  const createFile = useCallback(async path => runWorkspaceOperation(async () => {
    const expectedProjectId = activeProjectId
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou antes da criação do arquivo.")
    const normalized = safeRelativePath(path)
    let exists = false
    try {
      await getFileHandle(normalized, false)
      exists = true
    } catch (lookupError) {
      if (lookupError?.name !== "NotFoundError") throw lookupError
    }
    if (exists) throw new Error(`O arquivo ${normalized} já existe.`)
    baselineRef.current.set(normalized, { exists: false, content: "" })
    await writePath(normalized, "")
    trackChange({ path: normalized, before: "", beforeExists: false, after: "", afterExists: true, origin: "create" })
    await scan(rootHandle)
    await openFile(normalized)
  }), [activeProjectId, getFileHandle, openFile, rootHandle, runWorkspaceOperation, scan, trackChange, writePath])

  const toggleContext = useCallback(path => {
    const normalized = normalizePath(path)
    setContextPaths(values => values.includes(normalized) ? values.filter(item => item !== normalized) : [...values, normalized].slice(-MAX_CONTEXT_FILES))
  }, [])

  const buildAgentContext = useCallback(async prompt => runWorkspaceOperation(async () => {
    if (!rootHandle) return null
    const expectedProjectId = activeProjectId || activeProjectIdRef.current
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou antes da preparação do contexto. Envie a solicitação novamente no projeto selecionado.")
    await saveAll()
    if (expectedProjectId && activeProjectIdRef.current !== expectedProjectId) throw new Error("O projeto ativo mudou durante a preparação do contexto. Envie a solicitação novamente no projeto selecionado.")
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
      projectId: expectedProjectId || null,
      rootName,
      activeFile: activePath || null,
      git: {
        repository: gitRepository,
        branch: gitBranch || null,
        head: gitHead || null,
        detached: gitDetached,
        worktree: gitWorktree
      },
      manifest: filePaths.slice(0, MAX_TREE_FILES),
      manifestTruncated: filePaths.length >= MAX_TREE_FILES,
      files,
      stats: { fileCount: filePaths.length, contextFileCount: files.length, contextBytes: totalBytes }
    }
  }), [activePath, activeProjectId, contextPaths, filePaths, gitBranch, gitDetached, gitHead, gitRepository, gitWorktree, readPath, rootHandle, rootName, runWorkspaceOperation, saveAll])

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

  const applyChangePlan = useCallback(async plan => runWorkspaceOperation(async () => {
    if (!rootHandle) throw new Error("Selecione a pasta do projeto antes de aplicar alterações.")
    if (!plan?.workspace?.projectId && projectsRef.current.length > 1) {
      const projectError = new Error("Este plano foi gerado antes do suporte multi-projeto e não possui identidade de workspace. Gere a alteração novamente no projeto ativo para aplicar com segurança.")
      projectError.code = "WORKSPACE_CONFLICT"
      projectError.conflicts = [{ path: "workspace", expected: activeProjectIdRef.current || "identified-project", actual: "legacy-plan-without-project-id" }]
      throw projectError
    }
    if (plan?.workspace?.projectId && activeProjectIdRef.current && plan.workspace.projectId !== activeProjectIdRef.current) {
      const target = projectsRef.current.find(project => project.id === plan.workspace.projectId)
      const projectError = new Error(`Este plano pertence ao projeto ${target?.name || plan.workspace.rootName || "selecionado anteriormente"}. Selecione esse projeto na IDE antes de aplicar.`)
      projectError.code = "WORKSPACE_CONFLICT"
      projectError.conflicts = [{ path: "workspace", expected: plan.workspace.projectId, actual: activeProjectIdRef.current }]
      throw projectError
    }
    if (plan?.workspace?.branch && gitBranch && plan.workspace.branch !== gitBranch) {
      const branchError = new Error(`Conflito de branch: o plano foi gerado em ${plan.workspace.branch}, mas o projeto está em ${gitBranch}. Atualize o contexto antes de aplicar.`)
      branchError.code = "WORKSPACE_CONFLICT"
      branchError.conflicts = [{ path: ".git/HEAD", expected: plan.workspace.branch, actual: gitBranch }]
      throw branchError
    }
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

    for (const item of preflight) {
      if (item.operation.type === "write") {
        trackChange({
          path: item.operation.path,
          before: item.before.content,
          beforeExists: item.before.exists,
          after: item.operation.content,
          afterExists: true,
          origin: "agent"
        })
      } else if (item.operation.type === "delete") {
        trackChange({
          path: item.operation.path,
          before: item.before.content,
          beforeExists: item.before.exists,
          after: "",
          afterExists: false,
          origin: "agent"
        })
      }
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
    tabsRef.current = nextTabs
    setTabs(nextTabs)
    setActivePath(current => nextTabs.some(tab => tab.path === current) ? current : nextTabs[0]?.path || "")
    return { status: "applied", projectId: activeProjectIdRef.current || null, workspace: rootName, branch: gitBranch || null, files: applied, appliedAt: new Date().toISOString() }
  }), [gitBranch, readCurrentDisk, readPath, removePath, rootHandle, rootName, runWorkspaceOperation, scan, trackChange, writePath])

  const activeTab = useMemo(() => tabs.find(tab => tab.path === activePath) || null, [activePath, tabs])
  const dirtyCount = useMemo(() => tabs.filter(tab => tab.dirty).length, [tabs])
  const projectItems = useMemo(() => projects.map(project => project.id === activeProjectId ? {
    ...project,
    name: rootName || project.name,
    fileCount: filePaths.length,
    dirtyCount,
    gitRepository,
    gitBranch,
    loaded: Boolean(rootHandle)
  } : project), [activeProjectId, dirtyCount, filePaths.length, gitBranch, gitRepository, projects, rootHandle, rootName])
  const activeProject = useMemo(() => projectItems.find(project => project.id === activeProjectId) || null, [activeProjectId, projectItems])

  return {
    supported,
    isReady: Boolean(rootHandle),
    projects: projectItems,
    activeProjectId,
    activeProject,
    projectSwitching,
    projectRegistryReady,
    projectRegistryPersistent,
    workspaceBusy,
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
    gitRepository,
    gitBranch,
    gitHead,
    gitHeadShort: gitHead ? gitHead.slice(0, 8) : "",
    gitDetached,
    gitWorktree,
    sessionChanges,
    setAutoApply,
    selectDirectory,
    switchProject,
    removeProject,
    refresh,
    readPath,
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
