import React, { useState } from "react"
import { api } from "../lib/api.js"

const streamRows = explain => {
  const rrf = explain?.rrf || {}
  const values = [
    ["FTS", Number(rrf.fts || 0)],
    ["Vector", Number(rrf.vector || 0)],
    ["Graph", Number(rrf.graph || 0)],
    ["Entity", Number(rrf.entity || 0)]
  ]
  const total = values.reduce((sum, item) => sum + item[1], 0)
  return values.map(([label, value]) => ({ label, value, percent: total ? value / total * 100 : 0 }))
}

export default function SearchExplain({ scope }) {
  const [query, setQuery] = useState("")
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const submit = async event => {
    event.preventDefault()
    if (!query.trim()) return
    setLoading(true)
    setError("")
    try {
      setResult(await api.search(scope, query.trim(), 12))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="search-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Retrieval explainability</span>
          <h2>Por que essa memória apareceu?</h2>
        </div>
        {result ? <span className={`vector-state ${result.vectorEnabled ? "enabled" : ""}`}>{result.vectorEnabled ? "Vector ativo" : result.vectorConfigured ? "Vector degradado" : "Vector não configurado"}</span> : null}
      </div>
      <form className="search-form" onSubmit={submit}>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Ex.: autenticação SSO, PostgreSQL, handoff entre agentes…" />
        <button className="primary-button" disabled={loading}>{loading ? "Analisando…" : "Explicar retrieval"}</button>
      </form>
      {error ? <div className="error-banner">{error}</div> : null}
      {result?.vectorError ? <div className="warning-banner">Vector degradou para FTS + entidades + grafo: {result.vectorError}</div> : null}
      <div className="search-results">
        {(result?.hits || []).map((hit, index) => (
          <article className="search-hit" key={`${hit.path}:${index}`}>
            <div className="search-hit-head">
              <div>
                <span className="rank-badge">#{index + 1}</span>
                <strong>{hit.title}</strong>
                <span className="hit-kind">{hit.kind}</span>
              </div>
              <code>{hit.path}</code>
            </div>
            <div className="stream-grid">
              {streamRows(hit.explain).map(stream => (
                <div className="stream-row" key={stream.label}>
                  <span>{stream.label}</span>
                  <div className="bar-track"><i style={{ width: `${Math.max(1, stream.percent)}%` }} /></div>
                  <strong>{stream.percent.toFixed(0)}%</strong>
                </div>
              ))}
            </div>
            {hit.explain?.matched_entities?.length ? <div className="entity-pills">{hit.explain.matched_entities.map(entity => <span key={entity}>{entity}</span>)}</div> : null}
            {hit.explain?.graph_via ? <div className="graph-via">Entrou pelo grafo via <strong>{hit.explain.graph_via.seed_path}</strong> · {hit.explain.graph_via.direction}</div> : null}
          </article>
        ))}
      </div>
    </section>
  )
}
