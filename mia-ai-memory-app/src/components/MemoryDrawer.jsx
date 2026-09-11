import React from "react"

const Flag = ({ active, children }) => active ? <span className="status-flag">{children}</span> : null

export default function MemoryDrawer({ memory, loading, onClose }) {
  if (!memory && !loading) return null
  return (
    <aside className="memory-drawer">
      <div className="drawer-head">
        <div>
          <span className="eyebrow">Memory provenance</span>
          <h2>{memory?.title || "Carregando…"}</h2>
        </div>
        <button className="icon-button" onClick={onClose}>×</button>
      </div>
      {loading ? <div className="drawer-loading">Carregando memória…</div> : (
        <div className="drawer-body">
          <div className="status-row">
            <Flag active={memory.stale}>stale</Flag>
            <Flag active={memory.duplicate}>duplicada</Flag>
            <Flag active={memory.orphan}>órfã</Flag>
            <Flag active={memory.contradiction}>contradição</Flag>
            {!memory.stale && !memory.duplicate && !memory.orphan && !memory.contradiction ? <span className="status-flag healthy">saudável</span> : null}
          </div>
          <dl className="metadata-grid">
            <div><dt>Path</dt><dd>{memory.path}</dd></div>
            <div><dt>Tipo</dt><dd>{memory.kind}</dd></div>
            <div><dt>Tier</dt><dd>{memory.tier}</dd></div>
            <div><dt>Agente</dt><dd>{memory.source_agent || "sem provenance"}</dd></div>
            <div><dt>Sessão</dt><dd>{memory.source_session_id || "—"}</dd></div>
            <div><dt>Atualizada</dt><dd>{memory.source_updated_at ? new Date(memory.source_updated_at).toLocaleString() : "—"}</dd></div>
          </dl>
          <section className="drawer-section">
            <h3>Provenance</h3>
            <pre>{JSON.stringify(memory.provenance || {}, null, 2)}</pre>
          </section>
          <section className="drawer-section">
            <h3>Relações</h3>
            <div className="relation-list">
              {(memory.relations || []).map(relation => (
                <div className="relation-row" key={`${relation.relation_type}:${relation.to_workspace}:${relation.to_project}:${relation.to_path}`}>
                  <span>{relation.relation_type}</span>
                  <strong>{relation.to_path}</strong>
                </div>
              ))}
              {!memory.relations?.length ? <span className="muted">Sem relações indexadas.</span> : null}
            </div>
          </section>
          <section className="drawer-section">
            <h3>Conteúdo</h3>
            <pre className="memory-content">{memory.body_markdown}</pre>
          </section>
        </div>
      )}
    </aside>
  )
}
