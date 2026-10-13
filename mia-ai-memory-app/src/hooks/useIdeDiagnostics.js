import { useCallback, useEffect, useRef, useState } from "react"
import { analyzeDocument } from "../lib/ideLanguageService.js"
import { workspaceRuntime } from "../lib/workspaceRuntime.js"

const EMPTY = { symbols: [], diagnostics: [], symbolCount: 0, errorCount: 0, warningCount: 0, truncated: false, diagnosticStatus: "idle", diagnosticProvider: "", diagnosticMessage: "", path: "" }

const attachDiagnostics = (local, result, filePath) => {
  const remote = ["ok", "issues"].includes(result.status)
  const conflicts = local.diagnostics.filter(item => item.message.includes("Marcador de conflito de merge"))
  const diagnostics = remote ? [...result.diagnostics, ...conflicts] : local.diagnostics
  const unique = [...new Map(diagnostics.map(item => [`${item.line}:${item.column || 1}:${item.message}`, item])).values()].slice(0, 200)
  return {
    ...local,
    path: filePath,
    diagnostics: unique,
    errorCount: unique.filter(item => item.severity === "error").length,
    warningCount: unique.filter(item => item.severity === "warning").length,
    diagnosticStatus: result.status,
    diagnosticProvider: result.provider || "",
    diagnosticMessage: result.reason || ""
  }
}

export default function useIdeDiagnostics({ path, content, language, workspaceId, runtimeAvailable, workspaceSession }) {
  const [analysis, setAnalysis] = useState(EMPTY)
  const [manualRevision, setManualRevision] = useState(0)
  const previousRevision = useRef(0)
  const checkNow = useCallback(() => setManualRevision(current => current + 1), [])

  useEffect(() => {
    if (!path) {
      setAnalysis(EMPTY)
      return undefined
    }
    const controller = new AbortController()
    const immediate = manualRevision !== previousRevision.current
    previousRevision.current = manualRevision
    let cancelled = false
    let local = null
    const localTimer = window.setTimeout(() => {
      if (cancelled) return
      local = analyzeDocument({ content, language })
      setAnalysis({ ...local, path, diagnosticStatus: workspaceId && runtimeAvailable ? "checking" : "local", diagnosticProvider: local.provider, diagnosticMessage: "" })
    }, immediate ? 0 : 90)
    const runtimeTimer = workspaceId && runtimeAvailable ? window.setTimeout(async () => {
      if (cancelled) return
      if (!local) local = analyzeDocument({ content, language })
      setAnalysis(current => current.path === path ? { ...current, diagnosticStatus: "checking" } : current)
      try {
        const response = await workspaceRuntime.diagnose(workspaceId, path, content, { signal: controller.signal })
        if (cancelled) return
        setAnalysis(attachDiagnostics(local, response, path))
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        setAnalysis(attachDiagnostics(local, { status: "offline", provider: "", reason: error.status === 429 ? "Verificadores ocupados. Tente novamente." : error.status === 404 ? "Workspace Runtime desatualizado. Aplique o patch de backend e reinicie o serviço local." : `Analisador indisponível: ${error.message || String(error)}` }, path))
      }
    }, immediate ? 0 : 750) : null
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(localTimer)
      if (runtimeTimer !== null) window.clearTimeout(runtimeTimer)
    }
  }, [path, content, language, workspaceId, runtimeAvailable, workspaceSession, manualRevision])

  return { analysis: analysis.path === path ? analysis : EMPTY, checkNow }
}
