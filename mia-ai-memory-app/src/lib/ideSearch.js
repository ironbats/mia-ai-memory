const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isWord = value => Boolean(value && /[\p{L}\p{N}_$]/u.test(value))

export function findText(content, query, { caseSensitive = false, wholeWord = false, limit = 10000 } = {}) {
  if (!query) return { matches: [], truncated: false }
  const expression = new RegExp(escapePattern(query), caseSensitive ? "gu" : "giu")
  const matches = []
  let match
  while ((match = expression.exec(content))) {
    const start = match.index
    const end = start + match[0].length
    if (wholeWord && (isWord(content[start - 1]) || isWord(content[end]))) continue
    if (matches.length >= limit) return { matches, truncated: true }
    matches.push({ start, end })
  }
  return { matches, truncated: false }
}

export async function searchWorkspace({ paths, drafts, readPath, query, caseSensitive, wholeWord, signal, onProgress }) {
  const results = []
  const skipped = []
  let scanned = 0
  let bytes = 0
  let truncated = false
  const check = () => { if (signal.aborted) throw new DOMException("Busca cancelada", "AbortError") }
  for (const path of paths) {
    check()
    let content
    try { content = drafts.has(path) ? drafts.get(path) : await readPath(path) }
    catch (error) {
      check()
      skipped.push({ path, reason: error.message || String(error) })
      scanned += 1
      continue
    }
    check()
    bytes += content.length * 2
    if (bytes > 32 * 1024 * 1024) { truncated = true; break }
    const found = findText(content, query, { caseSensitive, wholeWord, limit: 300 - results.length })
    let line = 1
    let lineStart = 0
    let cursor = 0
    for (const match of found.matches) {
      while (cursor < match.start) {
        if (content[cursor] === "\n") { line += 1; lineStart = cursor + 1 }
        cursor += 1
      }
      const column = match.start - lineStart + 1
      const endOfLine = content.indexOf("\n", match.start)
      const excerptStart = Math.max(lineStart, match.start - 70)
      const excerptEnd = Math.min(endOfLine < 0 ? content.length : endOfLine, match.end + 150)
      results.push({ path, line, column, length: match.end - match.start,
        excerpt: content.slice(excerptStart, excerptEnd), highlightStart: match.start - excerptStart,
        highlightLength: Math.min(match.end, excerptEnd) - match.start })
    }
    scanned += 1
    if (found.truncated || results.length >= 300) { truncated = true; break }
    if (scanned % 8 === 0) {
      onProgress?.(scanned)
      await new Promise(resolve => window.setTimeout(resolve, 0))
    }
  }
  check()
  return { results, skipped, scanned, truncated }
}
