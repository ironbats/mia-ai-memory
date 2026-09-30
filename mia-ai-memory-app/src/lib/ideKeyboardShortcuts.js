const normalizeKey = value => String(value || "").toLowerCase()

export const isEditableShortcutTarget = target => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]'))

export const resolveIdeShortcut = event => {
  if (!event || event.isComposing) return ""
  const key = normalizeKey(event.key)
  const primary = event.ctrlKey || event.metaKey
  const shift = event.shiftKey
  const alt = event.altKey

  if (!primary && !alt && !shift && event.key === "F1") return "command-palette"
  if (!primary && !alt && !shift && event.key === "F12") return "go-definition"
  if (primary && !alt && event.key === "F12") return "go-implementation"
  if (!primary && alt && shift && key === "f") return "format-document"
  if (!primary && alt && !shift && event.key === "ArrowLeft") return "navigate-back"
  if (!primary && alt && !shift && event.key === "ArrowRight") return "navigate-forward"
  if (!primary && alt && !shift && event.key === "PageDown") return "next-tab"
  if (!primary && alt && !shift && event.key === "PageUp") return "previous-tab"

  if (!primary || alt) return ""

  if (event.key === "Tab") return shift ? "previous-tab" : "next-tab"

  if (shift) {
    if (key === "p") return "command-palette"
    if (key === "e") return "explorer-view"
    if (key === "f") return "project-search"
    if (key === "g") return "changes"
    if (key === "m") return "problems"
    if (key === "o") return "outline"
    if (key === "s") return "save-all"
    if (key === "t") return "reopen-editor"
    return ""
  }

  if (key === "e" || key === "p" || key === "o") return "quick-open"
  if (key === "n") return "new-file"
  if (key === "f") return "find"
  if (key === "h") return "replace"
  if (key === "g") return "go-line"
  if (key === "b") return "explorer"
  if (key === "j") return "panel"
  if (key === "s") return "save-file"
  if (key === "w") return "close-editor"
  if (event.key === "`") return "terminal"
  if (event.key === "PageDown") return "next-tab"
  if (event.key === "PageUp") return "previous-tab"
  return ""
}

export const resolveIdeZoomShortcut = event => {
  if (!event || event.isComposing) return ""
  const primary = event.ctrlKey || event.metaKey
  if (!primary || !event.altKey || event.shiftKey) return ""
  if (event.key === "=" || event.key === "+") return "zoom-in"
  if (event.key === "-") return "zoom-out"
  if (event.key === "0") return "zoom-reset"
  return ""
}
