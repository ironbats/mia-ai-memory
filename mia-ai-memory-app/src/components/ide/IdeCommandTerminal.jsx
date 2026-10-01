import React, { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { createTerminalController, MAX_TERMINAL_TABS } from "../../lib/terminalController.js"
import { runBrowserCommand } from "../../lib/browserTerminal.js"

export default function IdeTerminal({ workspace, analysis, visible }) {
  const controllers = useRef(new Map())
  const scope = `${workspace.activeProjectId || 'none'}:${workspace.runtimeWorkspaceId || 'browser'}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  if (!controllers.current.has(scope)) controllers.current.set(scope, createTerminalController())
  const controller = controllers.current.get(scope)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const active = state.tabs.find(tab => tab.id === state.activeId)
  const inputRef = useRef(null)
  const outputRef = useRef(null)
  const followOutput = useRef(true)
  const scrollPositions = useRef(new Map())
  const [unread, setUnread] = useState(false)
  const [wrap, setWrap] = useState(true)

  useEffect(() => {
    const stores = controllers.current
    stores.forEach(store => store.resume())
    return () => stores.forEach(store => store.dispose())
  }, [])

  useEffect(() => {
    if (!visible) return
    const output = outputRef.current
    const saved = scrollPositions.current.get(`${scope}:${state.activeId}`)
    followOutput.current = saved?.follow ?? true
    if (output) output.scrollTop = followOutput.current ? output.scrollHeight : saved?.top || 0
    setUnread(false)
    inputRef.current?.focus()
  }, [scope, state.activeId, visible])

  useEffect(() => {
    if (!visible) return
    const output = outputRef.current
    if (followOutput.current && output) output.scrollTop = output.scrollHeight
    else setUnread(true)
  }, [active?.entries, visible])

  const transitioning = Boolean(workspace.projectSwitching || !workspace.isReady)
  const adapter = {
    rootName: workspace.rootName,
    execute: command => transitioning
      ? Promise.reject(new Error("Aguarde a troca de projeto antes de executar comandos."))
      : workspace.terminalRuntimeAvailable
      ? workspace.executeTerminalCommand(command)
      : runBrowserCommand(command, workspace, analysis).then(entries => ({ entries: entries.map(entry => ({ ...entry, text: `${entry.text}\n` })) })),
    poll: workspace.pollTerminalSession,
    stop: workspace.stopTerminalSession,
    refresh: () => { if (scopeRef.current === scope) return workspace.refresh().catch(() => {}) }
  }
  const focus = () => inputRef.current?.focus()
  const clear = () => { controller.clear(active.id); focus() }
  const selectRelative = direction => {
    const index = state.tabs.findIndex(tab => tab.id === state.activeId)
    controller.select(state.tabs[(index + direction + state.tabs.length) % state.tabs.length].id)
  }
  const keyDown = event => {
    if (event.isComposing) return
    const primary = event.ctrlKey || event.metaKey
    if (primary && event.key.toLowerCase() === 'l') { event.preventDefault(); clear() }
    else if (primary && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString() && inputRef.current?.selectionStart === inputRef.current?.selectionEnd) {
      event.preventDefault()
      if (active.busy) controller.stop(active.id)
      else controller.input(active.id, '')
    } else if (primary && event.shiftKey && event.code === 'Backquote') { event.preventDefault(); if (!transitioning) controller.create() }
    else if (primary && event.key === 'PageUp') { event.preventDefault(); selectRelative(-1) }
    else if (primary && event.key === 'PageDown') { event.preventDefault(); selectRelative(1) }
    else if (primary && event.key.toLowerCase() === 'w') { event.preventDefault(); controller.close(active.id) }
  }

  return <div className={`ide-terminal-panel command-console ${workspace.terminalRuntimeAvailable ? 'runtime' : 'browser'}`} hidden={!visible} onKeyDown={keyDown}>
    <div className="ide-terminal-toolbar">
      <div role="tablist" aria-label="Terminais do projeto" className="ide-terminal-tabs">
        {state.tabs.map(tab => <button key={tab.id} id={`tab-${scope}-${tab.id}`} role="tab" aria-selected={tab.id === active.id} aria-controls={`console-${scope}`} tabIndex={tab.id === active.id ? 0 : -1} onClick={() => controller.select(tab.id)} onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); selectRelative(event.key === 'ArrowLeft' ? -1 : 1)
          }
        }} title={`${tab.name} · ${tab.status}`}><span aria-hidden="true">{tab.busy ? '●' : '›_'}</span> {tab.name}</button>)}
      </div>
      <div className="ide-terminal-actions">
        <button onClick={() => controller.create()} disabled={transitioning || state.tabs.length >= MAX_TERMINAL_TABS} aria-label="Novo terminal" title="Novo terminal · Ctrl+Shift+`">＋</button>
        <button onClick={() => { setWrap(value => !value); focus() }} aria-pressed={wrap} aria-label="Quebra de linha" title="Alternar quebra de linha">↵</button>
        <button onClick={clear} aria-label="Limpar saída" title="Limpar saída · Ctrl+L">⌧</button>
        <button onClick={() => controller.stop(active.id)} disabled={!active.sessionId || active.stopping} aria-label="Parar processo" title="Parar processo · Ctrl+C">■</button>
        <button onClick={() => controller.close(active.id)} disabled={active.busy} aria-label="Fechar terminal" title={active.busy ? 'Pare o processo antes de fechar o terminal' : 'Fechar terminal · Ctrl+W'}>×</button>
      </div>
    </div>
    <div className="ide-terminal-mode" title={workspace.terminalRuntimeAvailable ? 'Cada comando abre um processo. Sem entrada interativa/PTY; cwd compartilhado entre as abas deste projeto. Comandos usam as permissões do usuário do host.' : 'Comandos locais limitados: help lista as opções. Nenhum shell do sistema.'}>
      <i /><strong>{workspace.terminalRuntimeAvailable ? 'HOST RW · comandos' : 'Browser · limitado'}</strong>
      <span>{workspace.terminalRuntimeAvailable ? 'Sem shell interativo · diretório compartilhado entre abas' : 'help para comandos disponíveis'}</span>
      <small role="status">{active.status}</small>
    </div>
    <div id={`console-${scope}`} role="tabpanel" aria-labelledby={`tab-${scope}-${active.id}`} className="ide-terminal-content">
      <div ref={outputRef} className={`ide-terminal-output${wrap ? '' : ' no-wrap'}`} tabIndex={0} aria-label="Saída do terminal" onScroll={event => {
        const node = event.currentTarget
        const follow = node.scrollHeight - node.scrollTop - node.clientHeight < 24
        followOutput.current = follow
        scrollPositions.current.set(`${scope}:${state.activeId}`, { top: node.scrollTop, follow })
        if (follow) setUnread(false)
      }}>
        {!active.entries.length ? <div className="ide-terminal-welcome">{workspace.terminalRuntimeAvailable ? 'Execute comandos no projeto físico. Use outra aba para um segundo processo.' : 'Terminal do navegador. Digite help para começar.'}</div> : null}
        <pre>{active.entries.map((entry, index) => <span key={index} className={`terminal-${entry.type}`}>{entry.text}</span>)}</pre>
      </div>
      {unread ? <button className="ide-terminal-follow" onClick={() => { followOutput.current = true; outputRef.current.scrollTop = outputRef.current.scrollHeight; setUnread(false) }}>Ir para saída recente ↓</button> : null}
    </div>
    <form className="ide-terminal-input" onSubmit={event => { event.preventDefault(); if (!transitioning) controller.run(active.id, adapter) }}>
      <span title={`${workspace.rootName || 'workspace'}/${state.cwd}`}>{workspace.rootName || 'workspace'}{state.cwd ? `/${state.cwd}` : ''}<i> $</i></span>
      <input ref={inputRef} aria-label="Comando do terminal" value={active.input} readOnly={active.busy || transitioning} onChange={event => controller.input(active.id, event.target.value)} onKeyDown={event => {
        if (event.isComposing || active.busy || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); controller.history(active.id, event.key === 'ArrowUp' ? -1 : 1) }
      }} spellCheck={false} autoComplete="off" autoCapitalize="off" placeholder={active.busy ? 'Processo em execução · Ctrl+C para parar' : workspace.terminalRuntimeAvailable ? 'git status, npm run dev…' : 'help'} />
      <button type="submit" disabled={transitioning || active.busy || !active.input.trim()} aria-label="Executar comando" title="Executar · Enter">↵</button>
    </form>
  </div>
}
