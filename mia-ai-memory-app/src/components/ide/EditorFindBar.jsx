import React, { useEffect, useMemo, useRef, useState } from "react"
import { findText } from "../../lib/ideSearch.js"

export default function EditorFindBar({ value, request, onSelect, onReplace, onClose }) {
  const [query, setQuery] = useState(request.query || "")
  const [replacement, setReplacement] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [index, setIndex] = useState(0)
  const inputRef = useRef(null)
  const { matches, truncated } = useMemo(() => findText(value, query, { caseSensitive, wholeWord }), [value, query, caseSensitive, wholeWord])
  const selected = matches[Math.min(index, Math.max(0, matches.length - 1))]
  const callbacks = useRef({ onSelect })
  callbacks.current = { onSelect }
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [request.nonce])
  useEffect(() => { setIndex(0) }, [query, caseSensitive, wholeWord])
  useEffect(() => { setIndex(current => Math.min(current, Math.max(0, matches.length - 1))) }, [matches.length])
  useEffect(() => { if (selected) callbacks.current.onSelect(selected.start, selected.end, false) }, [selected?.start, selected?.end, value])
  const navigate = direction => {
    if (!matches.length) return
    const next = (index + direction + matches.length) % matches.length
    setIndex(next)
    onSelect(matches[next].start, matches[next].end, false)
  }
  const replaceAll = () => {
    if (!matches.length || truncated) return
    let position = 0
    const parts = []
    for (const match of matches) { parts.push(value.slice(position, match.start), replacement); position = match.end }
    parts.push(value.slice(position))
    onReplace(0, value.length, parts.join(""))
  }
  return <div className="ide-find-bar" role="search" aria-label="Buscar no arquivo" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === "Enter") { event.preventDefault(); navigate(event.shiftKey ? -1 : 1) }
  }}>
    <div className="ide-find-row">
      <input ref={inputRef} aria-label="Buscar no arquivo" placeholder="Buscar no arquivo…" value={query} onChange={event => setQuery(event.target.value)} />
      <button aria-pressed={caseSensitive} title="Diferenciar maiúsculas" onClick={() => setCaseSensitive(value => !value)}>Aa</button>
      <button aria-pressed={wholeWord} title="Palavra inteira" onClick={() => setWholeWord(value => !value)}>Ab</button>
      <span role="status">{matches.length ? index + 1 : 0}/{matches.length}{truncated ? "+" : ""}</span>
      <button disabled={!matches.length} onClick={() => navigate(-1)} aria-label="Resultado anterior">↑</button>
      <button disabled={!matches.length} onClick={() => navigate(1)} aria-label="Próximo resultado">↓</button>
      <button onClick={onClose} aria-label="Fechar busca">×</button>
    </div>
    {request.replace ? <div className="ide-find-row"><input aria-label="Substituir por" placeholder="Substituir por…" value={replacement} onChange={event => setReplacement(event.target.value)} />
      <button disabled={!selected} onClick={() => { if (selected) onReplace(selected.start, selected.end, replacement) }}>Substituir</button>
      <button disabled={!matches.length || truncated} title={truncated ? "Refine a busca para substituir até 10.000 ocorrências" : "Alterar todas as ocorrências no editor; salve para gravar no disco"} onClick={replaceAll}>Todas</button></div> : null}
  </div>
}
