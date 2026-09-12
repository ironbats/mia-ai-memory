import React, { useCallback, useEffect, useMemo, useState } from "react"
import ActivityFeed from "./components/ActivityFeed.jsx"
import BrainGraph from "./components/BrainGraph.jsx"
import ChatWorkspace from "./components/ChatWorkspace.jsx"
import CodeWorkspace from "./components/CodeWorkspace.jsx"
import EvolutionPanel from "./components/EvolutionPanel.jsx"
import HandoffFlow from "./components/HandoffFlow.jsx"
import IntegrationHub from "./components/IntegrationHub.jsx"
import MemoryDrawer from "./components/MemoryDrawer.jsx"
import MetricCard from "./components/MetricCard.jsx"
import OptimizationPanel from "./components/OptimizationPanel.jsx"
import SearchExplain from "./components/SearchExplain.jsx"
import { api } from "./lib/api.js"
import useLocalWorkspace from "./hooks/useLocalWorkspace.js"

const tabs = [
  ["brain", "Neural Brain"],
  ["health", "Memory Health"],
  ["integrations", "Configurar Agentes"],
  ["agents", "Activity & Handoffs"],
  ["evolution", "Time Travel"],
  ["search", "Explain Search"]
]

const number = value => new Intl.NumberFormat("pt-BR").format(Number(value || 0))
const percent = (value, total) => total ? `${Math.round(value / total * 100)}%` : "0%"
const resultValue = result => result?.status === "fulfilled" ? result.value : null
const resultFailure = (label, result) => result?.status === "rejected" ? `${label}: ${result.reason?.message || "falha ao carregar"}` : ""

const dataStatusMessage = (summaryData, failures) => {
  const parts = failures.filter(Boolean)
  if (summaryData?.sync?.status === "failed") {
    parts.unshift(`Sincronização cognitiva falhou: ${summaryData.sync.error || "consulte os logs do Cognitive API"}`)
  }
  if (summaryData?.observability?.read_model_complete === false) {
    const indexed = Number(summaryData?.memories?.indexed || 0)
    const total = Number(summaryData?.memories?.total || 0)
    parts.push(`Read model em atualização: ${indexed}/${total} memórias indexadas`)
  }
  return parts.join(" · ")
}

export default function App() {
  const [scopes, setScopes] = useState([])
  const [scope, setScope] = useState(null)
  const [summary, setSummary] = useState(null)
  const [brain, setBrain] = useState({ nodes: [], edges: [] })
  const [health, setHealth] = useState(null)
  const [agents, setAgents] = useState(null)
  const [handoffs, setHandoffs] = useState([])
  const [activity, setActivity] = useState([])
  const [memories, setMemories] = useState([])
  const [optimizations, setOptimizations] = useState([])
  const [tab, setTab] = useState("brain")
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [dataError, setDataError] = useState("")
  const [actionError, setActionError] = useState("")
  const [memory, setMemory] = useState(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [ideOpen, setIdeOpen] = useState(false)
  const [ideLayout, setIdeLayout] = useState("split")
  const localWorkspace = useLocalWorkspace()

  const scopeKey = scope ? `${scope.workspace}/${scope.project}` : ""

  const loadScopes = useCallback(async () => {
    const data = await api.scopes()
    const values = (data.scopes || []).map(item => ({ workspace: item.workspace, project: item.project }))
    setScopes(values)
    setScope(current => current && values.some(item => item.workspace === current.workspace && item.project === current.project) ? current : values[0] || null)
    return values
  }, [])

  const loadScopeData = useCallback(async current => {
    if (!current) return
    setLoading(true)
    setActionError("")
    const results = await Promise.allSettled([
      api.summary(current),
      api.brain(current),
      api.health(current),
      api.agents(current),
      api.handoffs(current, 80),
      api.activity(current, 80),
      api.memories(current, 300),
      api.optimization(current, 200)
    ])

    const summaryData = resultValue(results[0])
    const brainData = resultValue(results[1])
    const healthData = resultValue(results[2])
    const agentsData = resultValue(results[3])
    const handoffData = resultValue(results[4])
    const activityData = resultValue(results[5])
    const memoryData = resultValue(results[6])
    const optimizationData = resultValue(results[7])

    if (summaryData) setSummary(summaryData)
    if (brainData) setBrain(brainData)
    if (healthData) setHealth(healthData)
    if (agentsData) setAgents(agentsData)
    if (handoffData) setHandoffs(handoffData.handoffs || [])
    if (activityData) setActivity(activityData.events || [])
    if (memoryData) setMemories(memoryData.memories || [])
    if (optimizationData) setOptimizations(optimizationData.recommendations || [])

    setDataError(dataStatusMessage(summaryData, [
      resultFailure("Resumo", results[0]),
      resultFailure("Rede neural", results[1]),
      resultFailure("Health", results[2]),
      resultFailure("Agentes", results[3]),
      resultFailure("Handoffs", results[4]),
      resultFailure("Atividade", results[5]),
      resultFailure("Memórias", results[6]),
      resultFailure("Otimizações", results[7])
    ]))
    setLoading(false)
  }, [])

  const refreshTelemetry = useCallback(async current => {
    if (!current) return
    const results = await Promise.allSettled([
      api.summary(current),
      api.brain(current),
      api.health(current),
      api.agents(current),
      api.activity(current, 80)
    ])
    const summaryData = resultValue(results[0])
    const brainData = resultValue(results[1])
    const healthData = resultValue(results[2])
    const agentsData = resultValue(results[3])
    const activityData = resultValue(results[4])

    if (summaryData) setSummary(summaryData)
    if (brainData) setBrain(brainData)
    if (healthData) setHealth(healthData)
    if (agentsData) setAgents(agentsData)
    if (activityData) setActivity(activityData.events || [])

    setDataError(dataStatusMessage(summaryData, [
      resultFailure("Resumo", results[0]),
      resultFailure("Rede neural", results[1]),
      resultFailure("Health", results[2]),
      resultFailure("Agentes", results[3]),
      resultFailure("Atividade", results[4])
    ]))
  }, [])

  useEffect(() => {
    loadScopes().catch(err => {
      setDataError(err.message)
      setLoading(false)
    })
  }, [loadScopes])

  useEffect(() => {
    if (scope) loadScopeData(scope)
  }, [scopeKey, loadScopeData])

  useEffect(() => {
    if (scope) return
    const timer = window.setInterval(() => loadScopes().catch(() => {}), 3000)
    return () => window.clearInterval(timer)
  }, [scopeKey, loadScopes])

  useEffect(() => {
    if (!scope) return
    let stopped = false
    let timer = null
    const tick = async () => {
      await refreshTelemetry(scope)
      if (!stopped) timer = window.setTimeout(tick, 10000)
    }
    timer = window.setTimeout(tick, 10000)
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
    }
  }, [scopeKey, refreshTelemetry])

  const sync = async () => {
    if (!scope) return
    setSyncing(true)
    setActionError("")
    try {
      await api.sync(scope)
    } catch (err) {
      setActionError(err.message)
      setSyncing(false)
      await refreshTelemetry(scope)
      return
    }
    try {
      await loadScopes()
      await loadScopeData(scope)
    } finally {
      setSyncing(false)
    }
  }

  const selectNode = async node => {
    if ((node.type && node.type !== "memory") || !node.path || !scope) return
    setMemoryLoading(true)
    setMemory({ title: node.label || node.title })
    setActionError("")
    try {
      setMemory(await api.memory(scope, node.path))
    } catch (err) {
      setActionError(err.message)
      setMemory(null)
    } finally {
      setMemoryLoading(false)
    }
  }

  const healthScore = summary?.health?.score ?? 0
  const totalMemories = Number(summary?.memories?.total || 0)
  const indexedMemories = Number(summary?.memories?.indexed ?? summary?.memories?.total ?? 0)
  const provenance = Number(summary?.memories?.with_provenance || 0)
  const readModelComplete = summary?.observability?.read_model_complete !== false
  const provenanceBase = indexedMemories || totalMemories
  const lastSync = summary?.sync?.finished_at || summary?.sync?.started_at
  const visibleError = actionError || dataError

  const brainCounts = useMemo(() => {
    const counts = { agent: 0, session: 0, memory: 0, entity: 0, external: 0 }
    for (const node of brain.nodes || []) counts[node.type] = (counts[node.type] || 0) + 1
    return counts
  }, [brain])

  const memoryDetail = readModelComplete
    ? `${number(brainCounts.memory)} no grafo atual`
    : `${number(indexedMemories)}/${number(totalMemories)} indexadas no read model`
  const provenanceDetail = indexedMemories
    ? `${number(provenance)} de ${number(indexedMemories)} indexadas ligadas a sessões`
    : readModelComplete ? "nenhuma memória indexada" : "aguardando indexação das memórias"
  const sessionsDetail = `${number(summary?.sessions?.observations)} observações · ${number(summary?.chat?.captured_turns)} capturas web`
  const syncDetail = summary?.sync?.status === "failed" ? "failed · diagnóstico acima" : summary?.sync?.status || "sem sync"

  const openDeveloperWorkspace = () => {
    setIdeOpen(true)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark"><span /></div>
          <div><strong>AI MEMORY</strong><span>Cognitive Console</span></div>
        </div>
        <div className="scope-controls">
          <select value={scopeKey} onChange={event => {
            const next = scopes.find(item => `${item.workspace}/${item.project}` === event.target.value)
            if (next) setScope(next)
          }}>
            {!scopes.length ? <option>Nenhum projeto sincronizado</option> : null}
            {scopes.map(item => <option key={`${item.workspace}/${item.project}`} value={`${item.workspace}/${item.project}`}>{item.workspace} / {item.project}</option>)}
          </select>
          <button className="sync-button" onClick={sync} disabled={syncing || !scope}>{syncing ? "Sincronizando…" : "Sincronizar"}</button>
        </div>
      </header>

      <main className={`workspace-layout${ideOpen ? ` developer-mode ide-${ideLayout}` : ""}`}>
        <div className="console-column">
        <section className="hero-row">
          <div>
            <span className="eyebrow">Agent cognitive observability</span>
            <h1>AI Memory.<br /><em>Multi-Agent.</em></h1>
          </div>
          <div className="health-orb"><div className="orb-core"><strong>{healthScore}</strong><span>health</span></div><i className="orbit one" /><i className="orbit two" /><i className="orbit three" /></div>
        </section>

        {visibleError ? <div className="error-banner">{visibleError}</div> : null}
        <nav className="tabs">{tabs.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>

        {tab === "integrations" ? <IntegrationHub scope={scope} /> : !scope ? (
          <div className="empty-state"><strong>PostgreSQL ainda está vazio.</strong><span>Você já pode configurar agentes e MCPs em “Configurar Agentes”. As telas de memória serão habilitadas após a primeira sincronização.</span></div>
        ) : (
          <>
            <section className="metrics-grid">
              <MetricCard label="Memórias" value={number(totalMemories)} detail={memoryDetail} tone={readModelComplete ? "default" : "warning"} />
              <MetricCard label="Provenance" value={!readModelComplete && !indexedMemories ? "—" : percent(provenance, provenanceBase)} detail={provenanceDetail} tone={!readModelComplete || provenance < provenanceBase ? "warning" : "good"} />
              <MetricCard label="Sessões" value={number(summary?.sessions?.total)} detail={sessionsDetail} />
              <MetricCard label="Contradições" value={number(summary?.memories?.contradictions)} detail={`${number(summary?.memories?.orphans)} órfãs`} tone={Number(summary?.memories?.contradictions) ? "danger" : "good"} />
              <MetricCard label="Handoffs" value={number(summary?.handoffs?.total)} detail={`${number(summary?.handoffs?.open)} abertos`} />
              <MetricCard label="Último sync" value={lastSync ? new Date(lastSync).toLocaleTimeString("pt-BR") : "—"} detail={syncDetail} tone={summary?.sync?.status === "failed" ? "danger" : "default"} />
            </section>

            {loading ? <div className="loading-panel"><div className="pulse-ring" />Consolidando visão cognitiva…</div> : null}

            {!loading && tab === "brain" ? (
              <section className="content-section">
                <div className="section-heading brain-heading"><div className="brain-heading-copy"><span className="eyebrow">Shared neural memory</span><h2>Rede neural de memória compartilhada</h2><p>Os agentes orbitam o mesmo núcleo cognitivo. Sessões e memórias mostram como cada executor alimenta e reutiliza o conhecimento do projeto.</p></div><div className="graph-stats"><span>{brainCounts.agent} agentes</span><span>{brainCounts.session} sessões</span><span>{brainCounts.memory} memórias</span><span>{brainCounts.entity} entidades</span></div></div>
                <BrainGraph graph={brain} onSelect={selectNode} />
              </section>
            ) : null}

            {!loading && tab === "health" ? (
              <section className="content-section">
                <div className="section-heading"><div><span className="eyebrow">Memory health center</span><h2>O que precisa de atenção</h2></div><strong className="health-score">{health?.snapshot?.score ?? 0}/100</strong></div>
                <div className="health-grid">
                  <MetricCard label="Stale" value={number(health?.snapshot?.stale)} tone={Number(health?.snapshot?.stale) ? "warning" : "good"} />
                  <MetricCard label="Duplicadas" value={number(health?.snapshot?.duplicates)} tone={Number(health?.snapshot?.duplicates) ? "warning" : "good"} />
                  <MetricCard label="Contradições" value={number(health?.snapshot?.contradictions)} tone={Number(health?.snapshot?.contradictions) ? "danger" : "good"} />
                  <MetricCard label="Órfãs" value={number(health?.snapshot?.orphans)} tone={Number(health?.snapshot?.orphans) ? "warning" : "good"} />
                </div>
                <OptimizationPanel recommendations={optimizations} onSelect={selectNode} />
                <div className="issue-table">
                  <div className="issue-head"><span>Memória</span><span>Tipo</span><span>Estado</span><span>Atualização</span></div>
                  {(health?.flagged || []).map(item => <button className="issue-row" key={item.path} onClick={() => selectNode(item)}><span><strong>{item.title}</strong><small>{item.path}</small></span><span>{item.kind} · {item.tier}</span><span className="issue-tags">{item.contradiction ? <i>contradição</i> : null}{item.stale ? <i>stale</i> : null}{item.duplicate ? <i>duplicada</i> : null}{item.orphan ? <i>órfã</i> : null}</span><span>{item.source_updated_at ? new Date(item.source_updated_at).toLocaleDateString("pt-BR") : "—"}</span></button>)}
                  {!health?.flagged?.length ? <div className="table-empty">Nenhuma memória sinalizada.</div> : null}
                </div>
              </section>
            ) : null}

            {!loading && tab === "agents" ? (
              <section className="content-section">
                <div className="section-heading"><div><span className="eyebrow">Agent intelligence</span><h2>Quem está construindo a memória</h2></div></div>
                <div className="agent-grid">{(agents?.agents || []).map(agent => <article className="agent-card" key={agent.agent}><div className="agent-avatar">{agent.agent.slice(0, 2).toUpperCase()}</div><div><h3>{agent.agent}</h3><span>{agent.last_seen ? `última sessão ${new Date(agent.last_seen).toLocaleString("pt-BR")}` : "sem sessão recente"}</span></div><dl><div><dt>Memórias</dt><dd>{number(agent.memories)}</dd></div><div><dt>Sessões</dt><dd>{number(agent.sessions)}</dd></div><div><dt>Observações</dt><dd>{number(agent.observations)}</dd></div></dl></article>)}</div>
                <div className="dual-panels"><HandoffFlow handoffs={handoffs} /><ActivityFeed events={activity} /></div>
                <div className="client-panel"><h3>MCP clients</h3><div className="client-list">{(agents?.clients || []).map(client => <div key={client.client}><strong>{client.client}</strong><span>{number(client.reads)} reads</span><span>{number(client.writes)} writes</span></div>)}</div></div>
              </section>
            ) : null}

            {!loading && tab === "evolution" ? <EvolutionPanel scope={scope} memories={memories} onSelect={selectNode} /> : null}
            {!loading && tab === "search" ? <SearchExplain scope={scope} /> : null}
          </>
        )}
        </div>
        <div className="code-ide-column" aria-label="AI Memory Developer Workspace">
          <CodeWorkspace workspace={localWorkspace} layout={ideLayout} onLayoutChange={setIdeLayout} onClose={() => setIdeOpen(false)} />
        </div>
        <aside className="persistent-chat-column" aria-label="AI Memory Chat">
          <ChatWorkspace scope={scope} onConfigure={() => setTab("integrations")} workspace={localWorkspace} ideOpen={ideOpen} ideLayout={ideLayout} onIDELayoutChange={setIdeLayout} onOpenIDE={openDeveloperWorkspace} onCloseIDE={() => setIdeOpen(false)} />
        </aside>
      </main>
      <MemoryDrawer memory={memory} loading={memoryLoading} onClose={() => setMemory(null)} />
    </div>
  )
}
