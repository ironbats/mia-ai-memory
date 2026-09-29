import React, { useEffect, useMemo, useRef, useState } from "react"
import { searchWorkspace } from "../../lib/ideSearch.js"

const emptyState = { results: [], skipped: [], scanned: 0, busy: false, truncated: false, cancelled: false, error: "" }

const fileName = path => String(path || "").split("/").pop() || String(path || "")

const parentPath = path => {
  const value = String(path || "")
  const index = value.lastIndexOf("/")
  return index > 0 ? value.slice(0, index) : ""
}

const groupResults = results => {
  const groups = []
  const index = new Map()
  for (const result of results) {
    let group = index.get(result.path)
    if (!group) {
      group = { path: result.path, name: fileName(result.path), directory: parentPath(result.path), matches: [] }
      index.set(result.path, group)
      groups.push(group)
    }
    group.matches.push(result)
  }
  return groups
}

export default function ProjectSearch({ workspace, onOpen }) {
  const [query, setQuery] = useState("")
  const [pathFilter, setPathFilter] = useState("")
  const [showPathFilter, setShowPathFilter] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState(emptyState)
  const abortRef = useRef(null)
  const queryRef = useRef(null)
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const effectiveQuery = query.trim()
  const normalizedPathFilter = pathFilter.trim().toLowerCase()
  const groupedResults = useMemo(() => groupResults(state.results), [state.results])

  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    setState({ ...emptyState, busy: Boolean(effectiveQuery) })
    if (!effectiveQuery) return () => controller.abort()

    const timer = window.setTimeout(async () => {
      const current = workspaceRef.current
      try {
        const paths = normalizedPathFilter
          ? current.filePaths.filter(path => path.toLowerCase().includes(normalizedPathFilter))
          : current.filePaths
        const result = await searchWorkspace({
          query: effectiveQuery,
          caseSensitive,
          wholeWord,
          signal: controller.signal,
          paths,
          drafts: new Map(current.tabs.map(tab => [tab.path, tab.content])),
          readPath: current.readPath,
          onProgress: scanned => {
            if (!controller.signal.aborted) setState(previous => ({ ...previous, scanned }))
          }
        })
        if (!controller.signal.aborted) setState({ ...emptyState, ...result })
      } catch (error) {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, busy: false, error: error.message || String(error) }))
      }
    }, 240)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [effectiveQuery, normalizedPathFilter, caseSensitive, wholeWord, revision, workspace.workspaceSession, workspace.filePaths, workspace.tabs])

  const clearSearch = () => {
    abortRef.current?.abort()
    setQuery("")
    setState(emptyState)
    window.requestAnimationFrame(() => queryRef.current?.focus())
  }

  const togglePathFilter = () => {
    setShowPathFilter(value => {
      const next = !value
      if (!next && !pathFilter) window.requestAnimationFrame(() => queryRef.current?.focus())
      return next
    })
  }

  const summary = !effectiveQuery
    ? "Busque em arquivos locais e alterações não salvas."
    : state.busy
      ? `Buscando em ${state.scanned} arquivo${state.scanned === 1 ? "" : "s"}…`
      : `${state.results.length} ocorrência${state.results.length === 1 ? "" : "s"} em ${groupedResults.length} arquivo${groupedResults.length === 1 ? "" : "s"}`

  return (
    <section className="ide-workspace-search" aria-label="Buscar no conteúdo do projeto">
      <div className="ide-workspace-search-head">
        <div className="ide-workspace-search-query">
          <span aria-hidden="true">⌕</span>
          <input
            ref={queryRef}
            autoFocus
            aria-label="Texto no projeto"
            placeholder="Buscar no projeto"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Escape" && query) {
                event.preventDefault()
                clearSearch()
              }
            }}
          />
          {query ? <button type="button" className="ide-workspace-search-clear" onClick={clearSearch} title="Limpar busca" aria-label="Limpar busca">×</button> : null}
        </div>

        <div className="ide-workspace-search-actions" aria-label="Opções da busca">
          <button type="button" aria-pressed={caseSensitive} title="Diferenciar maiúsculas e minúsculas" onClick={() => setCaseSensitive(value => !value)}>Aa</button>
          <button type="button" aria-pressed={wholeWord} title="Palavra inteira" onClick={() => setWholeWord(value => !value)}>ab</button>
          <button type="button" aria-pressed={showPathFilter || Boolean(pathFilter)} title="Filtrar arquivos por caminho" onClick={togglePathFilter}>⌁</button>
          {state.busy
            ? <button type="button" className="danger" onClick={() => { abortRef.current?.abort(); setState(previous => ({ ...previous, busy: false, cancelled: true })) }} title="Parar busca" aria-label="Parar busca">■</button>
            : <button type="button" onClick={() => setRevision(value => value + 1)} disabled={!effectiveQuery} title="Atualizar resultados" aria-label="Atualizar resultados">↻</button>}
        </div>
      </div>

      {showPathFilter || pathFilter ? (
        <div className="ide-workspace-search-filter">
          <span aria-hidden="true">/</span>
          <input
            aria-label="Filtrar caminhos da busca"
            placeholder="Arquivos a incluir, ex.: src/components"
            value={pathFilter}
            onChange={event => setPathFilter(event.target.value)}
          />
          {pathFilter ? <button type="button" onClick={() => setPathFilter("")} title="Limpar filtro de caminho" aria-label="Limpar filtro de caminho">×</button> : null}
        </div>
      ) : null}

      <div className="ide-workspace-search-summary" role="status">
        <span>{summary}</span>
        {state.truncated ? <b title="Refine a busca para ver todas as ocorrências">Limite atingido</b> : null}
      </div>

      <div className="ide-workspace-search-results">
        {groupedResults.map(group => (
          <section className="ide-workspace-search-group" key={group.path} aria-label={`${group.name}, ${group.matches.length} ocorrência(s)`}>
            <header>
              <div>
                <strong title={group.path}>{group.name}</strong>
                {group.directory ? <span title={group.directory}>{group.directory}</span> : null}
              </div>
              <b>{group.matches.length}</b>
            </header>
            <div className="ide-workspace-search-hits">
              {group.matches.map((result, index) => (
                <button
                  type="button"
                  key={`${result.path}:${result.line}:${result.column}:${index}`}
                  title={`${result.path}:${result.line}:${result.column}`}
                  onClick={() => onOpen(result)}
                >
                  <span className="ide-workspace-search-location">{result.line}:{result.column}</span>
                  <code>
                    {result.excerpt.slice(0, result.highlightStart)}
                    <mark>{result.excerpt.slice(result.highlightStart, result.highlightStart + result.highlightLength)}</mark>
                    {result.excerpt.slice(result.highlightStart + result.highlightLength)}
                  </code>
                </button>
              ))}
            </div>
          </section>
        ))}

        {effectiveQuery && !state.busy && !state.results.length && !state.cancelled ? (
          <div className="ide-workspace-search-empty">
            <strong>Nenhuma ocorrência encontrada</strong>
            <span>{normalizedPathFilter ? "Tente outro termo ou remova o filtro de caminho." : "Tente outro termo ou ajuste as opções da busca."}</span>
          </div>
        ) : null}

        {state.cancelled ? <div className="ide-workspace-search-message">Busca interrompida. Use ↻ para executar novamente.</div> : null}
        {state.error ? <div className="ide-workspace-search-message error" role="alert">{state.error}</div> : null}
        {state.skipped.length ? (
          <details className="ide-workspace-search-skipped">
            <summary>{state.skipped.length} arquivo{state.skipped.length === 1 ? "" : "s"} não lido{state.skipped.length === 1 ? "" : "s"}</summary>
            <div>{state.skipped.map(item => <p key={item.path}><strong>{item.path}</strong><span>{item.reason}</span></p>)}</div>
          </details>
        ) : null}
      </div>
    </section>
  )
}
