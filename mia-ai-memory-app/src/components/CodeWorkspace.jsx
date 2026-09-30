import React, { useEffect, useMemo, useRef, useState } from "react"
import SyntaxEditor from "./SyntaxEditor.jsx"
import IdeDialog from "./IdeDialog.jsx"
import IdeWorkbenchPanel from "./IdeWorkbenchPanel.jsx"
import ProjectSwitcher from "./ProjectSwitcher.jsx"
import PortableProjectImportDialog from "./PortableProjectImportDialog.jsx"
import ResizeHandle from "./layout/ResizeHandle.jsx"
import ProjectSearch from "./ide/ProjectSearch.jsx"
import IdeViewOptions from "./ide/IdeViewOptions.jsx"
import IdeActivityBar from "./ide/IdeActivityBar.jsx"
import useStoredPreference from "../hooks/useStoredPreference.js"
import useDialogFocus from "../hooks/useDialogFocus.js"
import useElementSize from "../hooks/useElementSize.js"
import { analyzeDocument } from "../lib/ideLanguageService.js"
import { buildNavigationRequest, resolveNavigation } from "../lib/ideNavigation.js"
import { canFormatLanguage, formatDocument } from "../lib/ideFormatter.js"
import { confirmAction, promptValue } from "../lib/dialogService.js"
import { isEditableShortcutTarget, resolveIdeShortcut, resolveIdeZoomShortcut } from "../lib/ideKeyboardShortcuts.js"

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

const IDE_ZOOM_STEPS = [90, 100, 110, 120, 130, 140]
const IDE_DEFAULT_ZOOM = 120
const IDE_ZOOM_VERSION = "2"

const clampIdeZoom = value => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return IDE_DEFAULT_ZOOM
  return IDE_ZOOM_STEPS.reduce((best, step) => Math.abs(step - numeric) < Math.abs(best - numeric) ? step : best, IDE_DEFAULT_ZOOM)
}

const loadIdeZoom = () => {
  if (typeof window === "undefined") return IDE_DEFAULT_ZOOM
  try {
    if (window.localStorage.getItem("ai-memory.ide.zoom.version") !== IDE_ZOOM_VERSION) return IDE_DEFAULT_ZOOM
    return clampIdeZoom(loadNumber("ai-memory.ide.zoom", IDE_DEFAULT_ZOOM))
  } catch {
    return IDE_DEFAULT_ZOOM
  }
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

export default function CodeWorkspace({ workspace, layout = "split", onLayoutChange, onClose, visible = true, maximized = false, onToggleMaximize }) {
  const [query, setQuery] = useState("")
  const [localError, setLocalError] = useState("")
  const [expandedPaths, setExpandedPaths] = useState(() => new Set())
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickQuery, setQuickQuery] = useState("")
  const [quickIndex, setQuickIndex] = useState(0)
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState("")
  const [commandIndex, setCommandIndex] = useState(0)
  const [cursor, setCursor] = useState({ line: 1, column: 1, offset: 0 })
  const [dialog, setDialog] = useState(null)
  const [workbenchPanel, setWorkbenchPanel] = useState("")
  const [portableImportOpen, setPortableImportOpen] = useState(false)
  const [portableImportBusy, setPortableImportBusy] = useState(false)
  const [portableImportError, setPortableImportError] = useState("")
  const [ideZoom, setIdeZoom] = useState(loadIdeZoom)
  const [preferredExplorerWidth, setExplorerWidth] = useStoredPreference("ai-memory.ide.explorerWidth", 264)
  const [preferredWorkbenchHeight, setWorkbenchHeight] = useStoredPreference("ai-memory.ide.workbenchHeight", 260)
  const [explorerHidden, setExplorerHidden] = useStoredPreference("ai-memory.ide.explorerHidden", false)
  const [sidebarMode, setSidebarMode] = useState("files")
  const [editorRequest, setEditorRequest] = useState(null)
  const [navigationPicker, setNavigationPicker] = useState(null)
  const [navigationBusy, setNavigationBusy] = useState("")
  const rootRef = useRef(null)
  const bodyRef = useRef(null)
  const editorColumnRef = useRef(null)
  const recentFilesRef = useRef(new Map())
  const closedFilesRef = useRef(new Map())
  const navigationAbortRef = useRef(null)
  const navigationHistoryRef = useRef({ back: [], forward: [] })
  const bodySize = useElementSize(bodyRef, workspace.isReady && visible)
  const editorSize = useElementSize(editorColumnRef, workspace.isReady && visible)
  const narrowExplorer = bodySize.width > 0 && bodySize.width < 580
  const explorerVisible = !explorerHidden
  const explorerMax = Math.max(160, Math.min(440, bodySize.width - 290))
  const explorerWidth = Math.max(160, Math.min(explorerMax, preferredExplorerWidth))
  const workbenchMax = Math.max(110, Math.min(520, editorSize.height - 220))
  const workbenchHeight = Math.max(110, Math.min(workbenchMax, preferredWorkbenchHeight))
  const [revealLine, setRevealLine] = useState(null)
  const [analysis, setAnalysis] = useState(EMPTY_ANALYSIS)
  const quickInputRef = useRef(null)
  const commandInputRef = useRef(null)
  const quickDialogRef = useRef(null)
  const commandDialogRef = useRef(null)
  const navigationDialogRef = useRef(null)
  useDialogFocus(quickDialogRef, quickOpen && visible)
  useDialogFocus(commandDialogRef, commandOpen && visible)
  useDialogFocus(navigationDialogRef, Boolean(navigationPicker) && visible)
  const active = workspace.activeTab
  const lines = useMemo(() => active ? Math.max(1, active.content.split("\n").length) : 0, [active?.content])
  const changeMap = useMemo(() => new Map((workspace.sessionChanges || []).map(item => [item.path, item])), [workspace.sessionChanges])
  const changeCount = workspace.terminalRuntimeAvailable ? workspace.gitWorkingChanges?.length || 0 : workspace.sessionChanges?.length || 0
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return workspace.filePaths.filter(path => path.toLowerCase().includes(normalized)).slice(0, 120)
  }, [query, workspace.filePaths])
  const quickLocation = quickQuery.match(/^(.*?):(\d+)(?::(\d+))?$/)
  const quickFilter = quickLocation ? quickLocation[1] : quickQuery
  const recentFiles = recentFilesRef.current.get(workspace.activeProjectId) || []
  const quickResults = useMemo(() => workspace.filePaths
    .map(path => ({ path, score: fuzzyScore(path, quickFilter) }))
    .filter(item => !quickFilter.trim() || item.score >= 0)
    .sort((a, b) => quickFilter.trim() ? b.score - a.score || a.path.localeCompare(b.path) : (recentFiles.includes(a.path) ? recentFiles.indexOf(a.path) : 1000) - (recentFiles.includes(b.path) ? recentFiles.indexOf(b.path) : 1000) || a.path.localeCompare(b.path))
    .slice(0, 12), [quickFilter, workspace.filePaths, workspace.activePath, quickOpen])
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
  const togglePanel = () => setWorkbenchPanel(current => current ? "" : "terminal")
  const toggleActivityPanel = panel => setWorkbenchPanel(current => current === panel ? "" : panel)
  const activateSidebar = mode => {
    if (!explorerHidden && sidebarMode === mode) {
      setExplorerHidden(true)
      return
    }
    setSidebarMode(mode)
    setExplorerHidden(false)
  }
  const openSearch = () => { setExplorerHidden(false); setSidebarMode("search") }
  const requestFind = (replace = false) => { if (active) setEditorRequest({ replace, nonce: Date.now() }) }
  const requestGoToLine = () => { if (active) setDialog({ type: "go-line", title: "Ir para linha", description: `Informe linha ou linha:coluna (1–${lines}).`, confirmLabel: "Ir", value: String(cursor.line) }) }
  const resetView = () => { setExplorerWidth(264); setWorkbenchHeight(260); setExplorerHidden(false); setIdeZoom(IDE_DEFAULT_ZOOM); onLayoutChange("split") }
  const revealInExplorer = () => {
    if (!active) return
    setExplorerHidden(false)
    setSidebarMode("files")
    setQuery("")
    const parts = active.path.split("/")
    setExpandedPaths(current => new Set([...current, ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))]))
    window.requestAnimationFrame(() => rootRef.current?.querySelector(".ide-tree-file-wrap.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }))
  }
  const openSearchResult = async result => {
    const session = workspace.workspaceSession
    try {
      await workspace.openFile(result.path)
      setRevealLine({ ...result, nonce: Date.now(), session })
    } catch (error) { setLocalError(error.message || String(error)) }
  }
  const currentNavigationLocation = () => active ? { path: active.path, line: cursor.line || 1, column: cursor.column || 1, length: 0 } : null
  const navigateToLocation = async (location, recordHistory = true) => {
    if (!location?.path) return
    const current = currentNavigationLocation()
    if (recordHistory && current && (current.path !== location.path || current.line !== location.line || current.column !== location.column)) {
      const history = navigationHistoryRef.current
      history.back = [...history.back, current].slice(-80)
      history.forward = []
    }
    setLocalError("")
    setNavigationPicker(null)
    try {
      await workspace.openFile(location.path)
      setRevealLine({ path: location.path, line: location.line || 1, column: location.column || 1, length: location.length || 0, nonce: Date.now() })
    } catch (error) {
      setLocalError(error.message || String(error))
    }
  }
  const navigateHistory = async direction => {
    const history = navigationHistoryRef.current
    const source = direction === "back" ? history.back : history.forward
    if (!source.length) return
    const target = source[source.length - 1]
    const current = currentNavigationLocation()
    if (direction === "back") {
      history.back = source.slice(0, -1)
      if (current) history.forward = [...history.forward, current].slice(-80)
    } else {
      history.forward = source.slice(0, -1)
      if (current) history.back = [...history.back, current].slice(-80)
    }
    await navigateToLocation(target, false)
  }
  const runSymbolNavigation = async ({ offset = cursor.offset || 0, mode = "smart" } = {}) => {
    if (!active) return
    const request = buildNavigationRequest({ content: active.content, language: active.language, offset })
    if (!request) {
      setLocalError("NAVIGATION_SYMBOL_NOT_FOUND: posicione o cursor sobre um símbolo navegável.")
      return
    }
    navigationAbortRef.current?.abort()
    const controller = new AbortController()
    navigationAbortRef.current = controller
    setNavigationPicker(null)
    setNavigationBusy(request.symbol)
    setLocalError("")
    try {
      const results = await resolveNavigation({
        request: { ...request, currentPath: active.path },
        paths: workspace.filePaths,
        drafts: new Map(workspace.tabs.map(tab => [tab.path, tab.content])),
        readPath: workspace.readPath,
        mode,
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      if (!results.length) {
        setLocalError(`NAVIGATION_SYMBOL_NOT_FOUND: nenhuma definição ou implementação encontrada para ${request.symbol}.`)
        return
      }
      if (results.length === 1) {
        await navigateToLocation(results[0])
        return
      }
      setNavigationPicker({ symbol: request.symbol, mode, results })
    } catch (error) {
      if (error?.name !== "AbortError") setLocalError(error.message || String(error))
    } finally {
      if (navigationAbortRef.current === controller) {
        navigationAbortRef.current = null
        setNavigationBusy("")
      }
    }
  }
  const formatActiveDocument = () => {
    if (!active) return
    if (!canFormatLanguage(active.language)) {
      setLocalError(`FORMATTER_UNSUPPORTED: formatação estruturada ainda não está disponível para ${active.language}.`)
      return
    }
    const result = formatDocument({ content: active.content, language: active.language })
    setLocalError("")
    if (!result.changed) return
    workspace.updateContent(active.path, result.content)
    setRevealLine({ path: active.path, line: cursor.line || 1, column: cursor.column || 1, nonce: Date.now() })
  }
  const switchTab = direction => {
    if (!workspace.tabs.length) return
    const index = workspace.tabs.findIndex(tab => tab.path === workspace.activePath)
    const next = workspace.tabs[(index + direction + workspace.tabs.length) % workspace.tabs.length]
    if (next) workspace.setActivePath(next.path)
  }
  const rememberClosedEditor = tab => {
    if (!tab?.path || !workspace.activeProjectId) return
    const previous = closedFilesRef.current.get(workspace.activeProjectId) || []
    closedFilesRef.current.set(workspace.activeProjectId, [tab.path, ...previous.filter(path => path !== tab.path)].slice(0, 30))
  }
  const closeEditor = tab => {
    if (!tab) return
    rememberClosedEditor(tab)
    workspace.closeTab(tab.path)
  }
  const reopenClosedEditor = async () => {
    const projectId = workspace.activeProjectId
    const previous = [...(closedFilesRef.current.get(projectId) || [])]
    while (previous.length) {
      const path = previous.shift()
      closedFilesRef.current.set(projectId, previous)
      if (workspace.tabs.some(tab => tab.path === path)) continue
      try {
        await workspace.openFile(path)
        return
      } catch {
      }
    }
  }
  const changeIdeZoom = direction => {
    setIdeZoom(current => {
      const currentIndex = Math.max(0, IDE_ZOOM_STEPS.indexOf(current))
      const nextIndex = Math.max(0, Math.min(IDE_ZOOM_STEPS.length - 1, currentIndex + direction))
      return IDE_ZOOM_STEPS[nextIndex]
    })
  }
  const resetIdeZoom = () => setIdeZoom(IDE_DEFAULT_ZOOM)

  const selectDirectoryNow = async () => {
    setLocalError("")
    setDialog(null)
    try {
      await workspace.selectDirectory()
    } catch (error) {
      if (error?.name !== "AbortError") setLocalError(error.message || String(error))
    }
  }

  const selectRuntimeDirectoryNow = async () => {
    setLocalError("")
    setDialog(null)
    try {
      await workspace.selectRuntimeDirectory()
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "PICKER_CANCELLED" || error?.status === 499) return
      if (error?.code === "PICKER_UNAVAILABLE" || error?.status === 501) {
        const absolutePath = await promptValue({
          tone: "secure",
          title: "Conectar pasta física ao Workspace Runtime",
          description: "O seletor nativo do sistema não está disponível neste desktop. Informe o caminho absoluto do projeto para conectar leitura, escrita física e terminal real.",
          detail: "Exemplo: /home/felipe/projetos/mia-next-api",
          inputLabel: "Caminho absoluto",
          placeholder: "/home/usuario/projetos/meu-projeto",
          confirmLabel: "Conectar projeto"
        })
        if (!absolutePath) return
        try {
          await workspace.registerRuntimePath(absolutePath)
          return
        } catch (registerError) {
          setLocalError(registerError.message || String(registerError))
          return
        }
      }
      setLocalError(error.message || String(error))
    }
  }

  const importPortableSource = async source => {
    if (portableImportBusy) return
    setPortableImportBusy(true)
    setPortableImportError("")
    setLocalError("")
    try {
      await workspace.importPortableProject(source)
      setPortableImportOpen(false)
    } catch (error) {
      if (error?.name !== "AbortError") setPortableImportError(error.message || String(error))
    } finally {
      setPortableImportBusy(false)
    }
  }

  const pickPortableFolder = async () => {
    setPortableImportError("")
    if (typeof window.showDirectoryPicker !== "function") {
      setPortableImportError("Este navegador não expõe um seletor de diretórios compatível com a IDE. Arraste a pasta para esta janela ou importe um ZIP do projeto.")
      return
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read", id: "ai-memory-portable-import" })
      await importPortableSource({ kind: "handle", handle })
    } catch (error) {
      if (error?.name !== "AbortError") setPortableImportError(error.message || String(error))
    }
  }

  const chooseDirectory = async () => {
    if (workspace.runtimeAvailable) {
      const confirmed = await confirmAction({
        tone: "secure",
        title: workspace.projects?.length ? "Conectar outro projeto físico?" : "Conectar projeto físico à IDE?",
        description: workspace.isReady
          ? `O projeto ${workspace.rootName} continuará disponível. O novo projeto será aberto pelo Workspace Runtime e qualquer alteração aplicada pelo agente será gravada no filesystem real da máquina.`
          : "O Workspace Runtime conecta a IDE ao filesystem real da máquina. Isso habilita escrita física, Git real e execução de comandos como npm, go, java, docker e scripts diretamente no projeto.",
        detail: "O runtime escuta apenas em localhost. O terminal inicia na raiz do projeto e executa comandos com as permissões do usuário local; revise comandos destrutivos antes de executá-los.",
        confirmLabel: "Selecionar projeto físico"
      })
      if (!confirmed) return
      await selectRuntimeDirectoryNow()
      return
    }
    const direct = workspace.directAccessSupported
    if (!direct) {
      setPortableImportError("")
      setPortableImportOpen(true)
      return
    }
    const confirmed = await confirmAction({
      tone: "secure",
      title: workspace.projects?.length ? "Adicionar outro projeto à IDE?" : "Adicionar projeto local à IDE?",
      description: workspace.isReady
        ? `O projeto ${workspace.rootName} continuará disponível. Depois de autorizar outra pasta, você poderá alternar entre os projetos pelo seletor da IDE sem perder abas ou alterações não salvas da sessão.`
        : "O Workspace Runtime local não está acessível. A IDE pode continuar pelo acesso seguro do navegador, com leitura e escrita direta na pasta selecionada.",
      detail: "Chrome e Edge controlam a autorização final da pasta com uma caixa nativa de segurança que não pode ser estilizada pela aplicação. Inicie o Workspace Runtime para usar HOST RW, Git e terminal reais sem depender desse fluxo de autorização direta.",
      confirmLabel: "Selecionar pasta do projeto"
    })
    if (!confirmed) return
    await selectDirectoryNow()
  }

  const connectCurrentProjectToHost = async () => {
    if (!["portable", "direct"].includes(workspace.workspaceMode) || !workspace.runtimeAvailable) return
    const portable = workspace.workspaceMode === "portable"
    const confirmed = await confirmAction({
      tone: "secure",
      title: portable ? `Conectar ${workspace.rootName} à pasta física?` : `Habilitar terminal HOST RW em ${workspace.rootName}?`,
      description: portable
        ? "O AI Memory vai selecionar a pasta física correspondente, verificar conflitos e migrar o projeto de Browser Workspace para HOST RW. Alterações rastreadas na sessão serão sincronizadas no disco antes da troca."
        : "O projeto já grava diretamente na pasta física pelo navegador. O AI Memory vai conectar a mesma pasta ao Workspace Runtime para habilitar Git real, terminal, builds e execução de aplicações sem duplicar o projeto.",
      detail: portable
        ? "Depois da migração, Git do sistema operacional, terminal real, builds e Auto Apply trabalharão no filesystem físico. Se a pasta tiver divergências, a operação será bloqueada sem sobrescrever arquivos."
        : "A IDE valida o nome do projeto e o HEAD Git antes de trocar o adapter. Abas, arquivos não salvos e o projectId atual são preservados.",
      confirmLabel: portable ? "Conectar ao host" : "Habilitar HOST RW"
    })
    if (!confirmed) return
    setLocalError("")
    const connect = pathValue => portable ? workspace.connectPortableProjectToRuntime(pathValue) : workspace.connectDirectProjectToRuntime(pathValue)
    try {
      await connect()
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "PICKER_CANCELLED" || error?.status === 499) return
      if (error?.code === "PICKER_UNAVAILABLE" || error?.status === 501) {
        const absolutePath = await promptValue({
          tone: "secure",
          title: "Localizar pasta física do projeto",
          description: `Informe o caminho absoluto da pasta física correspondente a ${workspace.rootName}.`,
          detail: "A pasta é validada pelo Workspace Runtime antes de qualquer escrita ou execução de comando.",
          inputLabel: "Caminho absoluto",
          placeholder: "/home/usuario/projetos/meu-projeto",
          confirmLabel: portable ? "Conectar ao host" : "Habilitar HOST RW"
        })
        if (!absolutePath) return
        try {
          await connect(absolutePath)
          return
        } catch (registerError) {
          setLocalError(registerError.message || String(registerError))
          return
        }
      }
      setLocalError(error.message || String(error))
    }
  }

  const refreshProject = async () => {
    if (!workspace.isReady) return false
    setLocalError("")
    try {
      await workspace.refresh()
      return true
    } catch (error) {
      setLocalError(error.message || String(error))
      return false
    }
  }

  const changeProject = async projectId => {
    if (!projectId || projectId === workspace.activeProjectId) return true
    const target = workspace.projects?.find(project => project.id === projectId)
    if (target?.permission !== "granted") {
      const runtimeProject = target.mode === "runtime"
      const confirmed = await confirmAction({
        tone: "secure",
        title: `Reconectar ${target.name}?`,
        description: runtimeProject
          ? "O projeto físico está registrado, mas o Workspace Runtime local não está acessível. Inicie o runtime e reconecte para recuperar escrita no disco, Git real e terminal real."
          : "O projeto já está registrado na IDE, mas o navegador precisa renovar a autorização de leitura e escrita antes de reabri-lo.",
        detail: runtimeProject
          ? "Execute o backend local com script/run-local.sh ou inicie script/workspace-runtime.sh start."
          : "Depois desta confirmação, Chrome ou Edge poderá exibir a permissão nativa de segurança da pasta.",
        confirmLabel: "Reconectar projeto"
      })
      if (!confirmed) return false
    }
    setLocalError("")
    try {
      await workspace.switchProject(projectId)
      return true
    } catch (error) {
      if (error?.name !== "AbortError") setLocalError(error.message || String(error))
      return false
    }
  }

  const forgetProject = async project => {
    const target = project || workspace.activeProject
    if (!target?.id) return false
    const dirtyCount = Number(target.dirtyCount || (target.id === workspace.activeProjectId ? workspace.dirtyCount : 0))
    const portable = target.mode === "portable"
    const confirmed = await confirmAction({
      tone: dirtyCount ? "danger" : "default",
      title: `Remover ${target.name} da IDE?`,
      description: dirtyCount
        ? portable
          ? `${dirtyCount} arquivo(s) têm alterações não salvas no editor. Remover o projeto descartará o estado da IDE e apagará somente a cópia privada deste navegador; a pasta original da máquina não será alterada.`
          : `${dirtyCount} arquivo(s) têm alterações não salvas no editor. Remover o projeto descartará somente esse estado não salvo; nenhum arquivo da pasta local será apagado.`
        : portable
          ? "O projeto será removido da IDE e a cópia privada armazenada neste navegador será apagada. A pasta original selecionada na máquina permanece intacta."
          : "O projeto será removido da lista da IDE, mas nenhum arquivo da pasta local será apagado. Você poderá adicioná-lo novamente quando quiser.",
      detail: portable ? "Esta ação afeta somente o workspace privado do AI Memory neste navegador." : "Esta ação remove apenas o vínculo local armazenado pelo AI Memory neste navegador.",
      confirmLabel: "Remover da IDE"
    })
    if (!confirmed) return false
    setLocalError("")
    try {
      await workspace.removeProject(target.id)
      return true
    } catch (error) {
      setLocalError(error.message || String(error))
      return false
    }
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
      closeEditor(tab)
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
    if (dialog.type === "go-line") {
      const match = String(dialog.value || "").trim().match(/^(\d+)(?::(\d+))?$/)
      if (!match || Number(match[1]) < 1 || Number(match[1]) > lines || (match[2] && Number(match[2]) < 1)) {
        setDialog(current => ({ ...current, error: `Use uma linha entre 1 e ${lines}, opcionalmente seguida de :coluna.` }))
        return
      }
      setRevealLine({ path: active.path, line: Number(match[1]), column: Number(match[2] || 1), nonce: Date.now() })
      setDialog(null)
      return
    }
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
      closeEditor(workspace.tabs.find(tab => tab.path === dialog.path))
      setDialog(null)
      return
    }
  }

  const openQuick = () => {
    if (!workspace.isReady) return
    setCommandOpen(false)
    setQuickOpen(true)
    setQuickQuery("")
    setQuickIndex(0)
    window.requestAnimationFrame(() => quickInputRef.current?.focus())
  }

  const commandActions = [
    { id: "quick-open", label: "Files: Quick Open", detail: "Abrir arquivo por nome ou caminho", shortcut: "Ctrl+E / Ctrl+P", run: openQuick },
    { id: "new-file", label: "File: New File", detail: "Criar arquivo no projeto atual", shortcut: "Ctrl+N", run: requestCreateFile },
    { id: "close-editor", label: "File: Close Editor", detail: active?.name || "Nenhum editor ativo", shortcut: "Ctrl+W", run: () => requestCloseTab(active) },
    { id: "reopen-editor", label: "File: Reopen Closed Editor", detail: "Reabrir o ultimo arquivo fechado neste projeto", shortcut: "Ctrl+Shift+T", run: reopenClosedEditor },
    { id: "save-file", label: "File: Save", detail: active?.name || "Salvar editor ativo", shortcut: "Ctrl+S", run: () => (active ? workspace.saveFile(active.path) : workspace.saveAll()).catch(error => setLocalError(error.message || String(error))) },
    { id: "save-all", label: "File: Save All", detail: `${workspace.dirtyCount} arquivo(s) pendente(s)`, shortcut: "Ctrl+Shift+S", run: () => workspace.saveAll().catch(error => setLocalError(error.message || String(error))) },
    { id: "refresh", label: "Workspace: Refresh", detail: "Reindexar árvore, Git e arquivos", shortcut: "", run: () => workspace.refresh().catch(error => setLocalError(error.message || String(error))) },
    { id: "add-project", label: "Workspace: Add Project", detail: `${workspace.projects?.length || 0} projeto(s) disponível(is) na IDE`, shortcut: "", run: chooseDirectory },
    { id: "changes", label: "View: Source Control / Changes", detail: `${workspace.sessionChanges?.length || 0} alteração(ões) da sessão`, shortcut: "Ctrl+Shift+G", run: () => openPanel("changes") },
    { id: "problems", label: "View: Problems", detail: `${analysis.diagnostics.length} diagnóstico(s) local(is)`, shortcut: "Ctrl+Shift+M", run: () => openPanel("problems") },
    { id: "outline", label: "View: Outline / AST", detail: `${analysis.symbols.length} símbolo(s) detectado(s)`, shortcut: "Ctrl+Shift+O", run: () => openPanel("outline") },
    { id: "terminal", label: "View: Workspace Terminal", detail: workspace.terminalRuntimeAvailable ? "Terminal real no filesystem físico" : "Terminal seguro do navegador; HOST RW habilita comandos reais", shortcut: "Ctrl+`", run: () => openPanel("terminal") },
    { id: "zoom-in", label: "View: Increase IDE Zoom", detail: `Aumentar legibilidade da IDE · atual ${ideZoom}%`, shortcut: "Ctrl+Alt+=", run: () => changeIdeZoom(1) },
    { id: "zoom-out", label: "View: Decrease IDE Zoom", detail: `Reduzir escala visual da IDE · atual ${ideZoom}%`, shortcut: "Ctrl+Alt+-", run: () => changeIdeZoom(-1) },
    { id: "zoom-reset", label: "View: Reset IDE Zoom", detail: `Restaurar escala visual para ${IDE_DEFAULT_ZOOM}%`, shortcut: "Ctrl+Alt+0", run: resetIdeZoom },
    { id: "explorer-view", label: "View: Explorer", detail: "Mostrar arquivos do projeto", shortcut: "Ctrl+Shift+E", run: () => { setSidebarMode("files"); setExplorerHidden(false) } },
    { id: "project-search", label: "Buscar: Conteúdo no projeto", detail: "Buscar também nas alterações não salvas", shortcut: "Ctrl+Shift+F", run: openSearch },
    { id: "find", label: "Buscar: No arquivo", detail: "Localizar texto no editor", shortcut: "Ctrl+F", run: () => requestFind() },
    { id: "replace", label: "Buscar: Substituir no arquivo", detail: "Revisar no editor antes de salvar", shortcut: "Ctrl+H", run: () => requestFind(true) },
    { id: "format-document", label: "Formatar: Documento", detail: active ? `Formatar ${active.name} como ${active.language}` : "Selecione um arquivo", shortcut: "Shift+Alt+F", run: formatActiveDocument },
    { id: "go-definition", label: "Navegar: Ir para definição", detail: "Resolver o símbolo sob o cursor", shortcut: "F12", run: () => runSymbolNavigation({ mode: "definition" }) },
    { id: "go-implementation", label: "Navegar: Ir para implementação", detail: "Encontrar implementações do símbolo sob o cursor", shortcut: "Ctrl+F12", run: () => runSymbolNavigation({ mode: "implementation" }) },
    { id: "navigate-back", label: "Navegar: Voltar", detail: "Voltar para a posição anterior", shortcut: "Alt+Left", run: () => navigateHistory("back") },
    { id: "navigate-forward", label: "Navegar: Avançar", detail: "Avançar no histórico de navegação", shortcut: "Alt+Right", run: () => navigateHistory("forward") },
    { id: "go-line", label: "Navegar: Ir para linha", detail: "Linha e coluna no arquivo atual", shortcut: "Ctrl+G", run: requestGoToLine },
    { id: "reveal", label: "Navegar: Revelar arquivo no explorador", detail: active?.path || "Selecione um arquivo", run: revealInExplorer },
    { id: "explorer", label: "Visualizar: Alternar explorador", detail: "Mais espaço para o código", shortcut: "Ctrl+B", run: () => setExplorerHidden(value => !value) },
    { id: "panel", label: "Visualizar: Alternar painel inferior", detail: "Recolher ou mostrar ferramentas", shortcut: "Ctrl+J", run: togglePanel },
    { id: "reset-layout", label: "Visualizar: Restaurar layout", detail: "Divisão 50/50, explorador e escala padrão", run: resetView },
    onToggleMaximize ? { id: "focus-mode", label: maximized ? "Visualizar: Restaurar workspace" : "Visualizar: Maximizar workspace", detail: maximized ? "Voltar para a navegação completa do AI Memory" : "Exibir somente IDE e chat conversacional", shortcut: "", run: onToggleMaximize } : null,
    { id: "next-tab", label: "Abas: Próxima", detail: "Alternar arquivo aberto", shortcut: "Alt+PageDown", run: () => switchTab(1) },
    { id: "previous-tab", label: "Abas: Anterior", detail: "Alternar arquivo aberto", shortcut: "Alt+PageUp", run: () => switchTab(-1) },
    { id: "close-saved", label: "Abas: Fechar arquivos salvos", detail: "Manter todas as alterações não salvas abertas", run: () => workspace.tabs.filter(tab => !tab.dirty).forEach(closeEditor) }
  ]

  const commandResults = commandActions
    .filter(Boolean)
    .map(action => ({ action, score: fuzzyScore(`${action.label} ${action.detail}`, commandQuery) }))
    .filter(item => !commandQuery.trim() || item.score >= 0)
    .sort((a, b) => commandQuery.trim() ? b.score - a.score : a.action.label.localeCompare(b.action.label))

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
    setCursor({ line: 1, column: 1, offset: 0 })
    setRevealLine(null)
    setWorkbenchPanel("")
    setDialog(null)
    setEditorRequest(null)
    setSidebarMode("files")
    setNavigationPicker(null)
    setNavigationBusy("")
    navigationAbortRef.current?.abort()
    navigationAbortRef.current = null
    navigationHistoryRef.current = { back: [], forward: [] }
  }, [workspace.workspaceSession])

  useEffect(() => {
    const valid = new Set(directoryPaths)
    setExpandedPaths(current => new Set([...current].filter(path => valid.has(path))))
  }, [directoryPaths])

  useEffect(() => {
    const handleGlobalKeyDown = event => {
      if (!visible || !workspace.isReady || event.defaultPrevented || event.isComposing) return
      if (event.target?.closest('[role="dialog"], .platform-dialog-backdrop, .ide-dialog-backdrop')) return
      if (event.key === "Escape") {
        setQuickOpen(false)
        setCommandOpen(false)
        return
      }

      const insideIDE = rootRef.current?.contains(event.target) || rootRef.current?.contains(document.activeElement)
      if (!insideIDE && isEditableShortcutTarget(event.target)) return

      const shortcut = resolveIdeZoomShortcut(event) || resolveIdeShortcut(event)
      if (!shortcut) return
      if (["find", "replace", "go-line", "format-document", "go-definition", "go-implementation", "close-editor"].includes(shortcut) && !active) return

      event.preventDefault()

      if (shortcut === "command-palette") openCommandPalette()
      if (shortcut === "quick-open") openQuick()
      if (shortcut === "new-file") requestCreateFile()
      if (shortcut === "find") requestFind()
      if (shortcut === "replace") requestFind(true)
      if (shortcut === "go-line") requestGoToLine()
      if (shortcut === "explorer") setExplorerHidden(value => !value)
      if (shortcut === "explorer-view") { setSidebarMode("files"); setExplorerHidden(false) }
      if (shortcut === "project-search") openSearch()
      if (shortcut === "panel") togglePanel()
      if (shortcut === "terminal") openPanel("terminal")
      if (shortcut === "changes") openPanel("changes")
      if (shortcut === "outline") openPanel("outline")
      if (shortcut === "problems") openPanel("problems")
      if (shortcut === "reopen-editor") reopenClosedEditor()
      if (shortcut === "close-editor") requestCloseTab(active)
      if (shortcut === "next-tab") switchTab(1)
      if (shortcut === "previous-tab") switchTab(-1)
      if (shortcut === "save-file") (active ? workspace.saveFile(active.path) : workspace.saveAll()).catch(error => setLocalError(error.message || String(error)))
      if (shortcut === "save-all") workspace.saveAll().catch(error => setLocalError(error.message || String(error)))
      if (shortcut === "zoom-in") changeIdeZoom(1)
      if (shortcut === "zoom-out") changeIdeZoom(-1)
      if (shortcut === "zoom-reset") resetIdeZoom()
      if (shortcut === "format-document") formatActiveDocument()
      if (shortcut === "go-definition") runSymbolNavigation({ mode: "definition" })
      if (shortcut === "go-implementation") runSymbolNavigation({ mode: "implementation" })
      if (shortcut === "navigate-back") navigateHistory("back")
      if (shortcut === "navigate-forward") navigateHistory("forward")
    }
    window.addEventListener("keydown", handleGlobalKeyDown)
    return () => window.removeEventListener("keydown", handleGlobalKeyDown)
  })

  useEffect(() => {
    setCursor({ line: 1, column: 1, offset: 0 })
    setRevealLine(current => current?.path === active?.path ? current : null)
    setEditorRequest(null)
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
    if (!workspace.activePath) return
    const previous = recentFilesRef.current.get(workspace.activeProjectId) || []
    recentFilesRef.current.set(workspace.activeProjectId, [workspace.activePath, ...previous.filter(path => path !== workspace.activePath)].slice(0, 40))
    rootRef.current?.querySelector('.ide-tab.active')?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [workspace.activePath, workspace.activeProjectId])

  useEffect(() => {
    try {
      window.localStorage.setItem("ai-memory.ide.zoom", String(ideZoom))
      window.localStorage.setItem("ai-memory.ide.zoom.version", IDE_ZOOM_VERSION)
    } catch {}
  }, [ideZoom])

  useEffect(() => {
    const dialog = quickOpen ? quickDialogRef.current : commandOpen ? commandDialogRef.current : null
    dialog?.querySelector("button.active")?.scrollIntoView({ block: "nearest" })
  }, [quickOpen, commandOpen, quickIndex, commandIndex])

  const toggleDirectory = path => {
    setExpandedPaths(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleTreeKeys = event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const row = event.target.closest(".ide-tree-row, .ide-search-result")
    if (!row) return
    const rows = [...event.currentTarget.querySelectorAll(".ide-tree-row, .ide-search-result")]
    const index = rows.indexOf(row)
    const focus = target => { event.preventDefault(); target?.focus(); target?.scrollIntoView({ block: "nearest" }) }
    if (event.key === "ArrowDown") focus(rows[Math.min(rows.length - 1, index + 1)])
    if (event.key === "ArrowUp") focus(rows[Math.max(0, index - 1)])
    if (event.key === "Home") focus(rows[0])
    if (event.key === "End") focus(rows[rows.length - 1])
    if (event.key === "ArrowRight" && row.classList.contains("directory")) {
      if (row.getAttribute("aria-expanded") === "false") { event.preventDefault(); row.click() }
      else focus(rows[index + 1])
    }
    if (event.key === "ArrowLeft") {
      if (row.getAttribute("aria-expanded") === "true") { event.preventDefault(); row.click() }
      else {
        const group = row.classList.contains("directory") ? row.parentElement.parentElement.closest(".ide-tree-group") : row.closest(".ide-tree-group")
        focus(group?.querySelector(":scope > .ide-tree-row.directory"))
      }
    }
  }

  const expandAll = () => setExpandedPaths(new Set(directoryPaths))
  const collapseAll = () => setExpandedPaths(new Set())

  const openQuickResult = async path => {
    if (!path) return
    setLocalError("")
    try {
      await workspace.openFile(path)
      if (quickLocation) setRevealLine({ path, line: Number(quickLocation[2]), column: Number(quickLocation[3] || 1), nonce: Date.now() })
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

  const revealActiveLine = line => {
    if (!active) return
    setRevealLine({ path: active.path, line, nonce: Date.now() })
  }

  if (!workspace.supported) {
    return (
      <section className="code-workspace unsupported">
        <div className="ide-empty-state"><span className="ide-empty-mark">&lt;/&gt;</span><h2>Este navegador não oferece armazenamento de projeto compatível</h2><p>A IDE precisa de acesso direto à pasta ou de suporte a diretórios com armazenamento privado do navegador. Atualize o navegador para uma versão recente e tente novamente.</p><button className="primary-button" onClick={onClose}>Voltar ao painel</button></div>
      </section>
    )
  }

  return (
    <section ref={rootRef} className={`code-workspace layout-${layout}${workbenchPanel ? " has-workbench" : ""}`} style={{ "--ide-explorer-width": `${explorerWidth}px`, "--ide-workbench-height": `${workbenchHeight}px`, ...buildIdeMetrics(ideZoom) }}>
      <PortableProjectImportDialog
        open={portableImportOpen}
        busy={portableImportBusy}
        error={portableImportError}
        onCancel={() => { if (!portableImportBusy) { setPortableImportOpen(false); setPortableImportError("") } }}
        folderPickerSupported={typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"}
        onDropProject={dataTransfer => importPortableSource({ kind: "drop", dataTransfer })}
        onPickFolder={pickPortableFolder}
        onFolderFiles={files => importPortableSource({ kind: "files", files })}
        onZipProject={file => importPortableSource({ kind: "zip", file })}
      />
      <header className="ide-topbar">
        <div className="ide-title">
          <span className="ide-logo">&lt;/&gt;</span>
          <div><span className="eyebrow">Developer Workspace</span><strong>{workspace.isReady ? workspace.rootName : "Nenhum projeto ativo"}</strong></div>
          {workspace.isReady ? <span className={`ide-write-status${workspace.workspaceMode === "portable" ? " portable" : workspace.workspaceMode === "runtime" ? " runtime" : ""}`} title={workspace.workspaceMode === "portable" ? "Workspace editável armazenado somente no navegador; não altera a pasta física original" : workspace.workspaceMode === "runtime" ? "Projeto físico conectado ao Workspace Runtime com escrita no disco e terminal real" : "Pasta local com leitura e escrita diretas pelo navegador"}><i />{workspace.workspaceMode === "portable" ? "browser rw" : workspace.workspaceMode === "runtime" ? "host rw" : "read/write"}</span> : null}
          {workspace.isReady && workspace.workspaceMode !== "runtime" && workspace.runtimeAvailable ? <button className="ide-host-connect" onClick={connectCurrentProjectToHost} title={workspace.workspaceMode === "portable" ? "Migrar Browser Workspace para pasta física com Git e terminal reais" : "Habilitar terminal real e Git do sistema operacional neste projeto físico"}>{workspace.workspaceMode === "portable" ? "↔ Conectar host" : ">_ Terminal host"}</button> : null}
          {workspace.isReady && workspace.gitRepository ? <button className={`ide-git-branch${workspace.gitDetached ? " detached" : ""}`} onClick={() => openPanel("changes")} title={workspace.gitHead ? `HEAD ${workspace.gitHead}` : "Repositório Git detectado"}><i>⑂</i><strong>{workspace.gitBranch || workspace.gitHeadShort || "Git"}</strong>{workspace.gitHeadShort ? <small>{workspace.gitHeadShort}</small> : null}</button> : null}
          <ProjectSwitcher workspace={workspace} onAddProject={chooseDirectory} onSelectProject={changeProject} onRemoveProject={forgetProject} onRefreshProject={refreshProject} maximized={maximized} onToggleMaximize={onToggleMaximize} />
        </div>
        <div className="ide-toolbar-actions">
          {workspace.isReady ? <button onClick={openQuick} title="Quick Open · Ctrl/Cmd+E ou Ctrl/Cmd+P">⌕ Arquivos</button> : null}
          {workspace.isReady ? <button onClick={openCommandPalette} title="Command Palette · Ctrl/Cmd+Shift+P">⌘ Comandos</button> : null}
          {workspace.dirtyCount ? <button className="accent" onClick={() => workspace.saveAll().catch(error => setLocalError(error.message || String(error)))} disabled={workspace.projectSwitching || workspace.workspaceBusy}>Salvar · {workspace.dirtyCount}</button> : null}
          <div className="ide-zoom-control" aria-label="Escala visual da IDE" title="Zoom da IDE · Ctrl+Alt + / - / 0">
            <button type="button" onClick={() => changeIdeZoom(-1)} disabled={ideZoom === IDE_ZOOM_STEPS[0]} aria-label="Diminuir zoom da IDE">−</button>
            <button type="button" className="ide-zoom-value" onClick={resetIdeZoom} title="Restaurar zoom recomendado">{ideZoom}%</button>
            <button type="button" onClick={() => changeIdeZoom(1)} disabled={ideZoom === IDE_ZOOM_STEPS[IDE_ZOOM_STEPS.length - 1]} aria-label="Aumentar zoom da IDE">+</button>
          </div>
          <IdeViewOptions layout={layout} onLayoutChange={onLayoutChange} explorerHidden={explorerHidden} onToggleExplorer={() => setExplorerHidden(value => !value)} onReset={resetView} zoom={ideZoom} onZoom={changeIdeZoom} onResetZoom={resetIdeZoom} panelOpen={Boolean(workbenchPanel)} onTogglePanel={togglePanel} />
          <button className="ide-console-button" onClick={onClose}>Painel</button>
        </div>
      </header>

      {localError || workspace.error ? <div className="ide-error">{localError || workspace.error}</div> : null}

      {!workspace.isReady ? (
        <div className="ide-empty-state">
          <span className="ide-empty-mark">&lt;/&gt;</span>
          <span className="eyebrow">{workspace.runtimeAvailable ? "Host workspace" : workspace.directAccessSupported ? "Local workspace" : "Browser workspace"}</span>
          <h2>Código, memória e agente.<br /><em>No mesmo fluxo.</em></h2>
          <p>{workspace.projects?.length ? "Selecione no topo um projeto já adicionado ou conecte outra pasta. Cada projeto mantém suas próprias abas, contexto, alterações da sessão e estado de Git enquanto você alterna entre eles." : workspace.runtimeAvailable ? "Conecte a raiz do primeiro projeto pelo Workspace Runtime para editar o filesystem físico com Git e terminal reais. Depois você poderá alternar entre vários projetos sem substituir o workspace atual." : workspace.directAccessSupported ? "Selecione a raiz do primeiro projeto para editar arquivos diretamente na pasta local. Depois você poderá adicionar quantos projetos precisar e alternar entre eles sem substituir o workspace atual." : "Importe o primeiro projeto arrastando a pasta para a IDE ou selecionando um ZIP. O AI Memory criará um workspace privado e editável neste navegador sem usar a confirmação nativa de upload de diretório."}</p>
          <button className="primary-button" onClick={chooseDirectory} disabled={!workspace.projectRegistryReady}>{workspace.projectRegistryReady ? workspace.projects?.length ? "Adicionar outro projeto" : workspace.runtimeAvailable ? "Conectar primeiro projeto" : workspace.directAccessSupported ? "Adicionar primeiro projeto" : "Importar primeiro projeto" : "Carregando projetos…"}</button>
          <small>{workspace.projectRegistryPersistent ? workspace.runtimeAvailable ? "Workspace Runtime conectado em localhost: alterações, Git, terminal e comandos operam diretamente no projeto físico com as permissões do usuário local." : workspace.directAccessSupported ? ".git, dependências e artefatos gerados ficam fora da árvore por performance. Arquivos sensíveis como .env ficam visíveis e editáveis na IDE, mas permanecem fora do contexto automático enviado ao agente. A lista de projetos fica registrada neste navegador." : "Modo Browser Workspace ativo: arraste uma pasta ou importe ZIP. Dependências e artefatos gerados são ignorados; arquivos sensíveis ficam disponíveis na cópia editável, mas permanecem fora do contexto automático do agente." : "A sessão multi-projeto está ativa, mas o navegador não permitiu persistir a lista localmente."}</small>
        </div>
      ) : (
        <div ref={bodyRef} className={`ide-body${!explorerVisible ? " explorer-hidden" : ""}${narrowExplorer ? " narrow-explorer" : ""}`}>
          <IdeActivityBar sidebarMode={sidebarMode} explorerVisible={explorerVisible} workbenchPanel={workbenchPanel} changeCount={changeCount} problemCount={analysis.diagnostics.length} symbolCount={analysis.symbols.length} terminalRuntimeAvailable={workspace.terminalRuntimeAvailable} onExplorer={() => activateSidebar("files")} onSearch={() => activateSidebar("search")} onPanel={toggleActivityPanel} />
          {explorerVisible ? <aside id="ide-explorer-pane" className="ide-explorer">
            {sidebarMode === "search" ? <ProjectSearch key={workspace.workspaceSession} workspace={workspace} onOpen={openSearchResult} /> : <>

            <div className="ide-explorer-head"><div><span>Explorer</span><strong>{workspace.rootName}</strong>{workspace.gitRepository ? <button onClick={() => openPanel("changes")}><i>⑂</i>{workspace.gitBranch || workspace.gitHeadShort || "Git"}</button> : null}</div><button onClick={requestCreateFile} title="Novo arquivo" disabled={workspace.projectSwitching || workspace.workspaceBusy}>+</button></div>
            <div className="ide-search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filtrar arquivos…" /></div>
            <div className="ide-tree-controls">
              <button onClick={collapseAll} disabled={!expandedPaths.size}><span>−</span>Recolher</button>
              <button onClick={expandAll} disabled={!directoryPaths.length || expandedPaths.size === directoryPaths.length}><span>+</span>Expandir</button>
            </div>
            <div className="ide-tree" onKeyDown={handleTreeKeys} aria-label="Arquivos do projeto">
              {query ? searchResults.map(path => {
                const badge = fileBadge(path)
                const change = changeMap.get(path)
                return <button key={path} className={`ide-search-result${workspace.activePath === path ? " active" : ""}`} onClick={() => workspace.openFile(path).catch(error => setLocalError(error.message || String(error)))}><span className={`ide-file-icon tone-${badge.tone}`}>{badge.label}</span><div><strong>{path.split("/").pop()}</strong><span>{path}</span></div>{change ? <em className={`ide-tree-change change-${changeLetter(change).toLowerCase()}`}>{changeLetter(change)}</em> : null}</button>
              }) : workspace.tree.map(node => <TreeNode key={node.path} node={node} depth={0} workspace={workspace} expandedPaths={expandedPaths} onToggleDirectory={toggleDirectory} onError={setLocalError} changeMap={changeMap} />)}
              {query && !searchResults.length ? <div className="ide-no-results">Nenhum arquivo encontrado.</div> : null}
            </div>
            <div className="ide-explorer-foot"><span>{workspace.filePaths.length} arquivos · {workspace.contextPaths.length} contexto · {workspace.sessionChanges?.length || 0} changes</span><span>Ctrl+E/P arquivo · Ctrl+Shift+P comandos</span></div>
            </>}
          </aside> : null}

          {explorerVisible && !narrowExplorer ? <ResizeHandle className="ide-explorer-divider" label="Largura do explorador" controls="ide-explorer-pane" value={explorerWidth} min={160} max={explorerMax} onChange={setExplorerWidth} onReset={() => setExplorerWidth(264)} /> : null}

          <div ref={editorColumnRef} className={`ide-editor-column${workbenchPanel ? " panel-open" : ""}`}>
            <div className="ide-tabs">
              {workspace.tabs.map(tab => {
                const badge = fileBadge(tab.path)
                const change = changeMap.get(tab.path)
                return <div key={tab.path} className={`ide-tab${workspace.activePath === tab.path ? " active" : ""}`}><button className="ide-tab-select" aria-pressed={workspace.activePath === tab.path} onClick={() => workspace.setActivePath(tab.path)} title={tab.path}><span className={`ide-tab-file-icon tone-${badge.tone}`}>{badge.label}</span><span>{tab.name}</span>{change ? <em className={`ide-tab-change change-${changeLetter(change).toLowerCase()}`}>{changeLetter(change)}</em> : null}{tab.dirty ? <i aria-label="Alterações não salvas" /> : null}</button><button className="ide-tab-close" aria-label={`Fechar ${tab.name}`} onClick={() => requestCloseTab(tab)}>×</button></div>
              })}
              {!workspace.tabs.length ? <span className="ide-tabs-empty">Abra um arquivo no Explorer ou use Ctrl/Cmd+P</span> : null}
            </div>
            <div className="ide-editor-toolbar">
              <button className="ide-sidebar-toggle" onClick={() => setExplorerHidden(value => !value)} aria-label={explorerHidden ? "Mostrar explorador" : "Recolher explorador"} title="Explorador · Ctrl+B">◧</button>
              <div className={`ide-breadcrumbs${active ? "" : " workspace-tools"}`}>
                {active ? active.path.split("/").map((part, index, values) => <React.Fragment key={`${part}:${index}`}><button onClick={revealInExplorer} title="Revelar no explorador">{part}</button>{index < values.length - 1 ? <i>›</i> : null}</React.Fragment>) : <><span>Workspace</span><i>›</i><span>Ferramentas de desenvolvimento</span></>}
              </div>
              <div className="ide-editor-actions ide-workbench-actions" aria-label="Acoes do editor">
                <button onClick={() => requestFind()} disabled={!active} title="Buscar no arquivo · Ctrl+F"><span>F</span><strong>Buscar</strong></button>
                {active ? <button className={workspace.contextPaths.includes(active.path) ? "active" : ""} onClick={() => workspace.toggleContext(active.path)} title="Fixar arquivo no contexto do agente"><span>C</span><strong>{workspace.contextPaths.includes(active.path) ? "Contexto" : "Fixar"}</strong></button> : null}
                {active ? <button onClick={formatActiveDocument} disabled={!canFormatLanguage(active.language)} title="Formatar documento · Shift+Alt+F"><span>⇥</span><strong>Formatar</strong></button> : null}
                {active ? <button onClick={() => workspace.saveFile(active.path).catch(error => setLocalError(error.message || String(error)))} disabled={!active.dirty || workspace.projectSwitching || workspace.workspaceBusy} title="Salvar arquivo · Ctrl/Cmd+S"><span>S</span><strong>Salvar</strong></button> : null}
              </div>
            </div>
            {active ? <SyntaxEditor key={`${workspace.workspaceSession}:${active.path}`} searchRequest={editorRequest} value={active.content} language={active.language} path={active.path} onChange={content => workspace.updateContent(active.path, content)} onSave={() => workspace.saveFile(active.path).catch(error => setLocalError(error.message || String(error)))} onCursorChange={setCursor} onNavigate={runSymbolNavigation} revealLine={revealLine} fontSize={14 * ideZoom / 100} /> : <div className="ide-editor-empty"><span>&lt;/&gt;</span><strong>Escolha um arquivo para começar</strong><p>Git, Terminal, Outline e Problems permanecem acessiveis pela barra de atividades mesmo sem um arquivo aberto.</p></div>}
            {workbenchPanel ? <IdeWorkbenchPanel activePanel={workbenchPanel} onPanelChange={setWorkbenchPanel} onClose={closePanel} workspace={workspace} analysis={analysis} onRevealLine={revealActiveLine} resizeHandle={<ResizeHandle className="ide-workbench-divider" orientation="horizontal" reverse label="Altura do painel inferior" value={workbenchHeight} min={110} max={workbenchMax} onChange={setWorkbenchHeight} onReset={() => setWorkbenchHeight(260)} />} /> : null}
            <footer className="ide-statusbar">
              <button className="status-git" onClick={() => openPanel("changes")} title={workspace.gitHead ? `HEAD ${workspace.gitHead}` : "Git"}>{workspace.gitRepository ? `⑂ ${workspace.gitBranch || workspace.gitHeadShort || "Git"}` : "sem Git"}</button>
              {active ? <span className={active.dirty ? "status-dirty" : "status-saved"}>{active.dirty ? "● Modificado" : "✓ Salvo"}</span> : <span className="status-saved">✓ Workspace ativo</span>}
              {navigationBusy ? <span className="status-navigation">⌕ {navigationBusy}</span> : null}
              <button onClick={() => openPanel("problems")} className={analysis.errorCount ? "status-problem" : ""}>{analysis.errorCount ? `× ${analysis.errorCount}` : "✓ 0"}</button>
              {active ? <><button onClick={requestGoToLine} title="Ir para linha · Ctrl+G">Ln {cursor.line}, Col {cursor.column}</button><span>{active.language}</span><span>{lines} linhas</span><strong>Ctrl+Click navegar · F12 definição · Shift+Alt+F formatar</strong></> : <><span>{workspace.filePaths.length} arquivos</span><span>{workspace.contextPaths.length} contexto</span><span>{workspace.terminalRuntimeAvailable ? workspace.gitWorkingChanges?.length || 0 : workspace.sessionChanges?.length || 0} changes</span><strong>Ctrl+` Terminal · Ctrl+Shift+G Git</strong></>}
            </footer>
          </div>
        </div>
      )}

      {quickOpen ? (
        <div className="ide-quick-open-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setQuickOpen(false) }}>
          <div ref={quickDialogRef} className="ide-quick-open" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setQuickOpen(false) } }} role="dialog" aria-modal="true" aria-label="Quick Open">
            <div className="ide-quick-open-input"><span>⌕</span><input ref={quickInputRef} value={quickQuery} onChange={event => { setQuickQuery(event.target.value); setQuickIndex(0) }} onKeyDown={handleQuickKeyDown} placeholder="Buscar arquivo por nome, caminho ou arquivo:linha:coluna…" /></div>
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
          <div ref={commandDialogRef} className="ide-command-palette" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setCommandOpen(false) } }} role="dialog" aria-modal="true" aria-label="Command Palette">
            <div className="ide-quick-open-input"><span>&gt;</span><input ref={commandInputRef} value={commandQuery} onChange={event => { setCommandQuery(event.target.value); setCommandIndex(0) }} onKeyDown={handleCommandKeyDown} placeholder="Executar comando da IDE…" /></div>
            <div className="ide-command-results">
              {!commandResults.length ? <div className="ide-quick-empty">Nenhum comando encontrado.</div> : null}
              {commandResults.map((item, index) => <button key={item.action.id} className={index === commandIndex ? "active" : ""} onMouseEnter={() => setCommandIndex(index)} onClick={() => { setCommandOpen(false); item.action.run() }}><span>◇</span><div><strong>{item.action.label}</strong><small>{item.action.detail}</small></div>{item.action.shortcut ? <kbd>{item.action.shortcut}</kbd> : null}</button>)}
            </div>
            <footer><span>Command Palette</span><strong>Ctrl/Cmd+Shift+P</strong></footer>
          </div>
        </div>
      ) : null}

      {navigationPicker ? (
        <div className="ide-quick-open-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setNavigationPicker(null) }}>
          <div ref={navigationDialogRef} className="ide-command-palette ide-navigation-picker" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setNavigationPicker(null) } }} role="dialog" aria-modal="true" aria-label={`Destinos de ${navigationPicker.symbol}`}>
            <div className="ide-navigation-picker-head"><div><strong>{navigationPicker.symbol}</strong><small>{navigationPicker.mode === "implementation" ? "Implementações" : navigationPicker.mode === "definition" ? "Definições" : "Destinos inteligentes"} · {navigationPicker.results.length} resultado(s)</small></div><button type="button" onClick={() => setNavigationPicker(null)} aria-label="Fechar destinos">×</button></div>
            <div className="ide-command-results">
              {navigationPicker.results.map((item, index) => <button key={`${item.path}:${item.line}:${item.column}:${index}`} onClick={() => navigateToLocation(item)}><span>↪</span><div><strong>{item.path.split("/").pop()} · linha {item.line}</strong><small>{item.kind} · {item.path}</small><small className="ide-navigation-detail">{item.detail}</small></div><kbd>Enter</kbd></button>)}
            </div>
            <footer><span>Ctrl+Click usa navegação inteligente</span><span>F12 definição</span><strong>Ctrl+F12 implementação</strong></footer>
          </div>
        </div>
      ) : null}

      <IdeDialog open={Boolean(dialog)} title={dialog?.title || ""} description={dialog?.description || ""} confirmLabel={dialog?.confirmLabel} tone={dialog?.tone} value={dialog?.value || ""} placeholder={dialog?.type === "new-file" ? "src/components/NovoArquivo.jsx" : ""} onValueChange={["new-file", "go-line"].includes(dialog?.type) ? value => setDialog(current => ({ ...current, value, error: "" })) : null} onConfirm={confirmDialog} onCancel={() => setDialog(null)} error={dialog?.error || ""} />
    </section>
  )
}
