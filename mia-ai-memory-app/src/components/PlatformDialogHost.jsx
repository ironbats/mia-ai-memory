import React, { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { bindDialogHost } from "../lib/dialogService.js"

export default function PlatformDialogHost() {
  const [queue, setQueue] = useState([])
  const [value, setValue] = useState("")
  const inputRef = useRef(null)
  const active = queue[0] || null

  const enqueue = useCallback(request => {
    setQueue(current => [...current, request])
  }, [])

  useEffect(() => bindDialogHost(enqueue), [enqueue])

  useEffect(() => {
    if (!active) return
    setValue(String(active.initialValue || ""))
    if (active.mode === "prompt") window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [active?.id])

  const settle = useCallback(result => {
    if (!active) return
    active.resolve(result)
    setQueue(current => current[0]?.id === active.id ? current.slice(1) : current.filter(item => item.id !== active.id))
  }, [active])

  useEffect(() => {
    if (!active) return undefined
    const handleKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault()
        settle(active.mode === "confirm" ? false : "")
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [active, settle])

  if (!active || typeof document === "undefined") return null

  const submit = event => {
    event.preventDefault()
    if (active.mode === "prompt") {
      const normalized = String(value || "").trim()
      if (!normalized && active.required !== false) return
      settle(normalized)
      return
    }
    settle(true)
  }

  const cancel = () => settle(active.mode === "confirm" ? false : "")
  const icon = active.tone === "danger" ? "!" : active.tone === "secure" ? "◆" : "◇"

  return createPortal(
    <div className="platform-dialog-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) cancel()
    }}>
      <form className={`platform-dialog tone-${active.tone}`} role="dialog" aria-modal="true" aria-labelledby={`${active.id}-title`} onSubmit={submit}>
        <div className="platform-dialog-icon" aria-hidden="true">{icon}</div>
        <div className="platform-dialog-content">
          <span className="eyebrow">AI Memory · ação protegida</span>
          <h2 id={`${active.id}-title`}>{active.title}</h2>
          {active.description ? <p>{active.description}</p> : null}
          {active.detail ? <div className="platform-dialog-detail">{active.detail}</div> : null}
          {active.mode === "prompt" ? (
            <label className="platform-dialog-field">
              <span>{active.inputLabel || "Valor"}</span>
              <input ref={inputRef} type={active.inputType || "text"} value={value} onChange={event => setValue(event.target.value)} placeholder={active.placeholder || ""} autoComplete={active.inputType === "password" ? "current-password" : "off"} spellCheck="false" />
            </label>
          ) : null}
        </div>
        <footer>
          <button type="button" className="platform-dialog-cancel" onClick={cancel}>{active.cancelLabel}</button>
          <button type="submit" className="platform-dialog-confirm" disabled={active.mode === "prompt" && active.required !== false && !String(value || "").trim()}>{active.confirmLabel}</button>
        </footer>
      </form>
    </div>,
    document.body
  )
}
