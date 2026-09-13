import React, { useEffect, useRef, useState } from "react"
import { searchWorkspace } from "../../lib/ideSearch.js"

export default function ProjectSearch({ workspace, onOpen }) {
  const [query, setQuery] = useState("")
  const [pathFilter, setPathFilter] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState({ results: [], skipped: [], scanned: 0, busy: false })
  const abortRef = useRef(null)
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  // Editing a buffer refreshes results without reading stale disk content over the draft.

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    setState({ results: [], skipped: [], scanned: 0, busy: Boolean(query), truncated: false })
    if (!query) return () => controller.abort()
    const timer = window.setTimeout(async () => {
      const current = workspaceRef.current
      try {
        const result = await searchWorkspace({
          query, caseSensitive, wholeWord, signal: controller.signal,
          paths: current.filePaths.filter(path => path.toLowerCase().includes(pathFilter.toLowerCase().trim())),
          drafts: new Map(current.tabs.map(tab => [tab.path, tab.content])), readPath: current.readPath,
          onProgress: scanned => { if (!controller.signal.aborted) setState(previous => ({ ...previous, scanned })) }
        })
        if (!controller.signal.aborted) setState({ ...result, busy: false })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, busy: false, error: error.message }))
      }
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query, pathFilter, caseSensitive, wholeWord, revision, workspace.workspaceSession, workspace.filePaths, workspace.tabs])

  return <section className="ide-project-search" aria-label="Buscar no conteúdo do projeto">
    <div className="ide-search-fields">
      <input autoFocus aria-label="Texto no projeto" placeholder="Buscar no conteúdo…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="ide-search-options">
        <button aria-pressed={caseSensitive} title="Diferenciar maiúsculas e minúsculas" onClick={() => setCaseSensitive(value => !value)}>Aa</button>
        <button aria-pressed={wholeWord} title="Palavra inteira" onClick={() => setWholeWord(value => !value)}>Palavra</button>
        {state.busy ? <button onClick={() => { abortRef.current?.abort(); setState(previous => ({ ...previous, busy: false, cancelled: true })) }}>Parar</button> : <button onClick={() => setRevision(value => value + 1)} disabled={!query}>Atualizar</button>}
      </div>
      <input aria-label="Filtrar caminhos da busca" placeholder="Caminho contém… (opcional)" value={pathFilter} onChange={event => setPathFilter(event.target.value)} />
    </div>
    <div className="ide-search-summary" role="status">{state.busy ? `Buscando · ${state.scanned} arquivos` : query ? `${state.results.length} resultado(s) · ${state.scanned} arquivos` : "Busque em arquivos locais e alterações não salvas."}</div>
    <div className="ide-project-results">
      {state.results.map((result, index) => <button key={`${result.path}:${index}`} title={`${result.path}:${result.line}:${result.column}`} onClick={() => onOpen(result)}>
        <strong>{result.path}</strong><small>Linha {result.line} · coluna {result.column}</small>
        <code>{result.excerpt.slice(0, result.highlightStart)}<mark>{result.excerpt.slice(result.highlightStart, result.highlightStart + result.highlightLength)}</mark>{result.excerpt.slice(result.highlightStart + result.highlightLength)}</code>
      </button>)}
      {query && !state.busy && !state.results.length && !state.cancelled ? <p>Nenhum resultado nos arquivos lidos.</p> : null}
      {state.truncated ? <p>Busca limitada a 300 ocorrências ou 32 MB de texto. Refine o texto ou o caminho para continuar.</p> : null}
      {state.cancelled ? <p>Busca interrompida. Clique em Atualizar para repetir.</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.skipped.length ? <details><summary>{state.skipped.length} arquivo(s) não lido(s)</summary>{state.skipped.map(item => <p key={item.path}>{item.path}: {item.reason}</p>)}</details> : null}
    </div>
  </section>
}
