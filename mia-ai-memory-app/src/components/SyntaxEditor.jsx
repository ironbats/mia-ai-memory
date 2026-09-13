import React, { useEffect, useMemo, useRef, useState } from "react"
import EditorFindBar from "./ide/EditorFindBar.jsx"
import { getCompletions, wordPrefixAt } from "../lib/ideLanguageService.js"

const MAX_HIGHLIGHT_CHARS = 360000

const commonKeywords = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "defer", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "fn", "for", "from", "func", "function", "go", "if", "implements", "import", "in", "interface", "let", "match", "mod", "new", "package", "private", "protected", "pub", "public", "return", "select", "static", "struct", "super", "switch", "this", "throw", "trait", "true", "try", "type", "typeof", "undefined", "use", "var", "void", "while", "with", "yield"
])

const languageKeywords = {
  "C": ["auto", "char", "double", "extern", "float", "inline", "int", "long", "register", "restrict", "short", "signed", "sizeof", "typedef", "union", "unsigned", "volatile"],
  "C++": ["alignas", "alignof", "constexpr", "decltype", "friend", "mutable", "namespace", "noexcept", "operator", "template", "typename", "using", "virtual"],
  "C#": ["base", "checked", "decimal", "delegate", "event", "explicit", "implicit", "internal", "is", "lock", "namespace", "object", "out", "override", "params", "readonly", "ref", "sealed", "stackalloc", "string"],
  "Go": ["chan", "const", "fallthrough", "func", "go", "goto", "interface", "map", "package", "range", "select", "struct", "type"],
  "Java": ["boolean", "byte", "char", "double", "final", "float", "int", "long", "native", "short", "strictfp", "synchronized", "throws", "transient", "volatile"],
  "Kotlin": ["actual", "annotation", "companion", "crossinline", "data", "expect", "external", "infix", "inline", "inner", "lateinit", "noinline", "object", "open", "operator", "out", "reified", "sealed", "suspend", "tailrec", "vararg"],
  "Python": ["and", "assert", "async", "await", "def", "del", "elif", "except", "global", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "None"],
  "React JSX": ["const", "let", "var", "function", "return", "import", "export", "from", "async", "await", "class", "extends", "new", "this", "typeof", "instanceof"],
  "React TSX": ["const", "let", "var", "function", "return", "import", "export", "from", "async", "await", "class", "extends", "new", "this", "typeof", "instanceof", "interface", "type", "keyof", "readonly", "namespace", "declare"],
  "Ruby": ["alias", "begin", "defined?", "elsif", "end", "ensure", "module", "next", "redo", "rescue", "retry", "self", "then", "unless", "until", "when"],
  "Rust": ["as", "async", "await", "const", "crate", "dyn", "extern", "impl", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "self", "Self", "static", "struct", "trait", "unsafe", "use", "where"],
  "Scala": ["def", "extends", "given", "implicit", "lazy", "match", "object", "override", "sealed", "using", "val", "var"],
  "TypeScript": ["const", "let", "var", "function", "return", "import", "export", "from", "async", "await", "class", "extends", "new", "this", "typeof", "instanceof", "interface", "type", "keyof", "readonly", "namespace", "declare"],
  "JavaScript": ["const", "let", "var", "function", "return", "import", "export", "from", "async", "await", "class", "extends", "new", "this", "typeof", "instanceof"]
}

const hashCommentLanguages = new Set(["Python", "Ruby", "Shell", "PowerShell", "YAML", "TOML", "Makefile"])
const markupLanguages = new Set(["HTML", "XML", "Vue", "Svelte"])
const cssLanguages = new Set(["CSS", "SCSS", "Sass", "Less"])
const constantWords = new Set(["true", "false", "null", "nil", "None", "undefined", "NaN", "Infinity"])

const mergeToken = (tokens, type, value) => {
  if (!value) return
  const previous = tokens[tokens.length - 1]
  if (previous?.type === type) previous.value += value
  else tokens.push({ type, value })
}

const isIdentifierStart = char => /[A-Za-z_$]/.test(char || "")
const isIdentifierPart = char => /[A-Za-z0-9_$]/.test(char || "")
const isDigit = char => /[0-9]/.test(char || "")

const nextNonSpace = (text, start) => {
  let index = start
  while (index < text.length && /\s/.test(text[index])) index += 1
  return text[index] || ""
}

const codeTokens = (text, language) => {
  const tokens = []
  const keywords = new Set([...commonKeywords, ...(languageKeywords[language] || [])])
  const hashComments = hashCommentLanguages.has(language)
  let index = 0

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]

    if (/\s/.test(char)) {
      let end = index + 1
      while (end < text.length && /\s/.test(text[end])) end += 1
      mergeToken(tokens, "plain", text.slice(index, end))
      index = end
      continue
    }

    if (hashComments && char === "#") {
      const end = text.indexOf("\n", index)
      mergeToken(tokens, "comment", text.slice(index, end < 0 ? text.length : end))
      index = end < 0 ? text.length : end
      continue
    }

    if (!hashComments && char === "/" && next === "/") {
      const end = text.indexOf("\n", index)
      mergeToken(tokens, "comment", text.slice(index, end < 0 ? text.length : end))
      index = end < 0 ? text.length : end
      continue
    }

    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2)
      const finish = end < 0 ? text.length : end + 2
      mergeToken(tokens, "comment", text.slice(index, finish))
      index = finish
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      const quote = char
      const triple = quote !== "`" && text.slice(index, index + 3) === quote.repeat(3)
      let end = index + (triple ? 3 : 1)
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2
          continue
        }
        if (triple && text.slice(end, end + 3) === quote.repeat(3)) {
          end += 3
          break
        }
        if (!triple && text[end] === quote) {
          end += 1
          break
        }
        end += 1
      }
      mergeToken(tokens, "string", text.slice(index, end))
      index = end
      continue
    }

    if (isDigit(char) || (char === "." && isDigit(next))) {
      let end = index + 1
      while (end < text.length && /[0-9A-Fa-f_xXobOB.eE+-]/.test(text[end])) end += 1
      mergeToken(tokens, "number", text.slice(index, end))
      index = end
      continue
    }

    if (char === "@" && isIdentifierStart(next)) {
      let end = index + 2
      while (end < text.length && isIdentifierPart(text[end])) end += 1
      mergeToken(tokens, "annotation", text.slice(index, end))
      index = end
      continue
    }

    if (isIdentifierStart(char)) {
      let end = index + 1
      while (end < text.length && isIdentifierPart(text[end])) end += 1
      const word = text.slice(index, end)
      if (constantWords.has(word)) mergeToken(tokens, "constant", word)
      else if (keywords.has(word)) mergeToken(tokens, "keyword", word)
      else if (/^[A-Z][A-Za-z0-9_$]*$/.test(word)) mergeToken(tokens, "type", word)
      else if (nextNonSpace(text, end) === "(") mergeToken(tokens, "function", word)
      else mergeToken(tokens, "plain", word)
      index = end
      continue
    }

    if (/[+\-*=<>!&|%^~?:]/.test(char)) {
      let end = index + 1
      while (end < text.length && /[+\-*=<>!&|%^~?:]/.test(text[end])) end += 1
      mergeToken(tokens, "operator", text.slice(index, end))
      index = end
      continue
    }

    if (/[{}()[\],.;]/.test(char)) mergeToken(tokens, "punctuation", char)
    else mergeToken(tokens, "plain", char)
    index += 1
  }

  return tokens
}

const markupTokens = text => {
  const tokens = []
  let index = 0
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4)
      const finish = end < 0 ? text.length : end + 3
      mergeToken(tokens, "comment", text.slice(index, finish))
      index = finish
      continue
    }
    if (text[index] !== "<") {
      const end = text.indexOf("<", index)
      mergeToken(tokens, "plain", text.slice(index, end < 0 ? text.length : end))
      index = end < 0 ? text.length : end
      continue
    }
    const end = text.indexOf(">", index + 1)
    const finish = end < 0 ? text.length : end + 1
    const tag = text.slice(index, finish)
    const parts = tag.match(/(<\/?|\/?>|=|\s+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_:][-A-Za-z0-9_:.]*|.)/g) || [tag]
    let nameSeen = false
    for (const part of parts) {
      if (/^<\/?$|^\/?>$|^=$/.test(part)) mergeToken(tokens, "punctuation", part)
      else if (/^\s+$/.test(part)) mergeToken(tokens, "plain", part)
      else if (/^["']/.test(part)) mergeToken(tokens, "string", part)
      else if (!nameSeen && /^[A-Za-z_:]/.test(part)) {
        mergeToken(tokens, "tag", part)
        nameSeen = true
      } else if (/^[A-Za-z_:]/.test(part)) mergeToken(tokens, "attribute", part)
      else mergeToken(tokens, "plain", part)
    }
    index = finish
  }
  return tokens
}

const cssTokens = text => {
  const base = codeTokens(text, "CSS")
  return base.map(token => {
    if (token.type !== "plain") return token
    if (/^#[A-Fa-f0-9]{3,8}$/.test(token.value)) return { ...token, type: "number" }
    return token
  })
}

const markdownTokens = text => {
  const tokens = []
  const lines = text.split(/(?<=\n)/)
  let fenced = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      mergeToken(tokens, "keyword", line)
      fenced = !fenced
      continue
    }
    if (fenced) {
      mergeToken(tokens, "string", line)
      continue
    }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      mergeToken(tokens, "heading", line)
      continue
    }
    if (/^\s*>/.test(line)) {
      mergeToken(tokens, "comment", line)
      continue
    }
    const parts = line.split(/(`[^`]*`|\[[^\]]+\]\([^\)]+\)|\*\*[^*]+\*\*|__[^_]+__)/g)
    for (const part of parts) {
      if (/^`/.test(part)) mergeToken(tokens, "string", part)
      else if (/^\[/.test(part)) mergeToken(tokens, "link", part)
      else if (/^(\*\*|__)/.test(part)) mergeToken(tokens, "keyword", part)
      else mergeToken(tokens, "plain", part)
    }
  }
  return tokens
}

const jsonTokens = text => {
  const tokens = codeTokens(text, "JSON")
  return tokens.map((token, index) => {
    if (token.type !== "string") return token
    const tail = tokens.slice(index + 1).find(item => item.value.trim())
    return tail?.value.trim().startsWith(":") ? { ...token, type: "attribute" } : token
  })
}

const tokenize = (text, language) => {
  if (text.length > MAX_HIGHLIGHT_CHARS) return [{ type: "plain", value: text }]
  if (markupLanguages.has(language)) return markupTokens(text)
  if (cssLanguages.has(language)) return cssTokens(text)
  if (language === "Markdown" || language === "MDX") return markdownTokens(text)
  if (language === "JSON") return jsonTokens(text)
  return codeTokens(text, language)
}

export default function SyntaxEditor({ value, language, path, onChange, onSave, onCursorChange, revealLine = null, fontSize = 14, searchRequest = null }) {
  const [findRequest, setFindRequest] = useState(null)
  const highlightRef = useRef(null)
  const lineRef = useRef(null)
  const textareaRef = useRef(null)
  const [completionOpen, setCompletionOpen] = useState(false)
  const [completionItems, setCompletionItems] = useState([])
  const [completionIndex, setCompletionIndex] = useState(0)
  const [completionAnchor, setCompletionAnchor] = useState({ top: 22, left: 10 })
  const tokens = useMemo(() => tokenize(String(value || ""), language), [language, value])
  const lineNumbers = useMemo(() => Array.from({ length: Math.max(1, String(value || "").split("\n").length) }, (_, index) => index + 1).join("\n"), [value])

  const syncLayers = textarea => {
    if (!textarea) return
    if (highlightRef.current) {
      highlightRef.current.scrollTop = textarea.scrollTop
      highlightRef.current.scrollLeft = textarea.scrollLeft
    }
    if (lineRef.current) lineRef.current.scrollTop = textarea.scrollTop
  }

  const syncScroll = event => {
    syncLayers(event.currentTarget)
    if (completionOpen) setCompletionOpen(false)
  }

  const updateCursor = event => {
    const textarea = event.currentTarget
    if (!textarea) return
    const before = textarea.value.slice(0, textarea.selectionStart)
    const line = before.split("\n").length
    const lastBreak = before.lastIndexOf("\n")
    const column = textarea.selectionStart - lastBreak
    onCursorChange?.({ line, column })
  }

  const openCompletions = (textarea, content = value) => {
    const offset = textarea.selectionStart
    const items = getCompletions({ content, language, offset, limit: 10 })
    if (!items.length) {
      setCompletionOpen(false)
      return
    }
    const before = content.slice(0, offset)
    const line = before.split("\n").length
    const lastBreak = before.lastIndexOf("\n")
    const column = offset - lastBreak
    const lineHeight = fontSize * 1.55
    const charWidth = fontSize * 0.62
    const maxTop = Math.max(80, textarea.clientHeight - 190)
    const maxLeft = Math.max(160, textarea.clientWidth - 310)
    const top = Math.max(8, Math.min(maxTop, (line - 1) * lineHeight - textarea.scrollTop + lineHeight + 8))
    const left = Math.max(8, Math.min(maxLeft, (column - 1) * charWidth - textarea.scrollLeft + 14))
    setCompletionItems(items)
    setCompletionIndex(0)
    setCompletionAnchor({ top, left })
    setCompletionOpen(true)
  }

  const applyCompletion = item => {
    const textarea = textareaRef.current
    if (!textarea || !item) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const prefix = wordPrefixAt(value, start)
    const replaceStart = Math.max(0, start - prefix.length)
    const next = `${value.slice(0, replaceStart)}${item.label}${value.slice(end)}`
    onChange(next)
    setCompletionOpen(false)
    window.requestAnimationFrame(() => {
      const position = replaceStart + item.label.length
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(position, position)
      updateCursor({ currentTarget: textareaRef.current })
    })
  }

  const handleChange = event => {
    const textarea = event.currentTarget
    const nextValue = textarea.value
    onChange(nextValue)
    if (completionOpen) window.requestAnimationFrame(() => openCompletions(textarea, nextValue))
  }

  const selectRange = (start, end, focus = true) => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (focus) textarea.focus()
    textarea.setSelectionRange(start, end)
    const before = textarea.value.slice(0, start)
    const line = before.split("\n").length
    const column = start - before.lastIndexOf("\n")
    const lineHeight = fontSize * 1.55
    textarea.scrollTop = Math.max(0, (line - 4) * lineHeight)
    textarea.scrollLeft = Math.max(0, (column - 1) * fontSize * 0.62 - textarea.clientWidth / 2)
    syncLayers(textarea)
    updateCursor({ currentTarget: textarea })
  }

  const replaceRange = (start, end, replacement) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const previousFocus = document.activeElement
    textarea.focus()
    textarea.setSelectionRange(start, end)
    // Native insertion preserves the textarea's undo history in Chrome/Edge.
    const inserted = document.execCommand("insertText", false, replacement)
    if (!inserted) onChange(`${value.slice(0, start)}${replacement}${value.slice(end)}`)
    window.requestAnimationFrame(() => {
      syncLayers(textarea)
      updateCursor({ currentTarget: textarea })
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    })
  }

  const showFind = (replace = false) => {
    const textarea = textareaRef.current
    const selection = textarea ? value.slice(textarea.selectionStart, textarea.selectionEnd) : ""
    setCompletionOpen(false)
    setFindRequest(current => ({ replace, query: selection && !selection.includes("\n") ? selection : current?.query || "", nonce: Date.now() }))
  }

  useEffect(() => {
    if (searchRequest) showFind(searchRequest.replace)
  }, [searchRequest?.nonce])

  const handleKeyDown = event => {
    if (event.isComposing || event.nativeEvent?.isComposing) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ["f", "h"].includes(event.key.toLowerCase())) {
      event.preventDefault()
      showFind(event.key.toLowerCase() === "h")
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
      event.preventDefault()
      openCompletions(event.currentTarget)
      return
    }
    if (completionOpen && event.key === "ArrowDown") {
      event.preventDefault()
      setCompletionIndex(current => Math.min(current + 1, completionItems.length - 1))
      return
    }
    if (completionOpen && event.key === "ArrowUp") {
      event.preventDefault()
      setCompletionIndex(current => Math.max(0, current - 1))
      return
    }
    if (completionOpen && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault()
      applyCompletion(completionItems[completionIndex])
      return
    }
    if (completionOpen && event.key === "Escape") {
      event.preventDefault()
      setCompletionOpen(false)
      return
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault()
      onSave?.()
      return
    }
    if (event.key === "Tab") {
      event.preventDefault()
      const textarea = event.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const next = `${value.slice(0, start)}  ${value.slice(end)}`
      onChange(next)
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(start + 2, start + 2)
        updateCursor({ currentTarget: textareaRef.current })
      })
    }
  }

  useEffect(() => {
    if (!revealLine?.line || revealLine.path !== path) return
    const textarea = textareaRef.current
    if (!textarea) return
    const lines = value.split("\n")
    const targetLine = Math.min(lines.length, Math.max(1, Number(revealLine.line) || 1))
    let offset = 0
    for (let index = 0; index < targetLine - 1; index += 1) offset += lines[index].length + 1
    offset += Math.min(lines[targetLine - 1].length, Math.max(0, Number(revealLine.column || 1) - 1))
    selectRange(offset, Math.min(value.length, offset + (revealLine.length || 0)))
  }, [fontSize, path, revealLine?.nonce])

  return (
    <div className="ide-editor-surface">
      {findRequest ? <EditorFindBar value={value} request={findRequest} onSelect={selectRange} onReplace={replaceRange} onClose={() => { setFindRequest(null); textareaRef.current?.focus() }} /> : null}
    <div className="ide-syntax-shell">
      <pre ref={lineRef} className="ide-syntax-lines" aria-hidden="true">{lineNumbers}</pre>
      <div className="ide-syntax-editor">
        <pre ref={highlightRef} className="ide-syntax-highlight" aria-hidden="true">{tokens.map((token, index) => token.type === "plain" ? <React.Fragment key={index}>{token.value}</React.Fragment> : <span key={index} className={`syntax-${token.type}`}>{token.value}</span>)}</pre>
        <textarea ref={textareaRef} value={value} onChange={handleChange} onKeyDown={handleKeyDown} onScroll={syncScroll} onClick={event => { updateCursor(event); setCompletionOpen(false) }} onKeyUp={updateCursor} onSelect={updateCursor} spellCheck="false" wrap="off" aria-label={`Editor ${path}`} />
        {completionOpen ? <div className="ide-completion-popup" style={completionAnchor}>
          <header><span>Local Intelligence</span><kbd>Ctrl+Space</kbd></header>
          {completionItems.map((item, index) => <button type="button" key={`${item.kind}:${item.label}`} className={index === completionIndex ? "active" : ""} onMouseDown={event => { event.preventDefault(); applyCompletion(item) }}><i>{item.kind === "keyword" ? "K" : "S"}</i><strong>{item.label}</strong><small>{item.kind}</small></button>)}
        </div> : null}
      </div>
    </div>
    </div>
  )
}
