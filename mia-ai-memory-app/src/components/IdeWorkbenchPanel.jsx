import React, { useEffect, useMemo, useRef, useState } from "react"
import { buildDiff, formatUnifiedDiff } from "../lib/ideDiff.js"

const statusLetter = change => {
  if (!change) return "M"
  if (change.gitStatus) {
    const value = String(change.gitStatus).trim()
    return value === "??" ? "A" : value.includes("D") ? "D" : "M"
  }
  if (!change.beforeExists && change.afterExists) return "A"
  if (change.beforeExists && !change.afterExists) return "D"
  return "M"
}

const severityIcon = severity => severity === "error" ? "×" : severity === "warning" ? "!" : "i"
const lineText = value => String(value ?? "").split("\n")
const terminalExitText = session => session.exitCode === 0 ? "Processo finalizado com sucesso." : `Processo finalizado com código ${session.exitCode ?? "?"}${session.signal ? ` · ${session.signal}` : ""}.`

export default function IdeWorkbenchPanel({ activePanel, onPanelChange, onClose, workspace, analysis, onRevealLine, resizeHandle }) {
  const [selectedChangePath, setSelectedChangePath] = useState("")
  const [terminalInput, setTerminalInput] = useState("")
  const [terminalEntries, setTerminalEntries] = useState(() => [
    { type: "system", text: "AI Memory Workspace Terminal · projetos HOST RW executam comandos reais no sistema operacional" }
  ])
  const [terminalHistory, setTerminalHistory] = useState([])
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState(-1)
  const [terminalJobs, setTerminalJobs] = useState([])
  const [terminalCwd, setTerminalCwd] = useState("")
  const terminalEndRef = useRef(null)
  const terminalInputRef = useRef(null)
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

  const appendTerminal = entries => {
    setTerminalEntries(values => [...values, ...entries].slice(-1200))
    window.requestAnimationFrame(() => terminalEndRef.current?.scrollIntoView({ block: "end" }))
  }

  const runBrowserCommand = async command => {
    const [base = "", ...args] = command.split(/\s+/)
    const argument = args.join(" ").trim()
    const output = []
    if (base === "help") {
      output.push({ type: "output", text: "help · clear · pwd · ls [path] · find <texto> · open <arquivo> · cat <arquivo> · save · refresh · git branch · git status · git diff [arquivo] · symbols · problems\nPara Git real, builds, servidores e comandos arbitrários, conecte o projeto como HOST RW pelo Workspace Runtime." })
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
      if (!sessionChanges.length) output.push({ type: "success", text: `On branch ${workspace.gitBranch || "local"}\nNenhuma alteração registrada nesta sessão do navegador. Este resultado não substitui git status do filesystem físico.` })
      else output.push({ type: "output", text: `On branch ${workspace.gitBranch || "local"}\n${sessionChanges.map(change => `${statusLetter(change)}  ${change.path}`).join("\n")}` })
    } else if (base === "git" && args[0] === "diff") {
      const requestedPath = args.slice(1).join(" ").trim()
      const targets = requestedPath ? sessionChanges.filter(item => item.path === requestedPath) : sessionChanges
      output.push({ type: "output", text: targets.length ? targets.map(formatUnifiedDiff).join("\n\n") : "Nenhuma alteração registrada nesta sessão do navegador." })
    } else if (base === "symbols") {
      output.push({ type: "output", text: analysis.symbols.length ? analysis.symbols.map(item => `${item.kind.padEnd(10)} ${String(item.line).padStart(4)}  ${item.name}`).join("\n") : "Nenhum símbolo detectado no arquivo ativo." })
    } else if (base === "problems") {
      output.push({ type: "output", text: analysis.diagnostics.length ? analysis.diagnostics.map(item => `${item.severity.toUpperCase()} Ln ${item.line}: ${item.message}`).join("\n") : "Nenhum problema local detectado." })
    } else {
      throw new Error(`Este projeto está em ${workspace.workspaceMode === "portable" ? "Browser Workspace" : "modo de navegador"}. Conecte-o como HOST RW para executar o comando real: ${command}`)
    }
    return output
  }

  const runTerminalCommand = async raw => {
    const command = raw.trim()
    if (!command) return
    const promptPath = terminalCwd ? `${workspace.rootName || "workspace"}/${terminalCwd}` : workspace.rootName || "workspace"
    const prompt = `${promptPath}:${workspace.gitBranch || "local"}$ ${command}`
    setTerminalHistory(values => [...values.filter(item => item !== command), command].slice(-120))
    setTerminalHistoryIndex(-1)
    setTerminalInput("")
    if (command === "clear") {
      setTerminalEntries([])
      return
    }
    appendTerminal([{ type: "command", text: prompt }])
    try {
      if (workspace.terminalRuntimeAvailable) {
        const result = await workspace.executeTerminalCommand(command)
        const session = result.session
        setTerminalCwd(result.cwd || "")
        if (session?.output) appendTerminal([{ type: session.exitCode === 0 ? "output" : "error", text: session.output }])
        if (session?.running) {
          setTerminalJobs(values => [...values.filter(item => item.id !== session.id), { id: session.id, command, cursor: Number(session.nextCursor || 0), startedAt: session.startedAt }])
        } else if (!session?.builtin) {
          appendTerminal([{ type: session?.exitCode === 0 ? "success" : "error", text: terminalExitText(session || {}) }])
        }
        await workspace.refresh().catch(() => {})
        return
      }
      const output = await runBrowserCommand(command)
      appendTerminal(output)
    } catch (error) {
      appendTerminal([{ type: "error", text: error.message || String(error) }])
    }
  }

  useEffect(() => {
    if (!terminalJobs.length || !workspace.terminalRuntimeAvailable) return undefined
    let cancelled = false
    let timer = null
    const tick = async () => {
      const snapshot = [...terminalJobs]
      const nextJobs = []
      for (const job of snapshot) {
        try {
          const result = await workspace.pollTerminalSession(job.id, job.cursor)
          const session = result.session
          setTerminalCwd(result.cwd || terminalCwd)
          if (session?.output) appendTerminal([{ type: "output", text: session.output }])
          if (session?.running) nextJobs.push({ ...job, cursor: Number(session.nextCursor || job.cursor) })
          else appendTerminal([{ type: session?.exitCode === 0 ? "success" : "error", text: terminalExitText(session || {}) }])
        } catch (error) {
          appendTerminal([{ type: "error", text: error.message || String(error) }])
        }
      }
      if (!cancelled) {
        setTerminalJobs(nextJobs)
        if (!nextJobs.length) await workspace.refresh().catch(() => {})
        else timer = window.setTimeout(tick, 450)
      }
    }
    timer = window.setTimeout(tick, 250)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [terminalJobs, workspace.terminalRuntimeAvailable, workspace.pollTerminalSession, workspace.refresh])

  const stopLatestTerminalJob = async () => {
    const job = terminalJobs[terminalJobs.length - 1]
    if (!job) return
    try {
      await workspace.stopTerminalSession(job.id)
      appendTerminal([{ type: "system", text: `Encerrando processo: ${job.command}` }])
    } catch (error) {
      appendTerminal([{ type: "error", text: error.message || String(error) }])
    }
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

  useEffect(() => {
    setSelectedChangePath("")
    setTerminalEntries([{ type: "system", text: workspace.terminalRuntimeAvailable ? "HOST RW conectado · Git, builds, scripts e aplicações executam no workspace físico" : "Terminal seguro do navegador · conecte o projeto como HOST RW para executar comandos reais" }])
    setTerminalJobs([])
    setTerminalCwd("")
  }, [workspace.activeProjectId, workspace.terminalRuntimeAvailable])

  return (
    <section className="ide-workbench">
      {resizeHandle}
      <header className="ide-workbench-tabs">
        <button className={activePanel === "problems" ? "active" : ""} onClick={() => onPanelChange("problems")}>Problems <span>{analysis.diagnostics.length}</span></button>
        <button className={activePanel === "outline" ? "active" : ""} onClick={() => onPanelChange("outline")}>Outline <span>{analysis.symbols.length}</span></button>
        <button className={activePanel === "changes" ? "active" : ""} onClick={() => onPanelChange("changes")}>Changes <span>{changes.length}</span></button>
        <button className={activePanel === "terminal" ? "active" : ""} onClick={() => onPanelChange("terminal")}>Terminal {workspace.terminalRuntimeAvailable ? <span className="terminal-live-badge">HOST</span> : null}</button>
        <div className="ide-workbench-branch">{workspace.gitRepository ? <><i>⑂</i><strong>{workspace.gitBranch || workspace.gitHeadShort || "Git"}</strong>{workspace.gitHeadShort ? <span>{workspace.gitHeadShort}</span> : null}</> : <span>sem Git</span>}</div>
        {activePanel === "terminal" && terminalJobs.length ? <button className="ide-terminal-stop" onClick={stopLatestTerminalJob}>■ Parar {terminalJobs.length > 1 ? terminalJobs.length : ""}</button> : null}
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
            {changes.map(change => <button key={change.path} className={selectedChange?.path === change.path ? "active" : ""} onClick={() => setSelectedChangePath(change.path)} onDoubleClick={() => workspace.openFile(change.path).catch(() => {})}><span className={`change-status status-${statusLetter(change).toLowerCase()}`}>{statusLetter(change)}</span><strong>{change.path.split("/").pop()}</strong><small>{change.gitStatus ? `${change.gitStatus} · ` : ""}{change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "/"}</small></button>)}
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

      {activePanel === "terminal" ? (
        <div className={`ide-terminal-panel${workspace.terminalRuntimeAvailable ? " runtime" : " browser"}`}>
          <div className="ide-terminal-mode"><i /> <strong>{workspace.terminalRuntimeAvailable ? "Terminal real · HOST RW" : "Terminal limitado · Browser Workspace"}</strong><span>{workspace.terminalRuntimeAvailable ? "Comandos executam no projeto físico da máquina." : "Git real e execução de aplicações exigem Workspace Runtime."}</span></div>
          <div className="ide-terminal-output">
            {terminalEntries.map((entry, index) => <pre key={`${index}:${entry.text.slice(0, 16)}`} className={`terminal-${entry.type}`}>{entry.text}</pre>)}
            <span ref={terminalEndRef} />
          </div>
          <div className="ide-terminal-input"><span>{terminalCwd ? `${workspace.rootName || "workspace"}/${terminalCwd}` : workspace.rootName || "workspace"}<i>:</i>{workspace.gitBranch || "local"}$</span><input ref={terminalInputRef} value={terminalInput} onChange={event => setTerminalInput(event.target.value)} onKeyDown={handleTerminalKeyDown} spellCheck="false" autoComplete="off" placeholder={workspace.terminalRuntimeAvailable ? "git status, npm run dev, go run ./cmd/api..." : "help"} /></div>
        </div>
      ) : null}
    </section>
  )
}
