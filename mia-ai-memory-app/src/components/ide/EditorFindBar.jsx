import React, { useEffect, useMemo, useRef, useState } from "react"
import { findText } from "../../lib/ideSearch.js"

export default function EditorFindBar({ value, request, onSelect, onReplace, onClose, onMatchesChange }) {
  const [query, setQuery] = useState(request.query || "")
  const [replacement, setReplacement] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)
  const callbacks = useRef(null)
  callbacks.current = { onSelect, onReplace, onMatchesChange }
  const { matches, truncated } = useMemo(() => findText(value, query, { caseSensitive, wholeWord }), [value, query, caseSensitive, wholeWord])
  const selectedIndex = Math.max(0, Math.min(index, matches.length - 1))
  const selected = matches[selectedIndex]

  useEffect(() => {
    if (request.query) setQuery(request.query)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [request.nonce])

  useEffect(() => {
    const next = matches.findIndex(match => match.start >= (request.startOffset || 0))
    setIndex(next < 0 ? 0 : next)
  }, [query, caseSensitive, wholeWord, request.nonce])
  useEffect(() => { setIndex(current => Math.min(current, Math.max(0, matches.length - 1))) }, [matches.length])
  useEffect(() => {
    callbacks.current.onMatchesChange?.({ matches, index: selectedIndex })
  }, [matches, selectedIndex])
  useEffect(() => {
    if (selected) callbacks.current.onSelect?.(selected.start, selected.end, false)
  }, [selected?.start, selected?.end, query, caseSensitive, wholeWord])

  const navigate = direction => {
    if (!matches.length) return
    const next = (selectedIndex + direction + matches.length) % matches.length
    setIndex(next)
    callbacks.current.onSelect?.(matches[next].start, matches[next].end, false)
  }

  const replaceSelected = () => {
    if (!selected) return
    callbacks.current.onReplace?.(selected.start, selected.end, replacement)
  }

  const replaceAll = () => {
    if (!matches.length || truncated) return
    let position = 0
    const parts = []
    for (const match of matches) {
      parts.push(value.slice(position, match.start), replacement)
      position = match.end
    }
    parts.push(value.slice(position))
    callbacks.current.onReplace?.(0, value.length, parts.join(""))
  }

  return <div className="ide-find-bar" role="search" aria-label="Buscar no arquivo" onKeyDown={event => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      if (event.target.getAttribute("aria-label") === "Substituir por") replaceSelected()
      else navigate(event.shiftKey ? -1 : 1)
    }
  }}>
    <div className="ide-find-row">
      <input ref={inputRef} aria-label="Buscar no arquivo" placeholder="Buscar no arquivo…" value={query} onChange={event => setQuery(event.target.value)} />
      <button type="button" aria-label="Diferenciar maiúsculas e minúsculas" aria-pressed={caseSensitive} title="Diferenciar maiúsculas (Alt+C)" onClick={() => setCaseSensitive(current => !current)}>Aa</button>
      <button type="button" aria-label="Somente palavras inteiras" aria-pressed={wholeWord} title="Palavra inteira" onClick={() => setWholeWord(current => !current)}>Ab</button>
      <span role="status" aria-live="polite">{matches.length ? selectedIndex + 1 : 0}/{matches.length}{truncated ? "+" : ""}</span>
      <button type="button" disabled={!matches.length} onClick={() => navigate(-1)} aria-label="Resultado anterior">↑</button>
      <button type="button" disabled={!matches.length} onClick={() => navigate(1)} aria-label="Próximo resultado">↓</button>
      <button type="button" onClick={onClose} aria-label="Fechar busca">×</button>
    </div>
    {request.replace ? <div className="ide-find-row">
      <input aria-label="Substituir por" placeholder="Substituir por…" value={replacement} onChange={event => setReplacement(event.target.value)} />
      <button type="button" disabled={!selected} onClick={replaceSelected}>Substituir</button>
      <button type="button" disabled={!matches.length || truncated} title={truncated ? "Refine a busca para substituir até 10.000 ocorrências" : "Substituir todas as ocorrências no editor; salve para gravar no disco"} onClick={replaceAll}>Todas</button>
    </div> : null}
  </div>
}
