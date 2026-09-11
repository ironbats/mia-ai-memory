import crypto from "node:crypto"
import { config } from "./config.js"
import { core } from "./core-client.js"
import { repository } from "./repository.js"

const sameTimestamp = (left, right) => {
  if (!left || !right) return false
  const a = Date.parse(left)
  const b = Date.parse(right)
  return Number.isFinite(a) && Number.isFinite(b) && a === b
}

const asArray = value => Array.isArray(value) ? value : []

const safeMessage = error => String(error?.message || error || "unknown sync error")
  .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://***@")
  .replace(/(authorization|x-admin-token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=***")
  .slice(0, 1800)

const wrapSyncError = (stage, error) => {
  if (error?.syncStage) return error
  const wrapped = new Error(`${stage}: ${safeMessage(error)}`)
  wrapped.cause = error
  wrapped.status = 502
  wrapped.expose = true
  wrapped.syncStage = stage
  return wrapped
}

const runStage = async (stage, task) => {
  try {
    return await task()
  } catch (error) {
    throw wrapSyncError(stage, error)
  }
}

const parseRelations = (workspace, project, frontmatter, knownPaths) => {
  const relations = frontmatter?.relations
  if (!relations || typeof relations !== "object" || Array.isArray(relations)) return []
  const out = []
  for (const [type, targets] of Object.entries(relations)) {
    for (const target of asArray(targets)) {
      if (typeof target !== "string" || !target.trim()) continue
      out.push({
        type,
        toWorkspace: workspace,
        toProject: project,
        toPath: target.trim(),
        resolved: knownPaths.has(target.trim())
      })
    }
  }
  return out
}

const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

const fetchAllSessions = async (workspace, project) => {
  const all = []
  const limit = 100
  let offset = 0
  while (true) {
    const page = await core.sessions(workspace, project, limit, offset)
    const sessions = asArray(page.sessions)
    all.push(...sessions)
    if (sessions.length < limit) return all
    offset += sessions.length
  }
}

const syncProject = async (runId, projectSummary) => {
  const workspace = projectSummary.workspace_name
  const project = projectSummary.project_name
  const scopeName = `${workspace}/${project}`

  await runStage(`persist scope ${scopeName}`, () => repository.upsertScope({
    workspace,
    project,
    pageCount: projectSummary.page_count,
    lastUpdated: projectSummary.last_updated
  }))

  const [pages, sessions, handoffsPayload, overview] = await Promise.all([
    runStage(`read pages ${scopeName}`, () => core.pages(workspace, project)),
    runStage(`read sessions ${scopeName}`, () => fetchAllSessions(workspace, project)),
    runStage(`read handoffs ${scopeName}`, () => core.handoffs(workspace, project)),
    runStage(`read overview ${scopeName}`, () => core.overview(workspace, project))
  ])

  const pageList = asArray(pages)
  const versions = await runStage(`read local versions ${scopeName}`, () => repository.memoryVersions(workspace, project))
  const knownPaths = new Set(pageList.map(page => page.path))

  await mapLimit(pageList, config.syncPageConcurrency, async summary => {
    const path = String(summary?.path || "").trim()
    if (!path) throw wrapSyncError(`sync page ${scopeName}`, new Error("core returned a page without path"))
    const existingUpdatedAt = versions.get(path)
    if (sameTimestamp(existingUpdatedAt, summary.updated_at)) return
    await runStage(`sync page ${scopeName}/${path}`, async () => {
      const page = await core.page(workspace, project, path)
      const provenance = page.frontmatter?.provenance || {}
      const sourceSessionId = provenance.session_id || page.frontmatter?.session_id || null
      const sourceAgent = provenance.agent || page.frontmatter?.agent || null
      await repository.upsertMemory({
        workspace,
        project,
        path: page.path,
        title: page.title,
        kind: page.kind,
        tier: page.tier,
        pinned: page.pinned === true,
        createdAt: page.created_at || null,
        updatedAt: page.updated_at || summary.updated_at || null,
        sourceSessionId,
        sourceAgent,
        provenance,
        frontmatter: page.frontmatter || {},
        bodyMarkdown: page.body_markdown || ""
      }, runId)
      await repository.replaceRelations(workspace, project, page.path, parseRelations(workspace, project, page.frontmatter, knownPaths), runId)
    })
  })

  await runStage(`prune memories ${scopeName}`, () => repository.pruneMemories(workspace, project, pageList.map(page => page.path)))
  await runStage(`persist sessions ${scopeName}`, () => repository.upsertSessions(workspace, project, sessions, runId))
  await runStage(`prune sessions ${scopeName}`, () => repository.pruneSessions(workspace, project, runId))
  await runStage(`persist handoffs ${scopeName}`, () => repository.upsertHandoffs(workspace, project, asArray(handoffsPayload.handoffs), runId))

  const health = overview?.health && typeof overview.health === "object" ? overview.health : {}
  await runStage(`reset health ${scopeName}`, () => repository.resetHealthFlags(workspace, project))
  await runStage(`mark health ${scopeName}`, () => repository.markHealth(workspace, project, health))
  await runStage(`persist health ${scopeName}`, () => repository.insertHealth(workspace, project, health))
}

const normalizeScope = input => {
  const workspace = String(input?.workspace || "").trim()
  const project = String(input?.project || "").trim()
  return workspace && project ? { workspace, project } : {}
}

const mergeScope = (left, right) => {
  if (!left) return right
  if (!right) return left
  if (!left.workspace || !right.workspace) return {}
  if (left.workspace === right.workspace && left.project === right.project) return left
  return {}
}

const executeSync = async scope => {
  const { workspace, project } = scope
  const runId = crypto.randomUUID()
  await runStage("start sync run", () => repository.beginSync(runId, workspace, project))
  try {
    const workspaces = asArray(await runStage("discover workspaces", () => core.workspaces()))
    const selectedWorkspaces = workspace ? workspaces.filter(item => item.workspace_name === workspace) : workspaces
    if (workspace && !selectedWorkspaces.length) throw wrapSyncError("discover workspace", new Error(`workspace ${workspace} was not found in AI Memory core`))

    const activeScopes = []
    for (const workspaceSummary of selectedWorkspaces) {
      const workspaceName = workspaceSummary.workspace_name
      const projects = asArray(await runStage(`discover projects ${workspaceName}`, () => core.projects(workspaceName)))
      const selectedProjects = project ? projects.filter(item => item.project_name === project) : projects
      if (project && workspaceName === workspace && !selectedProjects.length) throw wrapSyncError("discover project", new Error(`project ${workspace}/${project} was not found in AI Memory core`))
      for (const projectSummary of selectedProjects) {
        activeScopes.push({ workspace: projectSummary.workspace_name, project: projectSummary.project_name })
        await syncProject(runId, projectSummary)
      }
    }

    if (!workspace && !project) await runStage("prune scopes", () => repository.pruneScopes(activeScopes))

    const [graph, activity] = await Promise.all([
      runStage("read cross-project graph", () => core.graph()),
      runStage("read client activity", () => core.activity())
    ])
    await runStage("persist cross-project graph", () => repository.replaceCrossProjectEdges(asArray(graph.edges), runId))
    await runStage("persist client activity", () => repository.upsertClientActivity(asArray(activity.clients)))
    await runStage("finish sync run", () => repository.finishSync(runId, "succeeded"))
    return { runId, status: "succeeded", scopes: activeScopes.length }
  } catch (error) {
    const wrapped = error?.syncStage ? error : wrapSyncError("cognitive sync", error)
    try {
      await repository.finishSync(runId, "failed", safeMessage(wrapped))
    } catch (finishError) {
      console.error(JSON.stringify({ level: "error", event: "cognitive_sync_status_write_failed", runId, error: safeMessage(finishError) }))
    }
    throw wrapped
  }
}

let running = null
let pendingScope = null
let requestedScope = null
let requestedTimer = null

const drainPending = () => {
  if (!pendingScope) return
  const next = pendingScope
  pendingScope = null
  setTimeout(() => {
    syncCognitiveReadModel(next).catch(error => {
      console.error(JSON.stringify({ level: "error", event: "cognitive_sync_retry_failed", error: safeMessage(error) }))
    })
  }, 0)
}

export const syncCognitiveReadModel = async input => {
  const scope = normalizeScope(input)
  if (running) {
    pendingScope = mergeScope(pendingScope, scope)
    return running
  }

  running = executeSync(scope)
  try {
    return await running
  } finally {
    running = null
    drainPending()
  }
}

export const requestCognitiveSync = (input, delayMs = 800) => {
  const scope = normalizeScope(input)
  requestedScope = mergeScope(requestedScope, scope)
  if (requestedTimer) return
  requestedTimer = setTimeout(() => {
    const next = requestedScope || {}
    requestedScope = null
    requestedTimer = null
    syncCognitiveReadModel(next).catch(error => {
      console.error(JSON.stringify({ level: "error", event: "cognitive_sync_requested_failed", error: safeMessage(error) }))
    })
  }, Math.max(0, Number(delayMs) || 0))
}

export const startSyncLoop = () => {
  if (!config.syncEnabled) return () => {}
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    try {
      await syncCognitiveReadModel()
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "cognitive_sync_failed", error: safeMessage(error) }))
    }
    if (!stopped) timer = setTimeout(tick, config.syncIntervalMs)
  }
  timer = setTimeout(tick, 1000)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (requestedTimer) clearTimeout(requestedTimer)
  }
}
