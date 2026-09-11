import React from "react"

const labels = { memory: "Memória", session: "Sessão", handoff: "Handoff" }

export default function ActivityFeed({ events = [] }) {
  return (
    <section className="subpanel">
      <div className="subpanel-heading">
        <div><span className="eyebrow">Live cognitive activity</span><h3>Atividade cognitiva recente</h3></div>
        <span className="live-badge"><i /> live</span>
      </div>
      <div className="activity-list">
        {events.map((event, index) => (
          <div className="activity-row" key={`${event.event_type}-${event.reference_id || event.label}-${index}`}>
            <span className={`activity-icon ${event.event_type}`}>{event.event_type?.slice(0, 1)?.toUpperCase()}</span>
            <div><strong>{event.label}</strong><small>{labels[event.event_type] || event.event_type} · {event.actor || "sem agente"}</small></div>
            <span>{event.event_at ? new Date(event.event_at).toLocaleString("pt-BR") : "—"}</span>
          </div>
        ))}
        {!events.length ? <div className="table-empty">Ainda não há atividade sincronizada.</div> : null}
      </div>
    </section>
  )
}
