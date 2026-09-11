import React, { useEffect, useMemo, useRef, useState } from "react"
import SyntaxEditor from "./SyntaxEditor.jsx"
import IdeDialog from "./IdeDialog.jsx"
import IdeWorkbenchPanel from "./IdeWorkbenchPanel.jsx"
import { analyzeDocument } from "../lib/ideLanguageService.js"

const fileBadge = path => {
  const name = String(path || "").split("/").pop() || ""
  const lower = name.toLowerCase()
  if (lower === "dockerfile") return { label: "DK", tone: "docker" }
  if (lower === "makefile") return { label: "MK", tone: "build" }
  const ext = lower.includes(".") ? lower.split(".").pop() : ""
  const map = {
    js: ["JS", "js"], jsx: ["JSX", "js"], ts: ["TS", "ts"], tsx: ["TSX", "ts"],
    go: ["GO", "go"], rs: ["RS", "rust"], py: ["PY", "python"], java: ["JAVA", "java"], kt: ["KT", "kotlin"], kts: ["KT", "kotlin"],
    rb: ["RB", "ruby"], php: ["PHP", "php"], cs: ["C#", "csharp"], cpp: ["C++", "cpp"], cc: ["C++", "cpp"], c: ["C", "cpp"], h: ["H", "cpp"], hpp: ["H++", "cpp"],
    html: ["HTML", "html"], htm: ["HTML", "html"], css: ["CSS", "css"], scss: ["SCSS", "css"], sass: ["SASS", "css"], less: ["LESS", "css"],
    json: ["{}", "json"], yaml: ["YML", "yaml"], yml: ["YML", "yaml"], toml: ["TOML", "toml"], xml: ["XML", "xml"],
    md: ["MD", "markdown"], mdx: ["MDX", "markdown"], sql: ["SQL", "sql"], sh: ["SH", "shell"], bash: ["SH", "shell"], zsh: ["ZSH", "shell"],
    vue: ["VUE", "vue"], svelte: ["SV", "svelte"], graphql: ["GQL", "graphql"], gql: ["GQL", "graphql"], proto: ["PB", "proto"], tf: ["TF", "terraform"]
  }
  const [label, tone] = map[ext] || [(ext || "TXT").slice(0, 4).toUpperCase(), "plain"]
  return { label, tone }
}

const fuzzyScore = (sourceValue, query) => {
  const source = String(sourceValue || "").toLowerCase()
  const normalized = query.trim().toLowerCase()
  if (!normalized) return 0
  const name = source.split("/").pop()
  if (name === normalized) return 1000
  if (name.startsWith(normalized)) return 800 - name.length
  if (name.includes(normalized)) return 650 - name.indexOf(normalized)
  if (source.includes(normalized)) return 500 - source.indexOf(normalized)
  let cursor = 0
  let score = 0
  for (const char of normalized) {
    const found = source.indexOf(char, cursor)
    if (found < 0) return -1
    score += found === cursor ? 9 : 3
    cursor = found + 1
  }
  return score
}

const EMPTY_ANALYSIS = { symbols: [], diagnostics: [], symbolCount: 0, errorCount: 0, warningCount: 0, truncated: false }

const changeLetter = change => {
  if (!change) return ""
  if (!change.beforeExists && change.afterExists) return "A"
  if (change.beforeExists && !change.afterExists) return "D"
  return "M"
}

const TreeNode = ({ node, depth, workspace, expandedPaths, onToggleDirectory, onError, changeMap }) => {
  if (node.type === "directory") {
    const expanded = expandedPaths.has(node.path)
    return (
      <div className="ide-tree-group">
        <button className="ide-tree-row directory" style={{ paddingLeft: 7 + depth * 10 }} onClick={() => onToggleDirectory(node.path)} aria-expanded={expanded} title={node.path}>
          <i>{expanded ? "⌄" : "›"}</i><span className="ide-tree-folder">◆</span><strong>{node.name}</strong>
        </button>
        {expanded ? node.children.map(child => <TreeNode key={child.path} node={child} depth={depth + 1} workspace={workspace} expandedPaths={expandedPaths} onToggleDirectory={onToggleDirectory} onError={onError} changeMap={changeMap} />) : null}
      </div>
    )
  }
  const pinned = workspace.contextPaths.includes(node.path)
  const badge = fileBadge(node.path)
  const change = changeMap.get(node.path)
  return (
    <div className={`ide-tree-file-wrap${workspace.activePath === node.path ? " active" : ""}`}>
      <button className="ide-tree-row file" style={{ paddingLeft: 18 + depth * 10 }} onClick={() => workspace.openFile(node.path).catch(error => onError(error.message || String(error)))} title={node.path}>
        <span className={`ide-file-icon tone-${badge.tone}`}>{badge.label}</span><strong>{node.name}</strong>{change ? <em className={`ide-tree-change change-${changeLetter(change).toLowerCase()}`}>{changeLetter(change)}</em> : null}
      </button>
      <button className={`ide-context-pin${pinned ? " active" : ""}`} onClick={() => workspace.toggleContext(node.path)} title={pinned ? "Remover do contexto do agente" : "Fixar no contexto do agente"}>●</button>
    </div>
  )
}

const loadNumber = (key, fallback) => {
  if (typeof window === "undefined") return fallback
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch {
    return fallback
  }
}

const IDE_ZOOM_STEPS = [90, 100, 110, 120, 130]

const clampIdeZoom = value => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 100
  return IDE_ZOOM_STEPS.reduce((best, step) => Math.abs(step - numeric) < Math.abs(best - numeric) ? step : best, 100)
}

const buildIdeMetrics = zoom => {
  const factor = zoom / 100
  const px = value => `${Math.round(value * factor * 10) / 10}px`
  return {
    "--ide-font-xs": px(9),
    "--ide-font-sm": px(10),
    "--ide-font-md": px(11),
    "--ide-font-lg": px(12),
    "--ide-font-xl": px(13),
    "--ide-font-title": px(14),
    "--ide-code-font-size": px(14),
    "--ide-tree-row-height": px(28),
    "--ide-control-height": px(30),
    "--ide-tab-height": px(34),
    "--ide-status-height": px(28),
    "--ide-workbench-tab-height": px(32)
  }
}

export default function CodeWorkspace({ workspace, layout = "split", onLayoutChange, onClose }) {
  const [query, setQuery] = useState("")
  const [localError, setLocalError] = useState("")
  const [expandedPaths, setExpandedPaths] = useState(() => new Set())
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickQuery, setQuickQuery] = useState("")
  const [quickIndex, setQuickIndex] = useState(0)
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState("")
  const [commandIndex, setCommandIndex] = useState(0)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [dialog, setDialog] = useState(null)
  const [workbenchPanel, setWorkbenchPanel] = useState("")
  const [ideZoom, setIdeZoom] = useState(() => clampIdeZoom(loadNumber("ai-memory.ide.zoom", 100)))
  const [explorerWidth, setExplorerWidth] = useState(() => Math.max(240, loadNumber("ai-memory.ide.explorerWidth", 264)))
  const [workbenchHeight, setWorkbenchHeight] = useState(() => Math.max(220, loadNumber("ai-memory.ide.workbenchHeight", 260)))
  const [revealLine, setRevealLine] = useState(null)
  const [analysis, setAnalysis] = useState(EMPTY_ANALYSIS)
  const quickInputRef = useRef(null)
  const commandInputRef = useRef(null)
  const active = workspace.activeTab
  const lines = useMemo(() => active ? Math.max(1, active.content.split("\n").length) : 0, [active?.content])
  const changeMap = useMemo(() => new Map((workspace.sessionChanges || []).map(item => [item.path, item])), [workspace.sessionChanges])
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return workspace.filePaths.filter(path => path.toLowerCase().includes(normalized)).slice(0, 120)
  }, [query, workspace.filePaths])
  const quickResults = useMemo(() => workspace.filePaths
    .map(path => ({ path, score: fuzzyScore(path, quickQuery) }))
    .filter(item => !quickQuery.trim() || item.score >= 0)
    .sort((a, b) => quickQuery.trim() ? b.score - a.score || a.path.localeCompare(b.path) : a.path.localeCompare(b.path))
    .slice(0, 12), [quickQuery, workspace.filePaths])
  const directoryPaths = useMemo(() => {
    const paths = []
    const visit = nodes => {
      for (const node of nodes || []) {
        if (node.type !== "directory") continue
        paths.push(node.path)
        visit(node.children)
      }
    }
    visit(workspace.tree)
    return paths
  }, [workspace.tree])

  const openPanel = panel => setWorkbenchPanel(current => current === panel ? current : panel)
  const closePanel = () => setWorkbenchPanel("")
  const changeIdeZoom = direction => {
    setIdeZoom(current => {
      const currentIndex = Math.max(0, IDE_ZOOM_STEPS.indexOf(current))
      const nextIndex = Math.max(0, Math.min(IDE_ZOOM_STEPS.length - 1, currentIndex + direction))
      return IDE_ZOOM_STEPS[nextIndex]
    })
  }
  const resetIdeZoom = () => setIdeZoom(100)

  const selectDirectoryNow = async () => {
    setLocalError("")
    try {
      await workspace.selectDirectory()
      setDialog(null)
    } catch (error) {
      if (error?.name === "AbortError") setDialog(null)
      else setLocalError(error.message || String(error))
    }
  }

  const chooseDirectory = () => {
    if (workspace.isReady && workspace.dirtyCount) {
      setDialog({
        type: "change-folder",
        title: "Trocar o projeto local?",
        description: `${workspace.dirtyCount} arquivo(s) têm alterações não salvas. Salve ou confirme a troca para abrir outra pasta.`,
        confirmLabel: "Selecionar outra pasta",
        tone: "danger"
      })
      return
    }
    selectDirectoryNow()
  }

  const requestCreateFile = () => setDialog({
    type: "new-file",
    title: "Criar novo arquivo",
    description: `Informe o caminho relativo dentro de ${workspace.rootName}.`,
    confirmLabel: "Criar arquivo",
    value: "",
    error: ""
  })

  const requestCloseTab = tab => {
    if (!tab?.dirty) {
      workspace.closeTab(tab.path)
      return
    }
    setDialog({
      type: "close-tab",
      title: `Descartar alterações em ${tab.name}?`,
      description: "O conteúdo ainda não salvo será descartado desta aba. Alterações já gravadas no projeto não serão removidas.",
      confirmLabel: "Descartar e fechar",
      tone: "danger",
      path: tab.path
    })
  }

  const confirmDialog = async () => {
    if (!dialog) return
    if (dialog.type === "new-file") {
      const path = String(dialog.value || "").trim()
      if (!path) {
        setDialog(current => ({ ...current, error: "Informe um caminho de arquivo válido." }))
        return
      }
      try {
        await workspace.createFile(path)
        setDialog(null)
      } catch (error) {
        setDialog(current => ({ ...current, error: error.message || String(error) }))
      }
      return
    }
    if (dialog.type === "close-tab") {
      workspace.closeTab(dialog.path)
      setDialog(null)
      return
    }
    if (dialog.type === "change-folder") await selectDirectoryNow()
  }

  const openQuick = () => {
    if (!workspace.isReady) return
    setCommandOpen(false)
    setQuickOpen(true)
    setQuickQuery("")
    setQuickIndex(0)
    window.requestAnimationFrame(() => quickInputRef.current?.focus())
  }

  const commandActions = useMemo(() => [
    { id: "quick-open", label: "Files: Quick Open", detail: "Abrir arquivo por nome ou caminho", shortcut: "Ctrl+P", run: openQuick },
    { id: "new-file", label: "File: New File", detail: "Criar arquivo no projeto atual", shortcut: "", run: requestCreateFile },
    { id: "save-all", label: "File: Save All", detail: `${workspace.dirtyCount} arquivo(s) pendente(s)`, shortcut: "Ctrl+S", run: () => workspace.saveAll().catch(error => setLocalError(error.message || String(error))) },
    { id: "refresh", label: "Workspace: Refresh", detail: "Reindexar árvore, Git e arquivos", shortcut: "", run: () => workspace.refresh().catch(error => setLocalError(error.message || String(error))) },
    { id: "change-folder", label: "Workspace: Change Folder", detail: "Selecionar outro projeto local", shortcut: "", run: chooseDirectory },
    { id: "changes", label: "View: Source Control / Changes", detail: `${workspace.sessionChanges?.length || 0} alteração(ões) da sessão`, shortcut: "Ctrl+Shift+G", run: () => openPanel("changes") },
    { id: "problems", label: "View: Problems", detail: `${analysis.diagnostics.length} diagnóstico(s) local(is)`, shortcut: "Ctrl+Shift+M", run: () => openPanel("problems") },
    { id: "outline", label: "View: Outline / AST", detail: `${analysis.symbols.length} símbolo(s) detectado(s)`, shortcut: "Ctrl+Shift+O", run: () => openPanel("outline") },
    { id: "terminal", label: "View: Workspace Terminal", detail: "Terminal seguro do workspace no navegador", shortcut: "Ctrl+`", run: () => openPanel("terminal") },
    { id: "zoom-in", label: "View: Increase IDE Zoom", detail: `Aumentar legibilidade da IDE · atual ${ideZoom}%`, shortcut: "Ctrl+Alt+=", run: () => changeIdeZoom(1) },
    { id: "zoom-out", label: "View: Decrease IDE Zoom", detail: `Reduzir escala visual da IDE · atual ${ideZoom}%`, shortcut: "Ctrl+Alt+-", run: () => changeIdeZoom(-1) },
    { id: "zoom-reset", label: "View: Reset IDE Zoom", detail: "Restaurar escala visual para 100%", shortcut: "Ctrl+Alt+0", run: resetIdeZoom }
  ], [analysis.diagnostics.length, analysis.symbols.length, ideZoom, workspace.dirtyCount, workspace.sessionChanges?.length, workspace.isReady, workspace.rootName])

  const commandResults = useMemo(() => commandActions
    .map(action => ({ action, score: fuzzyScore(`${action.label} ${action.detail}`, commandQuery) }))
    .filter(item => !commandQuery.trim() || item.score >= 0)
    .sort((a, b) => commandQuery.trim() ? b.score - a.score : a.action.label.localeCompare(b.action.label)), [commandActions, commandQuery])

  const openCommandPalette = () => {
    if (!workspace.isReady) return
    setQuickOpen(false)
    setCommandOpen(true)
    setCommandQuery("")
    setCommandIndex(0)
    window.requestAnimationFrame(() => commandInputRef.current?.focus())
  }

  useEffect(() => {
    setExpandedPaths(new Set())
    setQuery("")
    setQuickOpen(false)
    setCommandOpen(false)
    setCursor({ line: 1, column: 1 })
    setRevealLine(null)
    setWorkbenchPanel("")
  }, [workspace.workspaceSession])

  useEffect(() => {
    const valid = new Set(directoryPaths)
    setExpandedPaths(current => new Set([...current].filter(path => valid.has(path))))
  }, [directoryPaths])

  useEffect(() => {
    const handleGlobalKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && (event.key === "=" || event.key === "+")) {
        event.preventDefault()
        changeIdeZoom(1)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key === "-") {
        event.preventDefault()
        changeIdeZoom(-1)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key === "0") {
        event.preventDefault()
        resetIdeZoom()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault()
        openCommandPalette()
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault()
        openQuick()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "`") {
        event.preventDefault()
        openPanel("terminal")
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault()
        openPanel("changes")
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault()
        openPanel("outline")
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault()
        openPanel("problems")
        return
      }
      if (event.key === "Escape") {
        setQuickOpen(false)
        setCommandOpen(false)
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown)
    return () => window.removeEventListener("keydown", handleGlobalKeyDown)
  }, [workspace.isReady, workspace.workspaceSession, ideZoom])

  useEffect(() => {
    setCursor({ line: 1, column: 1 })
    setRevealLine(null)
    setAnalysis(EMPTY_ANALYSIS)
  }, [active?.path])

  useEffect(() => {
    if (!active) {
      setAnalysis(EMPTY_ANALYSIS)
      return undefined
    }
    const timer = window.setTimeout(() => setAnalysis(analyzeDocument({ content: active.content, language: active.language })), 90)
    return () => window.clearTimeout(timer)
  }, [active?.path, active?.content, active?.language])

  useEffect(() => {
    try { window.localStorage.setItem("ai-memory.ide.explorerWidth", String(explorerWidth)) } catch {}
  }, [explorerWidth])

  useEffect(() => {
    try { window.localStorage.setItem("ai-memory.ide.workbenchHeight", String(workbenchHeight)) } catch {}
  }, [workbenchHeight])

  useEffect(() => {
    try { window.localStorage.setItem("ai-memory.ide.zoom", String(ideZoom)) } catch {}
  }, [ideZoom])

  const toggleDirectory = path => {
    setExpandedPaths(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const expandAll = () => setExpandedPaths(new Set(directoryPaths))
  const collapseAll = () => setExpandedPaths(new Set())

  const openQuickResult = async path => {
    if (!path) return
    setLocalError("")
    try {
      await workspace.openFile(path)
      setQuickOpen(false)
      setQuickQuery("")
    } catch (error) {
      setLocalError(error.message || String(error))
    }
  }

  const handleQuickKeyDown = event => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setQuickIndex(current => Math.min(current + 1, Math.max(0, quickResults.length - 1)))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setQuickIndex(current => Math.max(0, current - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      openQuickResult(quickResults[quickIndex]?.path)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setQuickOpen(false)
    }
  }

  const handleCommandKeyDown = event => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setCommandIndex(current => Math.min(current + 1, Math.max(0, commandResults.length - 1)))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setCommandIndex(current => Math.max(0, current - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      const action = commandResults[commandIndex]?.action
      if (!action) return
      setCommandOpen(false)
      action.run()
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setCommandOpen(false)
    }
  }

  const startExplorerResize = event => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = explorerWidth
    const move = moveEvent => setExplorerWidth(Math.max(220, Math.min(420, startWidth + moveEvent.clientX - startX)))
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
  }

  const startWorkbenchResize = event => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = workbenchHeight
    const move = moveEvent => setWorkbenchHeight(Math.max(130, Math.min(460, startHeight + startY - moveEvent.clientY)))
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
  }

  const revealActiveLine = line => {
    if (!active) return
    setRevealLine({ path: active.path, line, nonce: Date.now() })
  }

  if (!workspace.supported) {
    return (
      <section className="code-workspace unsupported">
        <div className="ide-empty-state"><span className="ide-empty-mark">&lt;/&gt;</span><h2>IDE local indisponível neste navegador</h2><p>A edição direta do projeto exige File System Access API. Abra o AI Memory em Chrome ou Edge recente.</p><button className="primary-button" onClick={onClose}>Voltar ao painel</button></div>
      </section>
    )
  }

  return (
    <section className={`code-workspace layout-${layout}${workbenchPanel ? " has-workbench" : ""}`} style={{ "--ide-explorer-width": `${explorerWidth}px`, "--ide-workbench-height": `${workbenchHeight}px`, ...buildIdeMetrics(ideZoom) }}>
      <header className="ide-topbar">
        <div className="ide-title">
          <span className="ide-logo">&lt;/&gt;</span>
          <div><span className="eyebrow">Developer Workspace</span><strong>{workspace.isReady ? workspace.rootName : "Nenhum projeto local"}</strong></div>
          {workspace.isReady ? <span className="ide-write-status"><i />read/write</span> : null}
          {workspace.isReady && workspace.gitRepository ? <button className={`ide-git-branch${workspace.gitDetached ? " detached" : ""}`} onClick={() => openPanel("changes")} title={workspace.gitHead ? `HEAD ${workspace.gitHead}` : "Repositório Git detectado"}><i>⑂</i><strong>{workspace.gitBranch || workspace.gitHeadShort || "Git"}</strong>{workspace.gitHeadShort ? <small>{workspace.gitHeadShort}</small> : null}</button> : null}
        </div>
        <div className="ide-toolbar-actions">
          {workspace.isReady ? <button onClick={openQuick} title="Quick Open · Ctrl/Cmd+P">⌕ Arquivos</button> : null}
          {workspace.isReady ? <button onClick={openCommandPalette} title="Command Palette · Ctrl/Cmd+Shift+P">⌘ Comandos</button> : null}
          <button onClick={chooseDirectory}>{workspace.isReady ? "Trocar pasta" : "Selecionar pasta"}</button>
          {workspace.isReady ? <button onClick={() => workspace.refresh().catch(error => setLocalError(error.message || String(error)))} disabled={workspace.scanning}>{workspace.scanning ? "Atualizando…" : "↻"}</button> : null}
          {workspace.dirtyCount ? <button className="accent" onClick={() => workspace.saveAll().catch(error => setLocalError(error.message || String(error)))}>Salvar · {workspace.dirtyCount}</button> : null}
          <div className="ide-zoom-control" aria-label="Escala visual da IDE">
            <button onClick={() => changeIdeZoom(-1)} disabled={ideZoom === IDE_ZOOM_STEPS[0]} title="Diminuir escala da IDE · Ctrl/Cmd+Alt+-">−</button>
            <button className="ide-zoom-value" onClick={resetIdeZoom} title="Restaurar 100% · Ctrl/Cmd+Alt+0">{ideZoom}%</button>
            <button onClick={() => changeIdeZoom(1)} disabled={ideZoom === IDE_ZOOM_STEPS[IDE_ZOOM_STEPS.length - 1]} title="Aumentar escala da IDE · Ctrl/Cmd+Alt+=">+</button>
          </div>
          <div className="ide-layout-switch" aria-label="Largura da IDE">
            <button className={layout === "compact" ? "active" : ""} onClick={() => onLayoutChange("compact")} title="Priorizar chat">▯</button>
            <button className={layout === "split" ? "active" : ""} onClick={() => onLayoutChange("split")} title="IDE e chat equilibrados">◫</button>
            <button className={layout === "wide" ? "active" : ""} onClick={() => onLayoutChange("wide")} title="Priorizar IDE">▰</button>
          </div>
          <button className="ide-console-button" onClick={onClose}>Painel</button>
        </div>
      </header>

      {localError || workspace.error ? <div className="ide-error">{localError || workspace.error}</div> : null}

      {!workspace.isReady ? (
        <div className="ide-empty-state">
          <span className="ide-empty-mark">&lt;/&gt;</span>
          <span className="eyebrow">Local workspace</span>
          <h2>Código, memória e agente.<br /><em>No mesmo fluxo.</em></h2>
          <p>Selecione a raiz do projeto para editar arquivos localmente. A árvore inicia recolhida, o Git é detectado sem expor .git e o chat permanece lado a lado com a IDE.</p>
          <button className="primary-button" onClick={chooseDirectory}>Selecionar projeto local</button>
          <small>.git, dependências, binários, chaves e arquivos .env permanecem fora do contexto enviado ao agente.</small>
        </div>
      ) : (
        <div className="ide-body">
          <aside className="ide-explorer">
            <div className="ide-explorer-head"><div><span>Explorer</span><strong>{workspace.rootName}</strong>{workspace.gitRepository ? <button onClick={() => openPanel("changes")}><i>⑂</i>{workspace.gitBranch || workspace.gitHeadShort || "Git"}</button> : null}</div><button onClick={requestCreateFile} title="Novo arquivo">+</button></div>
            <div className="ide-search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filtrar arquivos…" /></div>
            <div className="ide-tree-controls">
              <button onClick={collapseAll} disabled={!expandedPaths.size}><span>−</span>Recolher</button>
              <button onClick={expandAll} disabled={!directoryPaths.length || expandedPaths.size === directoryPaths.length}><span>+</span>Expandir</button>
            </div>
            <div className="ide-tree">
              {query ? searchResults.map(path => {
                const badge = fileBadge(path)
                const change = changeMap.get(path)
                return <button key={path} className={`ide-search-result${workspace.activePath === path ? " active" : ""}`} onClick={() => workspace.openFile(path).catch(error => setLocalError(error.message || String(error)))}><span className={`ide-file-icon tone-${badge.tone}`}>{badge.label}</span><div><strong>{path.split("/").pop()}</strong><span>{path}</span></div>{change ? <em className={`ide-tree-change change-${changeLetter(change).toLowerCase()}`}>{changeLetter(change)}</em> : null}</button>
              }) : workspace.tree.map(node => <TreeNode key={node.path} node={node} depth={0} workspace={workspace} expandedPaths={expandedPaths} onToggleDirectory={toggleDirectory} onError={setLocalError} changeMap={changeMap} />)}
              {query && !searchResults.length ? <div className="ide-no-results">Nenhum arquivo encontrado.</div> : null}
            </div>
            <div className="ide-explorer-foot"><span>{workspace.filePaths.length} arquivos · {workspace.contextPaths.length} contexto · {workspace.sessionChanges?.length || 0} changes</span><span>Ctrl+P arquivo · Ctrl+Shift+P comandos</span></div>
          </aside>

          <div className="ide-explorer-resizer" onPointerDown={startExplorerResize} />

          <div className={`ide-editor-column${workbenchPanel ? " panel-open" : ""}`}>
            <div className="ide-tabs">
              {workspace.tabs.map(tab => {
                const badge = fileBadge(tab.path)
                const change = changeMap.get(tab.path)
                return <button key={tab.path} className={workspace.activePath === tab.path ? "active" : ""} onClick={() => workspace.setActivePath(tab.path)} title={tab.path}><span className={`ide-tab-file-icon tone-${badge.tone}`}>{badge.label}</span><span>{tab.name}</span>{change ? <em className={`ide-tab-change change-${changeLetter(change).toLowerCase()}`}>{changeLetter(change)}</em> : null}{tab.dirty ? <i /> : null}<b onClick={event => { event.stopPropagation(); requestCloseTab(tab) }}>×</b></button>
              })}
              {!workspace.tabs.length ? <span className="ide-tabs-empty">Abra um arquivo no Explorer ou use Ctrl/Cmd+P</span> : null}
            </div>
            {active ? (
              <>
                <div className="ide-editor-toolbar">
                  <div className="ide-breadcrumbs">{active.path.split("/").map((part, index, values) => <React.Fragment key={`${part}:${index}`}><span>{part}</span>{index < values.length - 1 ? <i>›</i> : null}</React.Fragment>)}</div>
                  <div className="ide-editor-actions">
                    <button className={workbenchPanel === "problems" ? "active" : ""} onClick={() => openPanel("problems")} title="Problems">{analysis.errorCount ? `× ${analysis.errorCount}` : "✓"}</button>
                    <button className={workbenchPanel === "outline" ? "active" : ""} onClick={() => openPanel("outline")} title="Outline / AST">AST {analysis.symbols.length}</button>
                    <button className={workbenchPanel === "changes" ? "active" : ""} onClick={() => openPanel("changes")} title="Source Control / Diff">⑂ {workspace.sessionChanges?.length || 0}</button>
                    <button className={workbenchPanel === "terminal" ? "active" : ""} onClick={() => openPanel("terminal")} title="Workspace Terminal">›_</button>
                    <button className={workspace.contextPaths.includes(active.path) ? "active" : ""} onClick={() => workspace.toggleContext(active.path)}>{workspace.contextPaths.includes(active.path) ? "● Contexto" : "○ Fixar"}</button>
                    <button onClick={() => workspace.saveFile(active.path).catch(error => setLocalError(error.message || String(error)))} disabled={!active.dirty}>Salvar</button>
                  </div>
                </div>
                <SyntaxEditor key={active.path} value={active.content} language={active.language} path={active.path} onChange={content => workspace.updateContent(active.path, content)} onSave={() => workspace.saveFile(active.path).catch(error => setLocalError(error.message || String(error)))} onCursorChange={setCursor} revealLine={revealLine} fontSize={14 * ideZoom / 100} />
                {workbenchPanel ? <IdeWorkbenchPanel activePanel={workbenchPanel} onPanelChange={setWorkbenchPanel} onClose={closePanel} workspace={workspace} analysis={analysis} onRevealLine={revealActiveLine} onResizeStart={startWorkbenchResize} /> : null}
                <footer className="ide-statusbar">
                  <button className="status-git" onClick={() => openPanel("changes")} title={workspace.gitHead ? `HEAD ${workspace.gitHead}` : "Git"}>{workspace.gitRepository ? `⑂ ${workspace.gitBranch || workspace.gitHeadShort || "Git"}` : "sem Git"}</button>
                  <span className={active.dirty ? "status-dirty" : "status-saved"}>{active.dirty ? "● Modificado" : "✓ Salvo"}</span>
                  <button onClick={() => openPanel("problems")} className={analysis.errorCount ? "status-problem" : ""}>{analysis.errorCount ? `× ${analysis.errorCount}` : "✓ 0"}</button>
                  <span>Ln {cursor.line}, Col {cursor.column}</span><span>{active.language}</span><span>{lines} linhas</span><strong>Ctrl+Space sugestões</strong>
                </footer>
              </>
            ) : (
              <div className="ide-editor-empty"><span>&lt;/&gt;</span><strong>Escolha um arquivo para começar</strong><p>Quick Open, Command Palette, Source Control, Outline e Terminal ficam disponíveis sem sair do fluxo com o agente.</p></div>
            )}
          </div>
        </div>
      )}

      {quickOpen ? (
        <div className="ide-quick-open-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setQuickOpen(false) }}>
          <div className="ide-quick-open" role="dialog" aria-modal="true" aria-label="Quick Open">
            <div className="ide-quick-open-input"><span>⌕</span><input ref={quickInputRef} value={quickQuery} onChange={event => { setQuickQuery(event.target.value); setQuickIndex(0) }} onKeyDown={handleQuickKeyDown} placeholder="Digite o nome ou caminho do arquivo…" /></div>
            <div className="ide-quick-open-results">
              {quickResults.map((item, index) => {
                const badge = fileBadge(item.path)
                return <button key={item.path} className={index === quickIndex ? "active" : ""} onMouseEnter={() => setQuickIndex(index)} onClick={() => openQuickResult(item.path)}><span className={`ide-file-icon tone-${badge.tone}`}>{badge.label}</span><div><strong>{item.path.split("/").pop()}</strong><small>{item.path}</small></div><kbd>Enter</kbd></button>
              })}
              {!quickResults.length ? <div className="ide-quick-empty">Nenhum arquivo correspondente.</div> : null}
            </div>
            <footer><span>↑↓ navega</span><span>Enter abre</span><span>Esc fecha</span><strong>{workspace.filePaths.length} arquivos indexados</strong></footer>
          </div>
        </div>
      ) : null}

      {commandOpen ? (
        <div className="ide-quick-open-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setCommandOpen(false) }}>
          <div className="ide-command-palette" role="dialog" aria-modal="true" aria-label="Command Palette">
            <div className="ide-quick-open-input"><span>&gt;</span><input ref={commandInputRef} value={commandQuery} onChange={event => { setCommandQuery(event.target.value); setCommandIndex(0) }} onKeyDown={handleCommandKeyDown} placeholder="Executar comando da IDE…" /></div>
            <div className="ide-command-results">
              {commandResults.map((item, index) => <button key={item.action.id} className={index === commandIndex ? "active" : ""} onMouseEnter={() => setCommandIndex(index)} onClick={() => { setCommandOpen(false); item.action.run() }}><span>◇</span><div><strong>{item.action.label}</strong><small>{item.action.detail}</small></div>{item.action.shortcut ? <kbd>{item.action.shortcut}</kbd> : null}</button>)}
            </div>
            <footer><span>Command Palette</span><strong>Ctrl/Cmd+Shift+P</strong></footer>
          </div>
        </div>
      ) : null}

      <IdeDialog open={Boolean(dialog)} title={dialog?.title || ""} description={dialog?.description || ""} confirmLabel={dialog?.confirmLabel} tone={dialog?.tone} value={dialog?.value || ""} placeholder={dialog?.type === "new-file" ? "src/components/NovoArquivo.jsx" : ""} onValueChange={dialog?.type === "new-file" ? value => setDialog(current => ({ ...current, value, error: "" })) : null} onConfirm={confirmDialog} onCancel={() => setDialog(null)} error={dialog?.error || ""} />
    </section>
  )
}
