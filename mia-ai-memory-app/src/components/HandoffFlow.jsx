import React from "react"

const date = value => value ? new Date(value).toLocaleString("pt-BR") : "—"

export default function HandoffFlow({ handoffs = [] }) {
  return (
    <section className="subpanel">
      <div className="subpanel-heading">
        <div><span className="eyebrow">Handoff flow</span><h3>Transferência de contexto entre agentes</h3></div>
        <span className="panel-count">{handoffs.length}</span>
      </div>
      <div className="handoff-list">
        {handoffs.map(item => (
          <article className="handoff-card" key={item.handoff_id}>
            <div className="handoff-route">
              <strong>{item.agent || "unknown"}</strong>
              <i>→</i>
              <strong>{item.accepted_by || (item.state === "open" ? "aguardando" : item.state)}</strong>
            </div>
            <p>{item.summary || "Sem resumo registrado."}</p>
            <footer><span>{item.state}</span><span>{date(item.created_at)}</span><span>{(item.files_touched || []).length} arquivos</span></footer>
          </article>
        ))}
        {!handoffs.length ? <div className="table-empty">Nenhum handoff registrado neste projeto.</div> : null}
      </div>
    </section>
  )
}
