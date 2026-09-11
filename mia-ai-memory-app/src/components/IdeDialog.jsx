import React, { useEffect, useRef } from "react"

export default function IdeDialog({ open, title, description, confirmLabel = "Confirmar", cancelLabel = "Cancelar", tone = "default", value = "", placeholder = "", onValueChange, onConfirm, onCancel, error = "" }) {
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handleKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault()
        onCancel?.()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  const submit = event => {
    event.preventDefault()
    onConfirm?.()
  }

  return (
    <div className="ide-dialog-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel?.()
    }}>
      <form className={`ide-dialog tone-${tone}`} role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
        <div className="ide-dialog-mark">{tone === "danger" ? "!" : "◇"}</div>
        <div className="ide-dialog-copy">
          <span className="eyebrow">AI Memory IDE</span>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
          {onValueChange ? <input ref={inputRef} value={value} onChange={event => onValueChange(event.target.value)} placeholder={placeholder} spellCheck="false" autoComplete="off" /> : null}
          {error ? <div className="ide-dialog-error">{error}</div> : null}
        </div>
        <footer>
          <button type="button" onClick={onCancel}>{cancelLabel}</button>
          <button type="submit" className="primary">{confirmLabel}</button>
        </footer>
      </form>
    </div>
  )
}
