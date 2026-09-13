import React, { useEffect, useRef, useState } from "react"

export default function ResizeHandle({ label, value, min, max, onChange, onReset,
  orientation = "vertical", unit = "px", reverse = false, containerRef, controls, className = "", disabled = false }) {
  const [dragging, setDragging] = useState(false)
  const cleanupRef = useRef(null)
  const current = useRef(null)
  current.current = { onChange, min, max }
  useEffect(() => () => cleanupRef.current?.(), [])
  useEffect(() => { if (disabled) cleanupRef.current?.() }, [disabled])
  const clamp = next => Math.max(current.current.min, Math.min(current.current.max, next))
  const vertical = orientation === "vertical"

  const start = event => {
    if (disabled || event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    cleanupRef.current?.()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startPosition = vertical ? event.clientX : event.clientY
    const startValue = value
    const bounds = (containerRef?.current || handle.parentElement).getBoundingClientRect()
    const length = Math.max(1, (vertical ? bounds.width : bounds.height) - (vertical ? handle.offsetWidth : handle.offsetHeight))
    const oldCursor = document.body.style.cursor
    const oldSelection = document.body.style.userSelect
    document.body.style.cursor = vertical ? "col-resize" : "row-resize"
    document.body.style.userSelect = "none"
    setDragging(true)
    handle.focus({ preventScroll: true })
    handle.setPointerCapture?.(pointerId)
    const move = nextEvent => {
      if (nextEvent.pointerId !== pointerId) return
      const distance = ((vertical ? nextEvent.clientX : nextEvent.clientY) - startPosition) * (reverse ? -1 : 1)
      current.current.onChange(clamp(startValue + distance * (unit === "%" ? 100 / length : 1)))
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("keydown", key)
      window.removeEventListener("blur", cleanup)
      handle.removeEventListener("lostpointercapture", cleanup)
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
      document.body.style.cursor = oldCursor
      document.body.style.userSelect = oldSelection
      cleanupRef.current = null
      setDragging(false)
    }
    const finish = endEvent => { if (endEvent.pointerId === pointerId) { move(endEvent); cleanup() } }
    const cancel = endEvent => { if (endEvent.pointerId === pointerId) { current.current.onChange(clamp(startValue)); cleanup() } }
    const key = keyEvent => {
      if (keyEvent.key === "Escape") { keyEvent.preventDefault(); current.current.onChange(clamp(startValue)); cleanup() }
    }
    cleanupRef.current = cleanup
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("keydown", key)
    window.addEventListener("blur", cleanup)
    handle.addEventListener("lostpointercapture", cleanup)
  }

  const keyDown = event => {
    if (disabled || dragging) return
    const direction = vertical ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 }
    let next
    if (event.key in direction) next = value + direction[event.key] * (reverse ? -1 : 1) * (unit === "%" ? 2 : 10) * (event.shiftKey ? 5 : 1)
    else if (event.key === "Home") next = min
    else if (event.key === "End") next = max
    else if (event.key === "Enter") { event.preventDefault(); onReset?.(); return }
    else return
    event.preventDefault()
    onChange(clamp(next))
  }

  return <div className={`workspace-resize-handle ${orientation} ${className}${dragging ? " is-dragging" : ""}`}
    role="separator" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
    aria-label={label} aria-controls={controls} aria-orientation={orientation}
    aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)}
    aria-valuetext={`${Math.round(value)}${unit}`} data-value={`${Math.round(value)}${unit}`}
    title={`${label} · arraste ou use as setas · duplo clique/Enter restaura · Esc cancela`}
    onPointerDown={start} onKeyDown={keyDown} onDoubleClick={() => { if (!disabled) onReset?.() }}><span /></div>
}
