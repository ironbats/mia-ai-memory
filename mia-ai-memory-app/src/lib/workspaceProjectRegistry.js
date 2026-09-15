const DB_NAME = "ai-memory-local-workspaces"
const DB_VERSION = 1
const STORE_NAME = "projects"
const ACTIVE_PROJECT_KEY = "ai-memory.ide.activeProjectId"

const indexedDbAvailable = () => typeof window !== "undefined" && Boolean(window.indexedDB)

const openDatabase = () => new Promise((resolve, reject) => {
  if (!indexedDbAvailable()) {
    resolve(null)
    return
  }
  const request = window.indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "id" })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error("Não foi possível abrir o registro local de projetos."))
})

const transactionResult = async (mode, executor) => {
  const database = await openDatabase()
  if (!database) return null
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    let result = null
    try {
      result = executor(store)
    } catch (error) {
      database.close()
      reject(error)
      return
    }
    transaction.oncomplete = () => {
      database.close()
      resolve(result?.result ?? result ?? null)
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error || new Error("Falha ao acessar o registro local de projetos."))
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error || new Error("Operação do registro local de projetos foi cancelada."))
    }
  })
}

export const listWorkspaceProjects = async () => {
  const database = await openDatabase()
  if (!database) return []
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly")
    const request = transaction.objectStore(STORE_NAME).getAll()
    request.onsuccess = () => {
      database.close()
      resolve(Array.isArray(request.result) ? request.result : [])
    }
    request.onerror = () => {
      database.close()
      reject(request.error || new Error("Não foi possível carregar os projetos locais."))
    }
  })
}

export const saveWorkspaceProject = async project => {
  if (!project?.id) return false
  const mode = project.mode === "portable" ? "portable" : project.mode === "runtime" ? "runtime" : "direct"
  if (mode === "direct" && !project.handle) return false
  if (mode === "portable" && !project.storageKey) return false
  if (mode === "runtime" && !project.runtimeWorkspaceId) return false
  const record = {
    id: String(project.id),
    name: String(project.name || project.handle?.name || "workspace"),
    mode,
    createdAt: String(project.createdAt || new Date().toISOString()),
    lastOpenedAt: String(project.lastOpenedAt || new Date().toISOString())
  }
  if (mode === "direct") record.handle = project.handle
  if (mode === "portable") record.storageKey = String(project.storageKey)
  if (mode === "runtime") record.runtimeWorkspaceId = String(project.runtimeWorkspaceId)
  await transactionResult("readwrite", store => store.put(record))
  return true
}

export const removeWorkspaceProject = async projectId => {
  if (!projectId) return false
  await transactionResult("readwrite", store => store.delete(String(projectId)))
  return true
}

export const readActiveWorkspaceProjectId = () => {
  if (typeof window === "undefined") return ""
  try {
    return String(window.localStorage.getItem(ACTIVE_PROJECT_KEY) || "")
  } catch {
    return ""
  }
}

export const saveActiveWorkspaceProjectId = projectId => {
  if (typeof window === "undefined") return
  try {
    if (projectId) window.localStorage.setItem(ACTIVE_PROJECT_KEY, String(projectId))
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY)
  } catch {
  }
}

export const sameWorkspaceHandle = async (left, right) => {
  if (!left || !right) return false
  if (left === right) return true
  if (typeof left.isSameEntry !== "function") return false
  try {
    return await left.isSameEntry(right)
  } catch {
    return false
  }
}
