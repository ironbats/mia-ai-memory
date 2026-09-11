import React from "react"

export default function Modal({ title, subtitle, children, onClose, wide = false }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className={`modal-card${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div><span className="eyebrow">Configuration</span><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  )
}
