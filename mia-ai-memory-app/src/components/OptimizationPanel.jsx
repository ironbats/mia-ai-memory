import React from "react"

const labels = {
  "resolve-contradiction": "Resolver contradição",
  "refresh-stale-memory": "Atualizar memória stale",
  "merge-duplicate-memory": "Consolidar duplicata",
  "link-or-remove-orphan": "Relacionar ou remover órfã",
  "add-provenance": "Adicionar provenance",
  review: "Revisar memória"
}

export default function OptimizationPanel({ recommendations = [], onSelect }) {
  const counts = recommendations.reduce((acc, item) => {
    acc[item.priority] = (acc[item.priority] || 0) + 1
    return acc
  }, {})
  return (
    <section className="subpanel optimization-panel">
      <div className="subpanel-heading">
        <div><span className="eyebrow">Memory optimization</span><h3>Recomendações acionáveis</h3></div>
        <div className="priority-summary"><span>{counts.critical || 0} críticas</span><span>{counts.high || 0} altas</span><span>{counts.medium || 0} médias</span></div>
      </div>
      <div className="optimization-list">
        {recommendations.map(item => (
          <button key={item.path} onClick={() => onSelect?.(item)} className="optimization-row">
            <span className={`priority-dot ${item.priority}`} />
            <span><strong>{labels[item.action] || item.action}</strong><small>{item.title} · {item.path}</small></span>
            <i>{item.priority}</i>
          </button>
        ))}
        {!recommendations.length ? <div className="table-empty">Nenhuma ação de otimização pendente.</div> : null}
      </div>
    </section>
  )
}
