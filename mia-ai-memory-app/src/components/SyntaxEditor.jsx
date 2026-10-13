import React, { useCallback, useEffect, useRef, useState } from "react"
import EditorFindBar from "./ide/EditorFindBar.jsx"
import { getCompletions, wordPrefixAt } from "../lib/ideLanguageService.js"
import { editorModeForLanguage, loadIdeEditorEngine } from "../lib/ideEditorEngine.js"

const MAX_VISIBLE_MATCHES = 350

export default function SyntaxEditor({ value, language, path, onChange, onSave, onCursorChange, onNavigate, revealLine = null, fontSize = 14, searchRequest = null, initialSnapshot = null, onSnapshot, diagnostics = [], actionRequest = null, onEditorContextMenu }) {
  const textareaRef = useRef(null)
  const editorRef = useRef(null)
  const callbacksRef = useRef(null)
  const valueRef = useRef(value)
  const snapshotRef = useRef(initialSnapshot)
  const externallyUpdating = useRef(false)
  const marksRef = useRef([])
  const diagnosticMarksRef = useRef([])
  const actionCallbacksRef = useRef(null)
  const [engineState, setEngineState] = useState("loading")
  const [engineError, setEngineError] = useState("")
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [findRequest, setFindRequest] = useState(null)
  const [searchState, setSearchState] = useState(null)
  callbacksRef.current = { onChange, onSave, onCursorChange, onNavigate, onSnapshot }
  actionCallbacksRef.current = onEditorContextMenu
  valueRef.current = value

  const updateCursor = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const position = editor.getCursor()
    callbacksRef.current.onCursorChange?.({ line: position.line + 1, column: position.ch + 1, offset: editor.indexFromPos(position) })
  }, [])

  const showFind = useCallback(replace => {
    const editor = editorRef.current
    const selection = editor?.getSelection() || ""
    editor?.closeHint?.()
    setFindRequest(current => ({ replace: Boolean(replace), query: selection && !selection.includes("\n") && selection.length <= 300 ? selection : current?.query || "", startOffset: editor ? editor.indexFromPos(editor.getCursor()) : 0, nonce: Date.now() }))
  }, [])

  const showCompletions = useCallback(manual => {
    const editor = editorRef.current
    if (!editor || editor.somethingSelected()) return
    const position = editor.getCursor()
    const offset = editor.indexFromPos(position)
    const content = editor.getValue()
    const prefix = wordPrefixAt(content, offset)
    if (!manual && prefix.length < 2) return
    const tokenType = editor.getTokenTypeAt(position) || ""
    if (/comment|string/.test(tokenType)) return
    const items = getCompletions({ content, language, offset, limit: 35 })
    if (!items.length) return
    const from = editor.posFromIndex(offset - prefix.length)
    const to = editor.posFromIndex(offset)
    editor.showHint({
      hint: () => ({
        list: items.map(item => ({ text: item.label, displayText: item.label, className: `ide-hint-${item.kind}` })),
        from,
        to
      }),
      completeSingle: false,
      alignWithWord: true,
      closeOnUnfocus: true,
      container: document.body
    })
  }, [language])

  useEffect(() => {
    let cancelled = false
    let cleanup = () => {}
    setEngineState("loading")
    setEngineError("")
    loadIdeEditorEngine().then(CodeMirror => {
      if (cancelled || !textareaRef.current) return
      const textarea = textareaRef.current
      textarea.value = valueRef.current
      const editor = CodeMirror.fromTextArea(textarea, {
        mode: editorModeForLanguage(language),
        theme: "default",
        lineNumbers: true,
        firstLineNumber: 1,
        lineWrapping: false,
        indentUnit: 2,
        tabSize: 2,
        indentWithTabs: false,
        smartIndent: true,
        electricChars: true,
        autoCloseBrackets: true,
        autoCloseTags: true,
        matchBrackets: true,
        styleActiveLine: true,
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "ide-diagnostics-gutter", "CodeMirror-foldgutter"],
        cursorScrollMargin: 50,
        undoDepth: 350,
        historyEventDelay: 450,
        viewportMargin: 15,
        autofocus: false,
        extraKeys: {
          "Tab": cm => cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("  ", "end", "+input"),
          "Shift-Tab": "indentLess",
          "Ctrl-S": () => callbacksRef.current.onSave?.(),
          "Cmd-S": () => callbacksRef.current.onSave?.(),
          "Ctrl-F": () => showFind(false),
          "Cmd-F": () => showFind(false),
          "Ctrl-H": () => showFind(true),
          "Cmd-Alt-F": () => showFind(true),
          "Ctrl-Space": () => showCompletions(true),
          "Cmd-Space": () => showCompletions(true),
          "Ctrl-D": "selectNextOccurrence",
          "Cmd-D": "selectNextOccurrence",
          "Ctrl-L": "selectLine",
          "Cmd-L": "selectLine",
          "Shift-Ctrl-K": "deleteLine",
          "Shift-Cmd-K": "deleteLine",
          "Ctrl-/": "toggleCommentIndented",
          "Cmd-/": "toggleCommentIndented",
          "Alt-Up": "swapLineUp",
          "Alt-Down": "swapLineDown",
          "Shift-Ctrl-D": "duplicateLine",
          "Shift-Cmd-D": "duplicateLine",
          "Ctrl-Enter": "insertLineAfter",
          "Cmd-Enter": "insertLineAfter"
        }
      })
      editorRef.current = editor
      const wrapper = editor.getWrapperElement()
      wrapper.setAttribute("aria-label", `Editor ${path}`)
      editor.getInputField().setAttribute("aria-label", `Código: ${path}`)
      editor.getInputField().setAttribute("aria-multiline", "true")
      wrapper.classList.add("ide-codemirror")
      wrapper.style.fontSize = `${fontSize}px`
      if (snapshotRef.current?.content === valueRef.current) {
        try {
          editor.setHistory(snapshotRef.current.history)
          if (snapshotRef.current.cursor) editor.setCursor(snapshotRef.current.cursor)
        } catch {
          editor.clearHistory()
        }
      }
      const onEditorChange = instance => {
        if (!externallyUpdating.current) callbacksRef.current.onChange?.(instance.getValue())
      }
      let hintTimer = null
      const onInputRead = (instance, change) => {
        window.clearTimeout(hintTimer)
        if (change.origin !== "+input" || !change.text?.length || !/^[\p{L}\p{N}_$]$/u.test(change.text[change.text.length - 1])) return
        hintTimer = window.setTimeout(() => showCompletions(false), 130)
      }
      const onControlClick = event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !event.target.closest(".CodeMirror-lines")) return
        const position = editor.coordsChar({ left: event.clientX, top: event.clientY }, "window")
        const offset = editor.indexFromPos(position)
        event.preventDefault()
        event.stopPropagation()
        callbacksRef.current.onNavigate?.({ offset, mode: "smart" })
      }
      const onModifierDown = event => {
        if (event.ctrlKey || event.metaKey) wrapper.classList.add("ide-navigation-modifier")
      }
      const onModifierUp = event => {
        if (!event.ctrlKey && !event.metaKey) wrapper.classList.remove("ide-navigation-modifier")
      }
      const onWindowBlur = () => wrapper.classList.remove("ide-navigation-modifier")
      editor.on("change", onEditorChange)
      editor.on("cursorActivity", updateCursor)
      editor.on("inputRead", onInputRead)
      wrapper.addEventListener("mousedown", onControlClick, true)
      wrapper.addEventListener("keydown", onModifierDown)
      window.addEventListener("keyup", onModifierUp)
      window.addEventListener("blur", onWindowBlur)
      const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => editor.refresh()) : null
      resizeObserver?.observe(wrapper.parentElement)
      window.requestAnimationFrame(() => {
        if (editorRef.current !== editor) return
        editor.refresh()
        if (snapshotRef.current?.content === valueRef.current && Number.isFinite(snapshotRef.current.scrollTop)) editor.scrollTo(snapshotRef.current.scrollLeft || 0, snapshotRef.current.scrollTop)
        updateCursor()
      })
      setEngineState("ready")
      cleanup = () => {
        window.clearTimeout(hintTimer)
        resizeObserver?.disconnect()
        const scroll = editor.getScrollInfo()
        callbacksRef.current.onSnapshot?.({ content: editor.getValue(), history: editor.getHistory(), cursor: editor.getCursor(), scrollTop: scroll.top, scrollLeft: scroll.left })
        editor.closeHint?.()
        editor.off("change", onEditorChange)
        editor.off("cursorActivity", updateCursor)
        editor.off("inputRead", onInputRead)
        wrapper.removeEventListener("mousedown", onControlClick, true)
        wrapper.removeEventListener("keydown", onModifierDown)
        window.removeEventListener("keyup", onModifierUp)
        window.removeEventListener("blur", onWindowBlur)
        editor.toTextArea()
        editorRef.current = null
      }
    }).catch(error => {
      if (cancelled) return
      setEngineError(error.message || String(error))
      setEngineState("error")
    })
    return () => { cancelled = true; cleanup() }
  }, [language, loadAttempt, path, showFind, showCompletions, updateCursor])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !actionRequest?.nonce || (actionRequest.path && actionRequest.path !== path)) return
    const commands = {
      duplicate: "duplicateLine",
      delete: "deleteLine",
      comment: "toggleCommentIndented",
      selectAll: "selectAll",
      undo: "undo",
      redo: "redo"
    }
    if (commands[actionRequest.action]) editor.execCommand(commands[actionRequest.action])
    if (actionRequest.action === "cut") editor.replaceSelection("", "around", "+delete")
    if (actionRequest.action === "paste") editor.replaceSelection(actionRequest.text || "", "around", "+input")
    editor.focus()
    updateCursor()
  }, [actionRequest?.nonce, path, engineState, updateCursor])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return undefined
    for (const mark of diagnosticMarksRef.current) mark.clear()
    diagnosticMarksRef.current = []
    editor.clearGutter("ide-diagnostics-gutter")
    editor.operation(() => {
      for (const item of diagnostics.slice(0, 120)) {
        const line = Math.max(0, Math.min(editor.lastLine(), Number(item.line || 1) - 1))
        const text = editor.getLine(line) || ""
        const column = Math.max(0, Math.min(text.length ? text.length - 1 : 0, Number(item.column || 1) - 1))
        const marker = document.createElement("span")
        marker.className = `ide-diagnostic-marker severity-${item.severity === "warning" ? "warning" : "error"}`
        marker.textContent = "●"
        marker.title = item.message
        marker.setAttribute("aria-label", item.message)
        editor.setGutterMarker(line, "ide-diagnostics-gutter", marker)
        if (text.length) diagnosticMarksRef.current.push(editor.markText({ line, ch: column }, { line, ch: Math.min(text.length, column + 1) }, { className: `ide-diagnostic-underline severity-${item.severity === "warning" ? "warning" : "error"}`, title: item.message }))
      }
    })
    return () => { for (const mark of diagnosticMarksRef.current) mark.clear(); diagnosticMarksRef.current = []; editor.clearGutter("ide-diagnostics-gutter") }
  }, [diagnostics, engineState, path])

  const onContextMenu = event => {
    if (event.target.closest(".ide-find-bar, input:not(.CodeMirror-input)") && !event.target.closest(".CodeMirror")) return
    const editor = editorRef.current
    if (!editor || !actionCallbacksRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const position = editor.coordsChar({ left: event.clientX, top: event.clientY }, "window")
    actionCallbacksRef.current({ x: event.clientX, y: event.clientY, offset: editor.indexFromPos(position), selection: editor.getSelection(), path })
  }

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || editor.getValue() === value) return
    const selection = editor.listSelections().map(item => ({ anchor: editor.indexFromPos(item.anchor), head: editor.indexFromPos(item.head) }))
    const scroll = editor.getScrollInfo()
    externallyUpdating.current = true
    editor.setValue(value)
    editor.setSelections(selection.map(item => ({ anchor: editor.posFromIndex(Math.min(item.anchor, value.length)), head: editor.posFromIndex(Math.min(item.head, value.length)) })))
    editor.scrollTo(scroll.left, scroll.top)
    externallyUpdating.current = false
    updateCursor()
  }, [value, engineState, updateCursor])

  useEffect(() => {
    const editor = editorRef.current
    if (editor) {
      editor.getWrapperElement().style.fontSize = `${fontSize}px`
      editor.refresh()
    }
  }, [fontSize, engineState])

  useEffect(() => {
    if (engineState !== "ready" || !searchRequest?.nonce || (searchRequest.path && searchRequest.path !== path)) return
    showFind(searchRequest.replace)
  }, [searchRequest?.nonce, engineState, showFind])

  useEffect(() => {
    if (engineState !== "ready" || !revealLine?.line || revealLine.path !== path) return
    const editor = editorRef.current
    if (!editor) return
    const line = Math.max(0, Math.min(editor.lastLine(), Number(revealLine.line) - 1))
    const ch = Math.max(0, Math.min(editor.getLine(line).length, Number(revealLine.column || 1) - 1))
    const start = { line, ch }
    const end = editor.posFromIndex(Math.min(editor.getValue().length, editor.indexFromPos(start) + (revealLine.length || 0)))
    editor.setSelection(start, end)
    editor.scrollIntoView({ from: start, to: end }, 90)
    editor.focus()
    updateCursor()
  }, [engineState, path, revealLine?.nonce, updateCursor])

  useEffect(() => {
    const editor = editorRef.current
    for (const mark of marksRef.current) mark.clear()
    marksRef.current = []
    if (!editor || !findRequest || !searchState?.matches?.length) return
    const matches = searchState.matches
    const active = Math.max(0, Math.min(searchState.index, matches.length - 1))
    const indices = matches.length <= MAX_VISIBLE_MATCHES
      ? matches.map((_, index) => index)
      : Array.from({ length: MAX_VISIBLE_MATCHES }, (_, index) => index + Math.max(0, Math.min(active - 100, matches.length - MAX_VISIBLE_MATCHES)))
    editor.operation(() => {
      for (const index of indices) {
        const match = matches[index]
        marksRef.current.push(editor.markText(editor.posFromIndex(match.start), editor.posFromIndex(match.end), { className: index === active ? "ide-cm-search-current" : "ide-cm-search-match", clearOnEnter: false }))
      }
    })
    return () => { for (const mark of marksRef.current) mark.clear(); marksRef.current = [] }
  }, [findRequest, searchState, value, engineState])

  const selectRange = (start, end, focus = true) => {
    const editor = editorRef.current
    if (!editor) return
    const from = editor.posFromIndex(start)
    const to = editor.posFromIndex(end)
    editor.setSelection(from, to, { scroll: false })
    editor.scrollIntoView({ from, to }, 80)
    if (focus) editor.focus()
    updateCursor()
  }

  const replaceRange = (start, end, replacement) => {
    const editor = editorRef.current
    if (!editor) return
    const from = editor.posFromIndex(start)
    const to = editor.posFromIndex(end)
    editor.replaceRange(replacement, from, to, "+input")
    const cursor = editor.posFromIndex(start + replacement.length)
    editor.setCursor(cursor)
    editor.scrollIntoView(cursor, 80)
    updateCursor()
  }

  return <div className="ide-editor-surface" onContextMenuCapture={onContextMenu}>
    {findRequest && engineState === "ready" ? <EditorFindBar value={value} request={findRequest} onSelect={selectRange} onReplace={replaceRange} onClose={() => { setFindRequest(null); setSearchState(null); editorRef.current?.focus() }} onMatchesChange={setSearchState} /> : null}
    <div className="ide-codemirror-container">
      <textarea ref={textareaRef} defaultValue={value} aria-label={`Editor ${path}`} className="ide-codemirror-source" />
      {engineState === "loading" ? <div className="ide-editor-loading" role="status">Iniciando editor de código…</div> : null}
      {engineState === "error" ? <div className="ide-editor-loading error" role="alert"><strong>O editor não pôde ser carregado.</strong><span>{engineError}</span><button type="button" onClick={() => setLoadAttempt(current => current + 1)}>Tentar novamente</button></div> : null}
    </div>
  </div>
}
