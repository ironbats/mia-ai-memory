import { useEffect } from "react"

export default function useDialogFocus(ref, open) {
  useEffect(() => {
    if (!open || !ref.current) return
    const dialog = ref.current
    const previous = document.activeElement
    const focusable = () => [...dialog.querySelectorAll('input, button, select, textarea, a[href], [tabindex="0"]')]
      .filter(element => !element.disabled && element.getClientRects().length)
    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus())
    const trap = event => {
      if (event.key !== "Tab") return
      const items = focusable()
      if (!items.length) { event.preventDefault(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener("keydown", trap)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener("keydown", trap)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [ref, open])
}
