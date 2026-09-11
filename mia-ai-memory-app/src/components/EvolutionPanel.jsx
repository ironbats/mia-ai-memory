import React, { useEffect, useState } from "react"
import { api } from "../lib/api.js"

const textLength = value => new Intl.NumberFormat("pt-BR").format((value || "").length)

export default function EvolutionPanel({ scope, memories = [], onSelect }) {
  const [path, setPath] = useState("")
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!memories.length) {
      setPath("")
      setVersions([])
      return
    }
    setPath(current => memories.some(item => item.path === current) ? current : memories[0].path)
  }, [memories])

  useEffect(() => {
    if (!scope || !path) return
    let cancelled = false
    setLoading(true)
    setError("")
    api.evolution(scope, path, 100).then(data => {
      if (!cancelled) setVersions(data.versions || [])
    }).catch(err => {
      if (!cancelled) setError(err.message)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [scope?.workspace, scope?.project, path])

  const selected = memories.find(item => item.path === path)
  return (
    <section className="content-section">
      <div className="section-heading">
        <div><span className="eyebrow">Memory time travel</span><h2>Evolução do conhecimento</h2></div>
        <select className="memory-select" value={path} onChange={event => setPath(event.target.value)}>
          {memories.map(item => <option key={item.path} value={item.path}>{item.title}</option>)}
        </select>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {loading ? <div className="loading-panel"><div className="pulse-ring" />Carregando versões…</div> : null}
      {!loading ? (
        <div className="timeline">
          {versions.map((version, index) => (
            <button className="timeline-entry" key={version.id} onClick={() => onSelect?.({ type: "memory", path: version.path, label: version.title })}>
              <span className="timeline-marker"><i /></span>
              <div>
                <div className="timeline-meta"><strong>v{versions.length - index}</strong><span>{new Date(version.source_updated_at).toLocaleString("pt-BR")}</span></div>
                <h3>{version.title}</h3>
                <p>{version.source_agent || "sem agente"} · {version.source_session_id ? `sessão ${version.source_session_id.slice(0, 8)}` : "sem sessão"} · {textLength(version.body_markdown)} caracteres</p>
              </div>
            </button>
          ))}
          {!versions.length ? <div className="empty-state compact"><strong>{selected?.title || "Memória"}</strong><span>A primeira versão será registrada quando esta memória for sincronizada com `updated_at` válido.</span></div> : null}
        </div>
      ) : null}
    </section>
  )
}
