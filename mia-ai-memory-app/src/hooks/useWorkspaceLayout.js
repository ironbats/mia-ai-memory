import { useRef } from "react"
import useStoredPreference from "./useStoredPreference.js"
import useElementSize from "./useElementSize.js"

const PRESETS = { compact: 38, split: 50, wide: 64 }

export default function useWorkspaceLayout() {
  const containerRef = useRef(null)
  const [preferred, setPreferred] = useStoredPreference("ai-memory.workspace.ideShare", 50)
  const { width } = useElementSize(containerRef)
  const available = Math.max(1, width - 12)
  const min = Math.min(45, Math.max(25, 380 / available * 100))
  const max = Math.max(55, Math.min(75, 100 - 360 / available * 100))
  const value = Math.max(min, Math.min(max, preferred))
  const layout = Math.abs(value - 50) < 1 ? "split" : value < 50 ? "compact" : "wide"
  return { containerRef, value, min, max, layout, setValue: setPreferred,
    selectLayout: name => setPreferred(PRESETS[name] ?? 50), reset: () => setPreferred(50) }
}
