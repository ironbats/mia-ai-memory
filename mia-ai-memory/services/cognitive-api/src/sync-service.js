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
  await repository.upsertScope({
    workspace,
    project,
    pageCount: projectSummary.page_count,
    lastUpdated: projectSummary.last_updated
  })

  const [pages, sessions, handoffsPayload, overview, contradictionsPayload] = await Promise.all([
    core.pages(workspace, project),
    fetchAllSessions(workspace, project),
    core.handoffs(workspace, project),
    core.overview(workspace, project),
    core.contradictions(workspace, project)
  ])

  const pageList = asArray(pages)
  const versions = await repository.memoryVersions(workspace, project)
  const knownPaths = new Set(pageList.map(page => page.path))
  await mapLimit(pageList, config.syncPageConcurrency, async summary => {
    const existingUpdatedAt = versions.get(summary.path)
    if (sameTimestamp(existingUpdatedAt, summary.updated_at)) return
    const page = await core.page(workspace, project, summary.path)
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

  await repository.pruneMemories(workspace, project, pageList.map(page => page.path))
  await repository.upsertSessions(workspace, project, sessions, runId)
  await repository.pruneSessions(workspace, project, runId)
  await repository.upsertHandoffs(workspace, project, asArray(handoffsPayload.handoffs), runId)
  const health = {
    ...(overview.health || {}),
    contradictions: asArray(contradictionsPayload.contradictions).length,
    contradiction_pages: asArray(contradictionsPayload.contradictions).map(item => ({ workspace, project, ...item }))
  }
  await repository.resetHealthFlags(workspace, project)
  await repository.markHealth(workspace, project, health)
  await repository.insertHealth(workspace, project, health)
}

let running = null

export const syncCognitiveReadModel = async ({ workspace, project } = {}) => {
  if (running) return running
  running = (async () => {
    const runId = crypto.randomUUID()
    await repository.beginSync(runId, workspace, project)
    try {
      const workspaces = asArray(await core.workspaces())
      const selectedWorkspaces = workspace ? workspaces.filter(item => item.workspace_name === workspace) : workspaces
      const activeScopes = []
      for (const workspaceSummary of selectedWorkspaces) {
        const projects = asArray(await core.projects(workspaceSummary.workspace_name))
        const selectedProjects = project ? projects.filter(item => item.project_name === project) : projects
        for (const projectSummary of selectedProjects) {
          activeScopes.push({ workspace: projectSummary.workspace_name, project: projectSummary.project_name })
          await syncProject(runId, projectSummary)
        }
      }
      if (!workspace && !project) await repository.pruneScopes(activeScopes)
      const [graph, activity] = await Promise.all([core.graph(), core.activity()])
      await repository.replaceCrossProjectEdges(asArray(graph.edges), runId)
      await repository.upsertClientActivity(asArray(activity.clients))
      await repository.finishSync(runId, "succeeded")
      return { runId, status: "succeeded" }
    } catch (error) {
      await repository.finishSync(runId, "failed", String(error?.message || error).slice(0, 4000))
      throw error
    } finally {
      running = null
    }
  })()
  return running
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
      console.error(JSON.stringify({ level: "error", event: "cognitive_sync_failed", error: String(error?.message || error) }))
    }
    if (!stopped) timer = setTimeout(tick, config.syncIntervalMs)
  }
  timer = setTimeout(tick, 1000)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
