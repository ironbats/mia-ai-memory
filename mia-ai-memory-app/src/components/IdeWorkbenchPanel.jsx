import React, { useEffect, useMemo, useRef, useState } from "react"
import { buildDiff, formatUnifiedDiff } from "../lib/ideDiff.js"

const statusLetter = change => {
  if (!change.beforeExists && change.afterExists) return "A"
  if (change.beforeExists && !change.afterExists) return "D"
  return "M"
}

const severityIcon = severity => severity === "error" ? "×" : severity === "warning" ? "!" : "i"

const lineText = value => String(value ?? "").split("\n")

export default function IdeWorkbenchPanel({ activePanel, onPanelChange, onClose, workspace, analysis, onRevealLine, resizeHandle }) {
  const [selectedChangePath, setSelectedChangePath] = useState("")
  const [terminalInput, setTerminalInput] = useState("")
  const [terminalEntries, setTerminalEntries] = useState(() => [
    { type: "system", text: "AI Memory Workspace Terminal · digite help para comandos disponíveis" }
  ])
  const [terminalHistory, setTerminalHistory] = useState([])
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState(-1)
  const terminalEndRef = useRef(null)
  const terminalInputRef = useRef(null)
  const changes = workspace.sessionChanges || []
  const selectedChange = changes.find(item => item.path === selectedChangePath) || changes[0] || null
  const selectedDiff = useMemo(() => selectedChange ? buildDiff({
    path: selectedChange.path,
    before: selectedChange.before,
    after: selectedChange.after,
    beforeExists: selectedChange.beforeExists,
    afterExists: selectedChange.afterExists
  }) : null, [selectedChange])

  const appendTerminal = entries => {
    setTerminalEntries(values => [...values, ...entries].slice(-300))
    window.requestAnimationFrame(() => terminalEndRef.current?.scrollIntoView({ block: "end" }))
  }

  const runTerminalCommand = async raw => {
    const command = raw.trim()
    if (!command) return
    const prompt = `${workspace.rootName || "workspace"}:${workspace.gitBranch || "local"}$ ${command}`
    setTerminalHistory(values => [...values.filter(item => item !== command), command].slice(-80))
    setTerminalHistoryIndex(-1)
    setTerminalInput("")
    if (command === "clear") {
      setTerminalEntries([])
      return
    }
    const [base = "", ...args] = command.split(/\s+/)
    const argument = args.join(" ").trim()
    const output = [{ type: "command", text: prompt }]
    try {
      if (base === "help") {
        output.push({ type: "output", text: "help · clear · pwd · ls [path] · find <texto> · open <arquivo> · cat <arquivo> · save · refresh · git branch · git status · git diff [arquivo] · symbols · problems" })
      } else if (base === "pwd") {
        output.push({ type: "output", text: `/${workspace.rootName || "workspace"}` })
      } else if (base === "ls") {
        const prefix = argument ? `${argument.replace(/^\.\//, "").replace(/\/$/, "")}/` : ""
        const items = workspace.filePaths.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split("/")[0]).filter(Boolean)
        output.push({ type: "output", text: [...new Set(items)].sort().slice(0, 200).join("\n") || "Nenhum item encontrado." })
      } else if (base === "find") {
        const normalized = argument.toLowerCase()
        const matches = workspace.filePaths.filter(path => path.toLowerCase().includes(normalized)).slice(0, 100)
        output.push({ type: "output", text: matches.join("\n") || "Nenhum arquivo encontrado." })
      } else if (base === "open") {
        if (!argument) throw new Error("Informe o caminho do arquivo.")
        await workspace.openFile(argument)
        output.push({ type: "success", text: `Aberto: ${argument}` })
      } else if (base === "cat") {
        if (!argument) throw new Error("Informe o caminho do arquivo.")
        const tab = workspace.tabs.find(item => item.path === argument)
        const content = tab ? tab.content : await workspace.readPath(argument)
        output.push({ type: "output", text: lineText(content).slice(0, 240).join("\n") })
      } else if (base === "save") {
        const count = await workspace.saveAll()
        output.push({ type: "success", text: `${count} arquivo(s) salvo(s).` })
      } else if (base === "refresh") {
        await workspace.refresh()
        output.push({ type: "success", text: "Workspace atualizado." })
      } else if (base === "git" && args[0] === "branch") {
        output.push({ type: "output", text: workspace.gitRepository ? `* ${workspace.gitBranch || `(detached ${workspace.gitHeadShort || "HEAD"})`}` : "Projeto sem repositório Git detectado." })
      } else if (base === "git" && args[0] === "status") {
        if (!changes.length) output.push({ type: "success", text: `On branch ${workspace.gitBranch || "local"}\nNo workspace session changes.` })
        else output.push({ type: "output", text: `On branch ${workspace.gitBranch || "local"}\n${changes.map(change => `${statusLetter(change)}  ${change.path}`).join("\n")}` })
      } else if (base === "git" && args[0] === "diff") {
        const requestedPath = args.slice(1).join(" ").trim()
        const targets = requestedPath ? changes.filter(item => item.path === requestedPath) : changes
        output.push({ type: "output", text: targets.length ? targets.map(formatUnifiedDiff).join("\n\n") : "Nenhuma alteração local registrada nesta sessão." })
      } else if (base === "symbols") {
        output.push({ type: "output", text: analysis.symbols.length ? analysis.symbols.map(item => `${item.kind.padEnd(10)} ${String(item.line).padStart(4)}  ${item.name}`).join("\n") : "Nenhum símbolo detectado no arquivo ativo." })
      } else if (base === "problems") {
        output.push({ type: "output", text: analysis.diagnostics.length ? analysis.diagnostics.map(item => `${item.severity.toUpperCase()} Ln ${item.line}: ${item.message}`).join("\n") : "Nenhum problema local detectado." })
      } else {
        output.push({ type: "error", text: `Comando não suportado no terminal local do navegador: ${command}` })
      }
    } catch (error) {
      output.push({ type: "error", text: error.message || String(error) })
    }
    appendTerminal(output)
  }

  const handleTerminalKeyDown = event => {
    if (event.key === "Enter") {
      event.preventDefault()
      runTerminalCommand(terminalInput)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      if (!terminalHistory.length) return
      const nextIndex = terminalHistoryIndex < 0 ? terminalHistory.length - 1 : Math.max(0, terminalHistoryIndex - 1)
      setTerminalHistoryIndex(nextIndex)
      setTerminalInput(terminalHistory[nextIndex] || "")
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      if (terminalHistoryIndex < 0) return
      const nextIndex = terminalHistoryIndex + 1
      if (nextIndex >= terminalHistory.length) {
        setTerminalHistoryIndex(-1)
        setTerminalInput("")
      } else {
        setTerminalHistoryIndex(nextIndex)
        setTerminalInput(terminalHistory[nextIndex] || "")
      }
    }
  }

  useEffect(() => {
    if (activePanel === "terminal") window.requestAnimationFrame(() => terminalInputRef.current?.focus())
  }, [activePanel])

  return (
    <section className="ide-workbench">
      {resizeHandle}
      <header className="ide-workbench-tabs">
        <button className={activePanel === "problems" ? "active" : ""} onClick={() => onPanelChange("problems")}>Problems <span>{analysis.diagnostics.length}</span></button>
        <button className={activePanel === "outline" ? "active" : ""} onClick={() => onPanelChange("outline")}>Outline <span>{analysis.symbols.length}</span></button>
        <button className={activePanel === "changes" ? "active" : ""} onClick={() => onPanelChange("changes")}>Changes <span>{changes.length}</span></button>
        <button className={activePanel === "terminal" ? "active" : ""} onClick={() => onPanelChange("terminal")}>Terminal</button>
        <div className="ide-workbench-branch">{workspace.gitRepository ? <><i>⑂</i><strong>{workspace.gitBranch || workspace.gitHeadShort || "Git"}</strong>{workspace.gitHeadShort ? <span>{workspace.gitHeadShort}</span> : null}</> : <span>sem Git</span>}</div>
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
            <div className="ide-change-summary"><strong>{changes.length} change{changes.length === 1 ? "" : "s"}</strong><small>diff da sessão · {workspace.gitBranch || "workspace local"}</small></div>
            {changes.map(change => <button key={change.path} className={selectedChange?.path === change.path ? "active" : ""} onClick={() => setSelectedChangePath(change.path)} onDoubleClick={() => { if (change.afterExists) workspace.openFile(change.path).catch(() => {}) }}><span className={`change-status status-${statusLetter(change).toLowerCase()}`}>{statusLetter(change)}</span><strong>{change.path.split("/").pop()}</strong><small>{change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "/"}</small></button>)}
            {!changes.length ? <div className="ide-change-empty">Nenhuma alteração registrada nesta sessão.</div> : null}
          </aside>
          <div className="ide-diff-view">
            {selectedDiff ? <>
              <header><strong>{selectedDiff.path}</strong><span className="diff-add">+{selectedDiff.additions}</span><span className="diff-del">-{selectedDiff.deletions}</span><small>{selectedChange.origin}</small></header>
              <div className="ide-diff-lines">
                {selectedDiff.rows.map((row, index) => <div key={`${index}:${row.oldLine}:${row.newLine}`} className={`diff-row ${row.type}`}><span>{row.oldLine ?? ""}</span><span>{row.newLine ?? ""}</span><i>{row.type === "add" ? "+" : row.type === "delete" ? "−" : " "}</i><code>{row.text || " "}</code></div>)}
              </div>
            </> : <div className="ide-panel-empty"><span>⑂</span><strong>Working diff limpo</strong><small>As alterações feitas pelo editor e pelo agente aparecerão aqui sem sair da IDE.</small></div>}
          </div>
        </div>
      ) : null}

      {activePanel === "terminal" ? (
        <div className="ide-terminal-panel">
          <div className="ide-terminal-output">
            {terminalEntries.map((entry, index) => <pre key={`${index}:${entry.text.slice(0, 16)}`} className={`terminal-${entry.type}`}>{entry.text}</pre>)}
            <span ref={terminalEndRef} />
          </div>
          <div className="ide-terminal-input"><span>{workspace.rootName || "workspace"}<i>:</i>{workspace.gitBranch || "local"}$</span><input ref={terminalInputRef} value={terminalInput} onChange={event => setTerminalInput(event.target.value)} onKeyDown={handleTerminalKeyDown} spellCheck="false" autoComplete="off" placeholder="help" /></div>
        </div>
      ) : null}
    </section>
  )
}
