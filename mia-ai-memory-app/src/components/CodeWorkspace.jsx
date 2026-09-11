import React, { useEffect, useMemo, useRef, useState } from "react"

const TreeNode = ({ node, depth, workspace, expandedPaths, onToggleDirectory }) => {
  if (node.type === "directory") {
    const expanded = expandedPaths.has(node.path)
    return (
      <div className="ide-tree-group">
        <button className="ide-tree-row directory" style={{ paddingLeft: 10 + depth * 13 }} onClick={() => onToggleDirectory(node.path)}>
          <i>{expanded ? "⌄" : "›"}</i><span className="ide-tree-folder">{expanded ? "▾" : "▸"}</span><strong>{node.name}</strong>
        </button>
        {expanded ? node.children.map(child => <TreeNode key={child.path} node={child} depth={depth + 1} workspace={workspace} expandedPaths={expandedPaths} onToggleDirectory={onToggleDirectory} />) : null}
      </div>
    )
  }
  const pinned = workspace.contextPaths.includes(node.path)
  return (
    <div className={`ide-tree-file-wrap${workspace.activePath === node.path ? " active" : ""}`}>
      <button className="ide-tree-row file" style={{ paddingLeft: 27 + depth * 13 }} onClick={() => workspace.openFile(node.path).catch(() => {})} title={node.path}>
        <span className="ide-file-icon">{node.name.includes(".") ? node.name.split(".").pop().slice(0, 3).toUpperCase() : "TXT"}</span><strong>{node.name}</strong>
      </button>
      <button className={`ide-context-pin${pinned ? " active" : ""}`} onClick={() => workspace.toggleContext(node.path)} title={pinned ? "Remover do contexto fixo" : "Fixar no contexto do agente"}>●</button>
    </div>
  )
}

const insertAtSelection = (value, start, end, insertion) => `${value.slice(0, start)}${insertion}${value.slice(end)}`

export default function CodeWorkspace({ workspace, layout = "split", onLayoutChange, onClose }) {
  const [query, setQuery] = useState("")
  const [localError, setLocalError] = useState("")
  const [expandedPaths, setExpandedPaths] = useState(() => new Set())
  const editorRef = useRef(null)
  const lineRef = useRef(null)
  const active = workspace.activeTab
  const lines = useMemo(() => active ? Math.max(1, active.content.split("\n").length) : 0, [active?.content])
  const lineNumbers = useMemo(() => lines ? Array.from({ length: lines }, (_, index) => index + 1).join("\n") : "", [lines])
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return workspace.filePaths.filter(path => path.toLowerCase().includes(normalized)).slice(0, 120)
  }, [query, workspace.filePaths])
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

  useEffect(() => {
    setExpandedPaths(new Set())
    setQuery("")
  }, [workspace.workspaceSession])

  useEffect(() => {
    const valid = new Set(directoryPaths)
    setExpandedPaths(current => new Set([...current].filter(path => valid.has(path))))
  }, [directoryPaths])

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

  const chooseDirectory = async () => {
    setLocalError("")
    try {
      await workspace.selectDirectory()
    } catch (error) {
      if (error?.name !== "AbortError") setLocalError(error.message || String(error))
    }
  }

  const createFile = async () => {
    const path = window.prompt("Novo arquivo · caminho relativo ao projeto")?.trim()
    if (!path) return
    setLocalError("")
    try {
      await workspace.createFile(path)
    } catch (error) {
      setLocalError(error.message || String(error))
    }
  }

  const onEditorKeyDown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      workspace.saveFile(active.path).catch(error => setLocalError(error.message || String(error)))
      return
    }
    if (event.key === "Tab") {
      event.preventDefault()
      const start = event.currentTarget.selectionStart
      const end = event.currentTarget.selectionEnd
      const next = insertAtSelection(active.content, start, end, "  ")
      workspace.updateContent(active.path, next)
      window.requestAnimationFrame(() => {
        editorRef.current?.setSelectionRange(start + 2, start + 2)
      })
    }
  }

  const syncScroll = event => {
    if (lineRef.current) lineRef.current.scrollTop = event.currentTarget.scrollTop
  }

  if (!workspace.supported) {
    return (
      <section className="code-workspace unsupported">
        <div className="ide-empty-state"><span className="ide-empty-mark">&lt;/&gt;</span><h2>IDE local indisponível neste navegador</h2><p>A edição direta do projeto exige File System Access API. Abra o AI Memory em Chrome ou Edge recente.</p><button className="primary-button" onClick={onClose}>Voltar ao painel</button></div>
      </section>
    )
  }

  return (
    <section className={`code-workspace layout-${layout}`}>
      <header className="ide-topbar">
        <div className="ide-title">
          <span className="ide-logo">&lt;/&gt;</span>
          <div><span className="eyebrow">AI Memory Developer Workspace</span><strong>{workspace.isReady ? workspace.rootName : "Nenhum projeto local"}</strong></div>
          {workspace.isReady ? <span className="ide-write-status"><i />read/write</span> : null}
        </div>
        <div className="ide-toolbar-actions">
          <button onClick={chooseDirectory}>{workspace.isReady ? "Trocar pasta" : "Selecionar pasta"}</button>
          {workspace.isReady ? <button onClick={() => workspace.refresh().catch(error => setLocalError(error.message || String(error)))} disabled={workspace.scanning}>↻ Atualizar</button> : null}
          {workspace.dirtyCount ? <button className="accent" onClick={() => workspace.saveAll().catch(error => setLocalError(error.message || String(error)))}>Salvar tudo · {workspace.dirtyCount}</button> : null}
          <div className="ide-layout-switch" aria-label="Tamanho da IDE">
            <button className={layout === "compact" ? "active" : ""} onClick={() => onLayoutChange("compact")} title="Minimizar IDE">▯</button>
            <button className={layout === "split" ? "active" : ""} onClick={() => onLayoutChange("split")} title="Divisão equilibrada">◫</button>
            <button className={layout === "wide" ? "active" : ""} onClick={() => onLayoutChange("wide")} title="Maximizar IDE">▰</button>
          </div>
          <button className="ide-console-button" onClick={onClose}>Painel AI Memory</button>
        </div>
      </header>

      {localError || workspace.error ? <div className="ide-error">{localError || workspace.error}</div> : null}

      {!workspace.isReady ? (
        <div className="ide-empty-state">
          <span className="ide-empty-mark">&lt;/&gt;</span>
          <span className="eyebrow">Local workspace</span>
          <h2>Seu código e a memória<br /><em>no mesmo contexto.</em></h2>
          <p>Selecione a pasta raiz do projeto. O código permanece no seu computador e só os arquivos relevantes ao prompt são enviados como contexto ao agente.</p>
          <button className="primary-button" onClick={chooseDirectory}>Selecionar projeto local</button>
          <small>.git, dependências, binários, chaves e arquivos .env são excluídos do contexto.</small>
        </div>
      ) : (
        <div className="ide-body">
          <aside className="ide-explorer">
            <div className="ide-explorer-head"><div><span>Explorer</span><strong>{workspace.rootName}</strong></div><button onClick={createFile} title="Novo arquivo">+</button></div>
            <div className="ide-search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar arquivo…" /></div>
            <div className="ide-tree-controls">
              <button onClick={collapseAll} disabled={!expandedPaths.size}><span>−</span>Recolher tudo</button>
              <button onClick={expandAll} disabled={!directoryPaths.length || expandedPaths.size === directoryPaths.length}><span>+</span>Expandir tudo</button>
            </div>
            <div className="ide-tree">
              {query ? searchResults.map(path => (
                <button key={path} className={`ide-search-result${workspace.activePath === path ? " active" : ""}`} onClick={() => workspace.openFile(path).catch(error => setLocalError(error.message || String(error)))}><strong>{path.split("/").pop()}</strong><span>{path}</span></button>
              )) : workspace.tree.map(node => <TreeNode key={node.path} node={node} depth={0} workspace={workspace} expandedPaths={expandedPaths} onToggleDirectory={toggleDirectory} />)}
              {query && !searchResults.length ? <div className="ide-no-results">Nenhum arquivo encontrado.</div> : null}
            </div>
            <div className="ide-explorer-foot"><span>{workspace.filePaths.length} arquivos</span><span>{workspace.contextPaths.length} fixados no contexto</span></div>
          </aside>

          <div className="ide-editor-column">
            <div className="ide-tabs">
              {workspace.tabs.map(tab => <button key={tab.path} className={workspace.activePath === tab.path ? "active" : ""} onClick={() => workspace.setActivePath(tab.path)} title={tab.path}><span>{tab.name}</span>{tab.dirty ? <i /> : null}<b onClick={event => { event.stopPropagation(); workspace.closeTab(tab.path) }}>×</b></button>)}
              {!workspace.tabs.length ? <span className="ide-tabs-empty">Abra um arquivo no Explorer</span> : null}
            </div>
            {active ? (
              <>
                <div className="ide-editor-toolbar">
                  <div className="ide-breadcrumbs">{active.path.split("/").map((part, index, values) => <React.Fragment key={`${part}:${index}`}><span>{part}</span>{index < values.length - 1 ? <i>›</i> : null}</React.Fragment>)}</div>
                  <div className="ide-editor-actions"><span>{active.language}</span><button className={workspace.contextPaths.includes(active.path) ? "active" : ""} onClick={() => workspace.toggleContext(active.path)}>{workspace.contextPaths.includes(active.path) ? "● No contexto" : "○ Fixar contexto"}</button><button onClick={() => workspace.saveFile(active.path).catch(error => setLocalError(error.message || String(error)))} disabled={!active.dirty}>Salvar</button></div>
                </div>
                <div className="ide-editor">
                  <pre ref={lineRef} className="ide-line-numbers" aria-hidden="true">{lineNumbers}</pre>
                  <textarea ref={editorRef} value={active.content} onChange={event => workspace.updateContent(active.path, event.target.value)} onKeyDown={onEditorKeyDown} onScroll={syncScroll} spellCheck="false" wrap="off" aria-label={`Editor ${active.path}`} />
                </div>
                <footer className="ide-statusbar"><span>{active.dirty ? "● Modificado" : "✓ Salvo"}</span><span>{active.language}</span><span>{lines} linhas</span><span>UTF-8</span><strong>Ctrl+S salva</strong></footer>
              </>
            ) : (
              <div className="ide-editor-empty"><span>&lt;/&gt;</span><strong>Escolha um arquivo para começar</strong><p>O agente recebe automaticamente o arquivo ativo, abas abertas e arquivos fixados como contexto.</p></div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
