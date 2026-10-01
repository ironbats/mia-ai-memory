import React, { useEffect, useMemo, useState } from "react"
import { buildDiff, changeStatusLetter } from "../lib/ideDiff.js"
import IdeTerminal from "./ide/IdeTerminal.jsx"


const severityIcon = severity => severity === "error" ? "×" : severity === "warning" ? "!" : "i"

export default function IdeWorkbenchPanel({ activePanel, onPanelChange, onClose, workspace, analysis, onRevealLine, resizeHandle, maximized = false, onToggleMaximize }) {
  const [selectedChangePath, setSelectedChangePath] = useState("")
  const sessionChanges = workspace.sessionChanges || []
  const gitChanges = workspace.gitWorkingChanges || []
  const changes = useMemo(() => {
    if (!workspace.terminalRuntimeAvailable || !gitChanges.length) return sessionChanges
    const byPath = new Map(sessionChanges.map(item => [item.path, item]))
    return gitChanges.map(item => ({ ...(byPath.get(item.path) || {}), path: item.path, gitStatus: item.status, origin: byPath.has(item.path) ? byPath.get(item.path).origin : "git" }))
  }, [gitChanges, sessionChanges, workspace.terminalRuntimeAvailable])
  const selectedChange = changes.find(item => item.path === selectedChangePath) || changes[0] || null
  const selectedSessionChange = selectedChange ? sessionChanges.find(item => item.path === selectedChange.path) || null : null
  const selectedDiff = useMemo(() => selectedSessionChange ? buildDiff({
    path: selectedSessionChange.path,
    before: selectedSessionChange.before,
    after: selectedSessionChange.after,
    beforeExists: selectedSessionChange.beforeExists,
    afterExists: selectedSessionChange.afterExists
  }) : null, [selectedSessionChange])

  useEffect(() => { setSelectedChangePath("") }, [workspace.activeProjectId])

  return (
    <section className="ide-workbench" hidden={!activePanel}>
      {resizeHandle}
      <header className="ide-workbench-tabs">
        <button className={activePanel === "problems" ? "active" : ""} onClick={() => onPanelChange("problems")}>Problems <span>{analysis.diagnostics.length}</span></button>
        <button className={activePanel === "outline" ? "active" : ""} onClick={() => onPanelChange("outline")}>Outline <span>{analysis.symbols.length}</span></button>
        <button className={activePanel === "changes" ? "active" : ""} onClick={() => onPanelChange("changes")}>Changes <span>{changes.length}</span></button>
        <button className={activePanel === "terminal" ? "active" : ""} onClick={() => onPanelChange("terminal")}>Terminal {workspace.terminalRuntimeAvailable ? <span className="terminal-live-badge">HOST</span> : null}</button>
        <div className="ide-workbench-branch">{workspace.gitRepository ? <><i>⑂</i><strong>{workspace.gitBranch || workspace.gitHeadShort || "Git"}</strong>{workspace.gitHeadShort ? <span>{workspace.gitHeadShort}</span> : null}</> : <span>sem Git</span>}</div>

        {onToggleMaximize ? <button className="ide-workbench-maximize" onClick={onToggleMaximize} aria-label={maximized ? "Restaurar painel" : "Maximizar painel"} title={maximized ? "Restaurar tamanho do painel" : "Maximizar painel"} aria-pressed={maximized}>{maximized ? "⌄" : "⌃"}</button> : null}
        <button className="ide-workbench-close" onClick={onClose} title="Fechar painel">×</button>
      </header>

      {activePanel === "problems" ? (
        <div className="ide-problems-panel">
          {analysis.diagnostics.map((item, index) => <button key={`${item.line}:${item.message}:${index}`} className={`severity-${item.severity}`} onClick={() => onRevealLine(item.line)}><i>{severityIcon(item.severity)}</i><span><strong>{item.message}</strong><small>Ln {item.line} · {workspace.activeTab?.name || "arquivo ativo"}</small></span></button>)}
          {!analysis.diagnostics.length ? <div className="ide-panel-empty"><span>✓</span><strong>Nenhum problema local detectado</strong><small>{workspace.activeTab ? "Validação estrutural e conflitos estão limpos no arquivo ativo." : "Abra um arquivo para executar a análise local de problemas."}</small></div> : null}
        </div>
      ) : null}

      {activePanel === "outline" ? (
        <div className="ide-outline-panel">
          {analysis.symbols.map((symbol, index) => <button key={`${symbol.kind}:${symbol.name}:${symbol.line}:${index}`} onClick={() => onRevealLine(symbol.line)}><span className={`symbol-kind kind-${symbol.kind}`}>{symbol.kind.slice(0, 2).toUpperCase()}</span><strong>{symbol.name}</strong><small>Ln {symbol.line}</small></button>)}
          {!analysis.symbols.length ? <div className="ide-panel-empty"><span>◇</span><strong>Nenhum símbolo indexado</strong><small>{workspace.activeTab ? "O provider local ainda não encontrou classes, funções ou tipos neste arquivo." : "Abra um arquivo para carregar a árvore AST e os símbolos locais."}</small></div> : null}
        </div>
      ) : null}

      {activePanel === "changes" ? (
        <div className="ide-changes-panel">
          <aside className="ide-change-list">
            <div className="ide-change-summary"><strong>{changes.length} change{changes.length === 1 ? "" : "s"}</strong><small>{workspace.terminalRuntimeAvailable ? "git status real · filesystem físico" : "diff da sessão · navegador"} · {workspace.gitBranch || "workspace local"}</small></div>
            {changes.map(change => <button key={change.path} className={selectedChange?.path === change.path ? "active" : ""} onClick={() => setSelectedChangePath(change.path)} onDoubleClick={() => workspace.openFile(change.path).catch(() => {})}><span className={`change-status status-${changeStatusLetter(change).toLowerCase()}`}>{changeStatusLetter(change)}</span><strong>{change.path.split("/").pop()}</strong><small>{change.gitStatus ? `${change.gitStatus} · ` : ""}{change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "/"}</small></button>)}
            {!changes.length ? <div className="ide-change-empty">{workspace.terminalRuntimeAvailable ? "Git working tree limpo." : "Nenhuma alteração registrada nesta sessão."}</div> : null}
          </aside>
          <div className="ide-diff-view">
            {selectedDiff ? <>
              <header><strong>{selectedDiff.path}</strong><span className="diff-add">+{selectedDiff.additions}</span><span className="diff-del">-{selectedDiff.deletions}</span><small>{selectedSessionChange.origin}</small></header>
              <div className="ide-diff-lines">
                {selectedDiff.rows.map((row, index) => <div key={`${index}:${row.oldLine}:${row.newLine}`} className={`diff-row ${row.type}`}><span>{row.oldLine ?? ""}</span><span>{row.newLine ?? ""}</span><i>{row.type === "add" ? "+" : row.type === "delete" ? "−" : " "}</i><code>{row.text || " "}</code></div>)}
              </div>
            </> : selectedChange?.gitStatus ? <div className="ide-panel-empty"><span>⑂</span><strong>{selectedChange.gitStatus} {selectedChange.path}</strong><small>Alteração detectada pelo Git real. Use <code>git diff -- {selectedChange.path}</code> no Terminal para consultar o diff completo do filesystem.</small></div> : <div className="ide-panel-empty"><span>⑂</span><strong>Working diff limpo</strong><small>As alterações feitas pelo editor e pelo agente aparecerão aqui sem sair da IDE.</small></div>}
          </div>
        </div>
      ) : null}

      <IdeTerminal workspace={workspace} analysis={analysis} visible={activePanel === "terminal"} />

    </section>
  )
}
