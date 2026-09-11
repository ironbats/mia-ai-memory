import React, { useMemo, useState } from "react"

const dimensions = { width: 1280, height: 760 }
const center = { x: 640, y: 380 }
const typeWeight = { agent: 0, session: 1, memory: 2, entity: 3, external: 4 }
const visibleTypeList = ["agent", "session", "memory", "entity", "external"]

const hashNumber = value => {
  let hash = 2166136261
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0)
}

const initials = value => String(value || "AI").split(/[\s_-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "AI"
const compact = (value, max = 30) => String(value || "").length > max ? `${String(value).slice(0, max)}…` : String(value || "")

const curvePath = (source, target, seed = 0, bend = 18) => {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const nx = -dy / length
  const ny = dx / length
  const direction = seed % 2 ? 1 : -1
  const amount = direction * Math.min(bend + seed % 23, length * .12)
  const c1 = { x: source.x + dx * .34 + nx * amount, y: source.y + dy * .34 + ny * amount }
  const c2 = { x: source.x + dx * .68 + nx * amount, y: source.y + dy * .68 + ny * amount }
  return `M ${source.x} ${source.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${target.x} ${target.y}`
}

const buildTopology = (nodes, edges) => {
  const positions = new Map()
  const agentNodes = nodes.filter(node => node.type === "agent").sort((a, b) => String(a.label).localeCompare(String(b.label)))
  const sessionNodes = nodes.filter(node => node.type === "session")
  const memoryNodes = nodes.filter(node => node.type === "memory")
  const entityNodes = nodes.filter(node => node.type === "entity")
  const externalNodes = nodes.filter(node => node.type === "external")
  const sessionOwner = new Map()
  const memoryOwner = new Map()
  const entityMemory = new Map()

  for (const edge of edges) {
    if (edge.type === "produced-session" && edge.source.startsWith("agent:") && edge.target.startsWith("session:")) sessionOwner.set(edge.target, edge.source)
  }
  for (const edge of edges) {
    if (edge.type === "produced-memory") {
      if (edge.source.startsWith("agent:")) memoryOwner.set(edge.target, edge.source)
      if (edge.source.startsWith("session:") && sessionOwner.has(edge.source)) memoryOwner.set(edge.target, sessionOwner.get(edge.source))
    }
    if (edge.type === "entity" && edge.source.startsWith("memory:") && edge.target.startsWith("entity:")) entityMemory.set(edge.target, edge.source)
  }

  const agentAngle = new Map()
  const count = Math.max(1, agentNodes.length)
  agentNodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count
    agentAngle.set(node.id, angle)
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * 472,
      y: center.y + Math.sin(angle) * 276
    })
  })

  const sessionsByAgent = new Map()
  for (const node of sessionNodes) {
    const owner = sessionOwner.get(node.id)
    const key = owner || "unassigned"
    const list = sessionsByAgent.get(key) || []
    list.push(node)
    sessionsByAgent.set(key, list)
  }
  for (const [owner, list] of sessionsByAgent.entries()) {
    list.forEach((node, index) => {
      const baseAngle = agentAngle.get(owner) ?? (hashNumber(node.id) % 628) / 100
      const spread = (index - (list.length - 1) / 2) * .065
      const angle = baseAngle + spread
      const radiusX = 326 + (index % 2) * 16
      const radiusY = 194 + (index % 3) * 8
      positions.set(node.id, {
        x: center.x + Math.cos(angle) * radiusX,
        y: center.y + Math.sin(angle) * radiusY
      })
    })
  }

  const memoriesByAgent = new Map()
  for (const node of memoryNodes) {
    const owner = memoryOwner.get(node.id) || "unassigned"
    const list = memoriesByAgent.get(owner) || []
    list.push(node)
    memoriesByAgent.set(owner, list)
  }
  for (const [owner, list] of memoriesByAgent.entries()) {
    list.forEach((node, index) => {
      const fallback = (hashNumber(node.id) % 628) / 100
      const baseAngle = agentAngle.get(owner) ?? fallback
      const ring = index % 4
      const layer = Math.floor(index / 4)
      const spread = ((ring - 1.5) * .17) + ((layer % 3) - 1) * .035
      const angle = baseAngle + spread
      const radiusX = 132 + ring * 27 + Math.min(layer, 4) * 8
      const radiusY = 82 + ring * 18 + Math.min(layer, 4) * 5
      positions.set(node.id, {
        x: center.x + Math.cos(angle) * radiusX,
        y: center.y + Math.sin(angle) * radiusY
      })
    })
  }

  entityNodes.forEach((node, index) => {
    const memoryId = entityMemory.get(node.id)
    const memoryPoint = memoryId ? positions.get(memoryId) : null
    const baseAngle = memoryPoint ? Math.atan2(memoryPoint.y - center.y, memoryPoint.x - center.x) : index * 2.399963
    const jitter = ((hashNumber(node.id) % 21) - 10) * .01
    const angle = baseAngle + jitter
    const radiusX = 238 + index % 5 * 12
    const radiusY = 142 + index % 4 * 9
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * radiusX,
      y: center.y + Math.sin(angle) * radiusY
    })
  })

  externalNodes.forEach((node, index) => {
    const angle = -Math.PI / 3 + index * 2.399963
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * 545,
      y: center.y + Math.sin(angle) * 320
    })
  })

  return { positions, agentNodes, memoryNodes, sessionNodes }
}

const radiusFor = node => {
  if (node.type === "agent") return 32
  if (node.type === "session") return 8
  if (node.type === "memory") return node.pinned ? 12 : 8
  if (node.type === "entity") return 6
  return 5
}

const selectedDescription = node => {
  if (!node) return null
  if (node.type === "agent") return {
    eyebrow: "Agente conectado",
    title: node.label,
    meta: [node.provider, node.model].filter(Boolean).join(" · ") || "Executor observado",
    status: node.enabled === false ? "desativado" : node.configured ? "configurado" : "observado"
  }
  if (node.type === "memory") return {
    eyebrow: "Memória compartilhada",
    title: node.label,
    meta: [node.kind, node.tier].filter(Boolean).join(" · ") || node.path,
    status: node.health || "healthy"
  }
  if (node.type === "session") return {
    eyebrow: "Sinapse de sessão",
    title: node.label,
    meta: `${Number(node.observations || 0)} observações`,
    status: "sessão"
  }
  if (node.type === "entity") return {
    eyebrow: "Entidade relacionada",
    title: node.label,
    meta: `${Number(node.frequency || 1)} ocorrências`,
    status: "entidade"
  }
  return {
    eyebrow: "Memória externa",
    title: node.label,
    meta: [node.workspace, node.project].filter(Boolean).join(" / "),
    status: "cross-project"
  }
}

export default function BrainGraph({ graph, onSelect }) {
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState(null)
  const [visibleTypes, setVisibleTypes] = useState(new Set(visibleTypeList))
  const nodes = useMemo(() => [...(graph?.nodes || [])].sort((a, b) => (typeWeight[a.type] ?? 9) - (typeWeight[b.type] ?? 9)), [graph])
  const edges = graph?.edges || []
  const topology = useMemo(() => buildTopology(nodes, edges), [nodes, edges])
  const visibleNodeIds = useMemo(() => new Set(nodes.filter(node => visibleTypes.has(node.type)).map(node => node.id)), [nodes, visibleTypes])
  const selectedNode = nodes.find(node => node.id === selected) || null
  const inspector = selectedDescription(selectedNode)
  const agentCount = topology.agentNodes.length
  const memoryCount = topology.memoryNodes.length
  const sessionCount = topology.sessionNodes.length

  const toggleType = type => {
    setVisibleTypes(current => {
      const next = new Set(current)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const selectNode = node => {
    setSelected(node.id)
    onSelect?.(node)
  }

  return (
    <section className="brain-panel">
      <div className="brain-toolbar">
        <div className="brain-filter-row">
          {visibleTypeList.map(type => (
            <button key={type} className={`filter-chip type-${type} ${visibleTypes.has(type) ? "active" : ""}`} onClick={() => toggleType(type)}>
              {type}
            </button>
          ))}
        </div>
        <div className="brain-toolbar-actions">
          <span className="brain-live"><i />topologia compartilhada</span>
          <label className="zoom-control">
            <span>Zoom</span>
            <input type="range" min="0.72" max="1.38" step="0.03" value={zoom} onChange={event => setZoom(Number(event.target.value))} />
          </label>
          <button className="brain-reset" onClick={() => setZoom(1)}>1:1</button>
        </div>
      </div>

      <div className="brain-viewport">
        <div className="brain-context-card">
          <span>Shared memory fabric</span>
          <strong>{agentCount} agentes conectados</strong>
          <small>{memoryCount} memórias · {sessionCount} sessões</small>
        </div>

        <svg viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} role="img" aria-label="Rede neural de memória compartilhada entre agentes">
          <defs>
            <radialGradient id="brainCoreGlow">
              <stop offset="0%" stopColor="rgba(126, 112, 255, .42)" />
              <stop offset="45%" stopColor="rgba(92, 76, 232, .16)" />
              <stop offset="100%" stopColor="rgba(4, 6, 13, 0)" />
            </radialGradient>
            <radialGradient id="memoryCoreFill">
              <stop offset="0%" stopColor="#8f82ff" />
              <stop offset="58%" stopColor="#4f46b7" />
              <stop offset="100%" stopColor="#171a35" />
            </radialGradient>
            <filter id="nodeGlow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="coreGlow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="14" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          <g transform={`translate(${dimensions.width * (1 - zoom) / 2} ${dimensions.height * (1 - zoom) / 2}) scale(${zoom})`}>
            <ellipse className="brain-field field-one" cx={center.x} cy={center.y} rx="386" ry="230" />
            <ellipse className="brain-field field-two" cx={center.x} cy={center.y} rx="265" ry="160" />
            <ellipse cx={center.x} cy={center.y} rx="220" ry="160" fill="url(#brainCoreGlow)" />

            {topology.agentNodes.filter(node => visibleNodeIds.has(node.id)).map((agent, index) => {
              const point = topology.positions.get(agent.id)
              const active = selected === agent.id
              return (
                <g key={`fabric:${agent.id}`}>
                  <path className={`brain-fabric-link ${active ? "active" : ""}`} d={curvePath(point, center, index * 13, 34)} pathLength="100" />
                  <path className="brain-fabric-pulse" d={curvePath(point, center, index * 13, 34)} pathLength="100" style={{ animationDelay: `${index * .42}s` }} />
                </g>
              )
            })}

            {edges.filter(edge => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)).map(edge => {
              const source = topology.positions.get(edge.source)
              const target = topology.positions.get(edge.target)
              if (!source || !target) return null
              const active = selected && (edge.source === selected || edge.target === selected)
              return <path key={edge.id} className={`brain-edge relation-${edge.type} ${active ? "active" : ""}`} d={curvePath(source, target, hashNumber(edge.id), 11)} />
            })}

            <g className="shared-memory-core" transform={`translate(${center.x} ${center.y})`}>
              <circle className="shared-memory-ambient" r="104" />
              <circle className="shared-memory-orbit orbit-a" r="82" />
              <circle className="shared-memory-orbit orbit-b" r="68" />
              <circle className="shared-memory-body" r="54" fill="url(#memoryCoreFill)" filter="url(#coreGlow)" />
              <path className="shared-memory-glyph" d="M-18 -13 C-29 -10 -31 5 -21 11 C-18 24 -3 28 5 20 C15 25 29 17 27 5 C35 -5 27 -18 16 -18 C9 -28 -7 -27 -12 -18 C-14 -17 -16 -15 -18 -13 Z M0 -20 L0 21 M-14 -9 C-3 -4 -7 6 0 9 M14 -10 C5 -5 8 5 0 9" />
              <text className="shared-memory-title" y="76" textAnchor="middle">MEMÓRIA COMPARTILHADA</text>
              <text className="shared-memory-meta" y="91" textAnchor="middle">{memoryCount ? `${memoryCount} fragmentos ativos` : "núcleo pronto para aprender"}</text>
            </g>

            {nodes.filter(node => visibleTypes.has(node.type)).map(node => {
              const point = topology.positions.get(node.id)
              if (!point) return null
              const active = selected === node.id
              const radius = radiusFor(node)

              if (node.type === "agent") {
                return (
                  <g key={node.id} className={`brain-node type-agent ${active ? "active" : ""}`} transform={`translate(${point.x} ${point.y})`} onClick={() => selectNode(node)}>
                    <circle r="46" className="agent-node-aura" />
                    <circle r="35" className="agent-node-ring" />
                    <circle r="28" className="node-core" filter={active ? "url(#nodeGlow)" : undefined} />
                    <text className="agent-node-initials" y="4" textAnchor="middle">{initials(node.label)}</text>
                    <text className="agent-node-label" y="53" textAnchor="middle">{compact(node.label, 22)}</text>
                    <text className="agent-node-meta" y="67" textAnchor="middle">{compact(node.model || node.provider || (node.configured ? "configurado" : "observado"), 24)}</text>
                    <circle className={`agent-node-status ${node.enabled === false ? "offline" : "online"}`} cx="23" cy="-21" r="4" />
                  </g>
                )
              }

              return (
                <g key={node.id} className={`brain-node type-${node.type} health-${node.health || "healthy"} ${active ? "active" : ""}`} transform={`translate(${point.x} ${point.y})`} onClick={() => selectNode(node)}>
                  <circle r={radius + (active ? 8 : 5)} className="node-halo" filter={active ? "url(#nodeGlow)" : undefined} />
                  <circle r={radius} className="node-core" />
                  {node.type === "memory" && node.pinned ? <circle r={radius + 4} className="pinned-ring" /> : null}
                  {active ? <text className="brain-node-label" y={radius + 21} textAnchor="middle">{compact(node.label, 34)}</text> : null}
                </g>
              )
            })}
          </g>
        </svg>

        {!memoryCount ? <div className="brain-empty-signal"><i /><span><strong>A rede está conectada.</strong> As memórias aparecerão ao redor do núcleo conforme os agentes trabalham e o projeto é sincronizado.</span></div> : null}

        <div className={`brain-inspector ${inspector ? "visible" : ""}`}>
          {inspector ? <><span>{inspector.eyebrow}</span><strong>{inspector.title}</strong><small>{inspector.meta}</small><i>{inspector.status}</i></> : <><span>Interação neural</span><strong>Selecione um nó</strong><small>Explore agentes, sessões, memórias e entidades sem perder a visão compartilhada.</small></>}
        </div>
      </div>

      <div className="brain-legend">
        <span className="legend-group"><b>Topologia</b><i className="legend-line fabric" /> agente ↔ memória compartilhada</span>
        <span><i className="legend-dot health-healthy" /> saudável</span>
        <span><i className="legend-dot health-stale" /> stale</span>
        <span><i className="legend-dot health-duplicate" /> duplicada</span>
        <span><i className="legend-dot health-orphan" /> órfã</span>
        <span><i className="legend-dot health-contradiction" /> contradição</span>
      </div>
    </section>
  )
}
