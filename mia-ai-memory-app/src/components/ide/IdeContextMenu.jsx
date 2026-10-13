import React, { useEffect, useRef } from "react"
import { createPortal } from "react-dom"

export default function IdeContextMenu({ menu, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menu) return undefined
    const surface = menuRef.current
    const focusable = [...(surface?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])]
    focusable[0]?.focus({ preventScroll: true })
    const onPointer = event => { if (!surface?.contains(event.target)) onClose() }
    const onDismiss = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose() } }
    const onScroll = event => { if (!surface?.contains(event.target)) onClose() }
    document.addEventListener("pointerdown", onPointer, true)
    document.addEventListener("keydown", onDismiss, true)
    window.addEventListener("resize", onClose)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("keydown", onDismiss, true)
      window.removeEventListener("resize", onClose)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [menu, onClose])

  if (!menu) return null
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth
  const viewportHeight = typeof window === "undefined" ? 720 : window.innerHeight
  const left = Math.max(8, Math.min(menu.x, viewportWidth - 262))
  const height = Math.min(viewportHeight * 0.75, menu.items.length * 33 + 24)
  const top = Math.max(8, Math.min(menu.y, viewportHeight - height - 8))
  const onKeyDown = event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const entries = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])]
    const index = entries.indexOf(document.activeElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : event.key === "ArrowDown" ? (index + 1) % entries.length : (index - 1 + entries.length) % entries.length
    entries[next]?.focus()
  }

  return createPortal(
    <div ref={menuRef} className="ide-context-menu" style={{ left, top }} role="menu" aria-label={menu.label || "Ações da IDE"} onKeyDown={onKeyDown}>
      {menu.items.map((item, index) => item.separator ? <div className="ide-context-separator" role="separator" key={`separator-${index}`} /> : (
        <button key={item.id || `${index}`} type="button" role="menuitem" disabled={item.disabled} title={item.title || item.label} onClick={() => { onClose(); item.run?.() }}>
          <span className="ide-context-label">{item.label}</span>{item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
        </button>
      ))}
    </div>, document.body
  )
}
