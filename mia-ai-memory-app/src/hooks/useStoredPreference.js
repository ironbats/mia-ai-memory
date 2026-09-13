import { useEffect, useRef, useState } from "react"

// Preferences never prevent the workspace from opening in private/restricted browsers.
export default function useStoredPreference(key, fallback) {
  const [value, setValue] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(key))
      if (typeof stored === typeof fallback && stored !== null &&
          (typeof stored !== "number" || Number.isFinite(stored))) return stored
    } catch {}
    return fallback
  })
  const latest = useRef(value)
  latest.current = value
  useEffect(() => {
    const persist = () => { try { window.localStorage.setItem(key, JSON.stringify(latest.current)) } catch {} }
    window.addEventListener("pagehide", persist)
    return () => window.removeEventListener("pagehide", persist)
  }, [key])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(key, JSON.stringify(value)) } catch {}
    }, 150)
    return () => window.clearTimeout(timer)
  }, [key, value])
  return [value, setValue]
}
