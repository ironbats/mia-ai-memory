import React from "react"

export default function MetricCard({ label, value, detail, tone = "default" }) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value ?? "—"}</strong>
      {detail ? <span className="metric-detail">{detail}</span> : null}
    </article>
  )
}
