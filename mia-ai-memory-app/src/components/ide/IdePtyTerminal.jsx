import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPtyTerminalController, MAX_PTY_TABS, MAX_PTY_INPUT } from '../../lib/ptyTerminalController.js'
import { createXtermSurface } from '../../lib/xtermSurface.js'

export function PtySurface({ controller, tab, visible, focused, inputEnabled, createSurface, surfaces, onFind, onNew, onClear, onCopy, onRelative, onFocus, onSelection }) {
  const hostRef = useRef(null)
  const current = useRef(null)
  current.current = { visible, focused, inputEnabled, onFind, onNew, onClear, onCopy, onRelative, onSelection }
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [viewport, setViewport] = useState({ atBottom: true, unread: false })
  useEffect(() => {
    let disposed = false
    let surface
    let unsubscribe
    let observer
    let resizeTimer
    setError('')
    setReady(false)
    const fit = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (disposed || !surface || !current.current.visible) return
        const size = surface.fit()
        if (current.current.inputEnabled) controller.resize(tab.id, size.cols, size.rows)
      }, 40)
    }
    Promise.resolve().then(() => {
      if (disposed) return null
      return createSurface(hostRef.current, {
        onData: (data, options = {}) => { if (!disposed && (current.current.inputEnabled || options.protocol)) controller.write(tab.id, data, options) },
        onResize: ({ cols, rows }) => { if (!disposed && current.current.inputEnabled) controller.resize(tab.id, cols, rows) },
        onFind: () => current.current.onFind(), onNew: () => current.current.onNew(), onClear: () => current.current.onClear(),
        onCopy: () => current.current.onCopy(), onRelative: direction => current.current.onRelative(direction),
        onSelection: selected => { if (!disposed) current.current.onSelection(selected) },
        onViewport: value => { if (!disposed) setViewport(value) }
      })
    }).then(created => {
      if (!created) return
      if (disposed) { created.dispose(); return }
      surface = created
      surfaces.current.set(tab.id, created)
      surface.enableInput(current.current.inputEnabled)
      unsubscribe = controller.onOutput(tab.id, (data, options) => surface.write(data, options))
      if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(fit); observer.observe(hostRef.current) }
      window.addEventListener('resize', fit)
      setReady(true)
      fit()
      if (current.current.visible && current.current.focused) surface.focus()
    }).catch(error => {
      if (disposed) return
      unsubscribe?.()
      observer?.disconnect()
      window.removeEventListener('resize', fit)
      clearTimeout(resizeTimer)
      if (surfaces.current.get(tab.id) === surface) surfaces.current.delete(tab.id)
      surface?.dispose()
      surface = null
      setError(error.message || String(error))
    })
    return () => {
      disposed = true; clearTimeout(resizeTimer); observer?.disconnect(); window.removeEventListener('resize', fit)
      unsubscribe?.()
      if (surfaces.current.get(tab.id) === surface) surfaces.current.delete(tab.id)
      surface?.dispose()
    }
  }, [controller, tab.id, createSurface, surfaces, attempt])
  useEffect(() => {
    const surface = surfaces.current.get(tab.id)
    if (!surface) return
    surface.enableInput(inputEnabled)
    if (visible) {
      const size = surface.fit()
      if (inputEnabled) controller.resize(tab.id, size.cols, size.rows)
      if (focused) surface.focus()
    }
  }, [visible, focused, inputEnabled, tab.id, controller, surfaces, ready])
  return <div className={`ide-pty-pane${focused ? ' focused' : ''}`} hidden={!visible} onFocusCapture={onFocus}>
    <div className="ide-pty-surface" ref={hostRef} aria-label={`Terminal interativo ${tab.name}`} onPointerDown={onFocus} />
    {!error && !viewport.atBottom ? <button className="ide-pty-follow" onClick={() => { const surface = surfaces.current.get(tab.id); surface?.scrollToBottom?.(); surface?.focus() }}>{viewport.unread ? 'Nova saída disponível' : 'Ir para o final'} ↓</button> : null}
    {error ? <div role="alert" className="ide-pty-render-error"><strong>Não foi possível abrir a interface do terminal</strong><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Tentar novamente</button></div> : null}
  </div>
}

function ScopedPtyTerminal({ workspace, visible, createSurface }) {
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [controller] = useState(() => createPtyTerminalController({
    list: () => workspaceRef.current.listPtyTerminals(),
    create: options => workspaceRef.current.createPtyTerminal(options),
    poll: (id, cursor, options) => workspaceRef.current.pollPtyTerminal(id, cursor, options),
    write: (id, data) => workspaceRef.current.writePtyTerminal(id, data),
    resize: (id, cols, rows) => workspaceRef.current.resizePtyTerminal(id, cols, rows),
    close: id => workspaceRef.current.closePtyTerminal(id),
    refresh: () => workspaceRef.current.refresh?.()
  }))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const active = state.tabs.find(tab => tab.id === state.activeId)
  const surfaces = useRef(new Map())
  const tabButtons = useRef(new Map())
  const findRef = useRef(null)
  const renameRef = useRef(null)
  const pasteCancelRef = useRef(null)
  const [splitId, setSplitId] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [find, setFind] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [found, setFound] = useState(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState(false)
  const [pendingPaste, setPendingPaste] = useState(null)
  const pasteRequest = useRef(0)
  const transitioning = Boolean(workspace.projectSwitching || !workspace.isReady)
  const enabled = visible && !transitioning
  const canWrite = enabled && Boolean(active?.running && !active?.closing)
  const live = useRef(null)
  live.current = { activeId: state.activeId, canWrite }
  useEffect(() => { controller.attach(); return () => { pasteRequest.current++; controller.detach() } }, [controller])
  useEffect(() => { controller.setEnabled(enabled) }, [controller, enabled])
  useEffect(() => { if (findOpen) findRef.current?.focus() }, [findOpen])
  useEffect(() => { if (renaming) { renameRef.current?.focus(); renameRef.current?.select() } }, [renaming])
  useEffect(() => { if (pendingPaste) pasteCancelRef.current?.focus() }, [pendingPaste])
  useEffect(() => {
    setSelected(Boolean(surfaces.current.get(state.activeId)?.selection()))
    setNotice(''); setRenaming(false); setPendingPaste(null); pasteRequest.current++
  }, [state.activeId])
  useEffect(() => {
    if (!canWrite) { setPendingPaste(null); pasteRequest.current++ }
  }, [canWrite])
  useEffect(() => {
    if (splitId && (splitId === state.activeId || !state.tabs.some(tab => tab.id === splitId))) setSplitId('')
  }, [splitId, state.activeId, state.tabs])
  const focus = () => surfaces.current.get(state.activeId)?.focus()
  const clear = () => { if (active) { controller.clear(active.id); surfaces.current.get(active.id)?.clear(); focus() } }
  const search = (previous = false, incremental = false) => setFound(surfaces.current.get(state.activeId)?.find(find, previous, { caseSensitive, incremental }) || false)
  useEffect(() => {
    const surface = surfaces.current.get(state.activeId)
    if (findOpen && find) setFound(surface?.find(find, false, { caseSensitive, incremental: true }) || false)
    else { surface?.clearFind(); setFound(null) }
    return () => surface?.clearFind()
  }, [find, caseSensitive, state.activeId, findOpen])
  const openFind = () => { setRenaming(false); setPendingPaste(null); setFindOpen(true); findRef.current?.focus() }
  const closeFind = () => { setFindOpen(false); surfaces.current.get(state.activeId)?.clearFind(); focus() }
  const copy = async () => {
    const id = state.activeId
    const text = surfaces.current.get(id)?.selection()
    if (!text) { setNotice('Selecione texto no terminal para copiar.'); return }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Use Ctrl+C ou ⌘C com o texto selecionado.')
      await navigator.clipboard.writeText(text)
      if (live.current.activeId === id) setNotice('Seleção copiada.')
    } catch (error) { if (live.current.activeId === id) setNotice(error.message || 'Use o atalho Copiar do navegador.') }
  }
  const sendPaste = (id, text) => {
    if (!live.current.canWrite || live.current.activeId !== id) return
    const pasted = surfaces.current.get(id)?.paste?.(text)
    setNotice(pasted ? 'Texto enviado ao terminal.' : 'Terminal ocupado. Aguarde e tente colar novamente.')
    setPendingPaste(null)
    focus()
  }
  const paste = async () => {
    if (!canWrite) return
    const id = state.activeId
    const request = ++pasteRequest.current
    try {
      if (!navigator.clipboard?.readText) throw new Error('Colagem indisponível neste navegador. Use Ctrl+V ou ⌘V no terminal.')
      const text = await navigator.clipboard.readText()
      if (request !== pasteRequest.current || !live.current.canWrite || live.current.activeId !== id) return
      if (!text) { setNotice('A área de transferência está vazia.'); return }
      if (new TextEncoder().encode(text).length > MAX_PTY_INPUT - 32) { setNotice('Texto muito grande. Cole em partes menores que 64 KiB.'); return }
      if (/[\r\n]/.test(text)) {
        setFindOpen(false); setRenaming(false); setPendingPaste({ id, text })
      } else sendPaste(id, text)
    } catch (error) {
      if (request === pasteRequest.current && live.current.activeId === id) setNotice(error.message || 'Permissão de colagem negada. Use Ctrl+V ou ⌘V no terminal.')
    }
  }
  const companion = splitId && splitId !== state.activeId && state.tabs.some(tab => tab.id === splitId) ? splitId : ''
  const visibleIds = companion ? [state.activeId, companion] : [state.activeId]
  const select = (id, keyboard = false) => {
    if (companion && id === companion) setSplitId(state.activeId)
    controller.select(id)
    if (keyboard) tabButtons.current.get(id)?.focus()
  }
  const relative = (direction, keyboard = false) => {
    if (!state.tabs.length) return
    const index = state.tabs.findIndex(tab => tab.id === state.activeId)
    select(state.tabs[(index + direction + state.tabs.length) % state.tabs.length].id, keyboard)
  }
  const create = () => controller.create()
  const split = async () => {
    if (companion) { setSplitId(''); return }
    const previous = state.activeId
    if (!previous) return
    const existing = state.tabs.find(tab => tab.id !== previous)
    if (existing) setSplitId(existing.id)
    else {
      const id = await create()
      if (id && id !== previous) setSplitId(previous)
    }
  }
  const beginRename = tab => {
    select(tab.id); setFindOpen(false); setPendingPaste(null); setName(tab.name); setRenaming(true)
  }
  const saveName = () => { if (active && name.trim()) controller.rename(active.id, name); setRenaming(false); focus() }
  const cancelPaste = () => { setPendingPaste(null); focus() }
  const tabKey = (event, tab) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); relative(event.key === 'ArrowLeft' ? -1 : 1, true) }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); select((event.key === 'Home' ? state.tabs[0] : state.tabs.at(-1)).id, true) }
    else if (event.key === 'F2') { event.preventDefault(); beginRename(tab) }
    else if (event.key === 'Enter') { event.preventDefault(); focus() }
  }
  return <div className="ide-terminal-panel pty-console runtime" hidden={!visible} onKeyDown={event => {
    if (event.isComposing) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); openFind() }
    if (event.key === 'Escape' && (findOpen || renaming || pendingPaste)) {
      event.preventDefault(); event.stopPropagation()
      if (pendingPaste) cancelPaste()
      else if (renaming) { setRenaming(false); focus() }
      else closeFind()
    }
  }}>
    <div className="ide-terminal-toolbar">
      <div role="tablist" aria-label="Terminais interativos do projeto" className="ide-terminal-tabs">
        {state.tabs.map(tab => <button key={tab.id} ref={node => { if (node) tabButtons.current.set(tab.id, node); else tabButtons.current.delete(tab.id) }} id={`pty-tab-${tab.id}`} role="tab" aria-selected={tab.id === state.activeId} aria-controls={`pty-console-${tab.id}`} tabIndex={tab.id === state.activeId ? 0 : -1} title={`${tab.name} · ${tab.status} · F2 para renomear`} onClick={() => select(tab.id)} onDoubleClick={() => beginRename(tab)} onKeyDown={event => tabKey(event, tab)}><span aria-hidden="true" className={tab.running ? 'pty-running' : ''}>{tab.pending ? '◌' : tab.running ? '›_' : '○'}</span><span className="ide-pty-tab-name">{tab.name}</span>{tab.error ? <i aria-label="Erro">!</i> : null}</button>)}
      </div>
      <div className="ide-terminal-actions" role="group" aria-label="Ações do terminal">
        <button onClick={create} disabled={!enabled || state.loading || state.tabs.length >= MAX_PTY_TABS} aria-label="Novo terminal" title="Novo terminal · Ctrl+Shift+`">＋</button>
        <button onClick={split} disabled={!enabled || !active || active.pending} aria-label="Dividir terminal" aria-pressed={Boolean(companion)} title={companion ? 'Exibir um terminal' : 'Dividir terminal'}>◫</button>
        <button onClick={() => findOpen ? closeFind() : openFind()} disabled={!active} aria-label="Buscar no terminal" aria-expanded={findOpen} title="Buscar · Ctrl+F">⌕</button>
        <button onClick={copy} disabled={!active || !selected} aria-label="Copiar seleção" title="Copiar seleção · Ctrl+Shift+C">⧉</button>
        <button onClick={paste} disabled={!canWrite} aria-label="Colar no terminal" title="Colar texto da área de transferência">▣</button>
        <button onClick={clear} disabled={!active} aria-label="Limpar saída" title="Limpar saída · Ctrl+Shift+K">⌧</button>
        <button onClick={() => beginRename(active)} disabled={!active} aria-label="Renomear terminal" title="Renomear · F2">✎</button>
        <button onClick={() => controller.restart(active.id)} disabled={!enabled || !active || active.pending || active.closing} aria-label="Reiniciar terminal" title="Encerrar este shell e abrir outro">↻</button>
        <button onClick={() => controller.close(active.id)} disabled={!active || active.pending || active.closing || transitioning} aria-label="Encerrar terminal" title="Encerrar shell e processos desta aba">⌫</button>
      </div>
    </div>
    <div className="ide-terminal-mode" title="Shell interativo no host, com as permissões do usuário do runtime. Cada aba tem seu próprio shell e diretório. Fechar o painel mantém os processos; encerrar a aba os termina.">
      <i /><strong>HOST RW · PTY</strong><span title={active?.cwd || workspace.rootName}>{active?.shell?.split(/[\\/]/).pop() || 'shell'} · {workspace.rootName || 'workspace'} · diretório independente</span>
      <small role="status">{transitioning ? 'Aguardando projeto…' : active?.status || (state.loading ? 'Conectando…' : 'Sem terminais')}</small>
    </div>
    <div className={`ide-pty-content${companion ? ' split' : ''}`}>
      {state.tabs.map(tab => <div key={tab.id} id={`pty-console-${tab.id}`} role="tabpanel" aria-labelledby={`pty-tab-${tab.id}`} className="ide-pty-slot" hidden={!visibleIds.includes(tab.id)}>
        {companion ? <button className={`ide-pty-pane-title${tab.id === state.activeId ? ' active' : ''}`} onClick={() => select(tab.id)}>{tab.name}<span>{tab.status}</span></button> : null}
        <PtySurface controller={controller} tab={tab} visible={visible && visibleIds.includes(tab.id)} focused={visible && tab.id === state.activeId && !findOpen && !renaming && !pendingPaste} inputEnabled={enabled && visibleIds.includes(tab.id) && tab.running && !tab.closing && !pendingPaste} createSurface={createSurface} surfaces={surfaces} onFocus={() => { if (state.activeId !== tab.id) select(tab.id) }} onFind={openFind} onNew={create} onClear={clear} onCopy={copy} onRelative={relative} onSelection={value => { if (tab.id === state.activeId) setSelected(value) }} />
      </div>)}
      {!state.tabs.length ? <div className="ide-pty-empty"><span aria-hidden="true">›_</span><strong>{state.loading ? 'Conectando ao shell…' : 'Terminal interativo'}</strong><p>{state.error || 'Abra um shell para executar comandos, servidores e ferramentas interativas neste projeto.'}</p><button onClick={state.error ? () => controller.reconnect() : create} disabled={!enabled || state.loading}>{state.error ? 'Reconectar' : 'Novo terminal'}</button></div> : null}
      {findOpen ? <form className="ide-pty-find" onSubmit={event => { event.preventDefault(); search() }} aria-label="Busca no terminal"><input ref={findRef} aria-label="Texto para buscar no terminal" value={find} onChange={event => setFind(event.target.value)} placeholder="Buscar no terminal" onKeyDown={event => { if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); search(true) } }} /><span role="status">{find && found === false ? 'Sem resultados' : ''}</span><button type="button" onClick={() => setCaseSensitive(value => !value)} aria-label="Diferenciar maiúsculas" aria-pressed={caseSensitive} title="Diferenciar maiúsculas">Aa</button><button type="button" onClick={() => search(true)} disabled={!find} aria-label="Resultado anterior" title="Anterior · Shift+Enter">↑</button><button type="submit" disabled={!find} aria-label="Próximo resultado" title="Próximo · Enter">↓</button><button type="button" onClick={closeFind} aria-label="Fechar busca" title="Fechar · Esc">×</button></form> : null}
      {renaming ? <form className="ide-pty-rename" onSubmit={event => { event.preventDefault(); saveName() }}><label htmlFor="pty-name">Nome do terminal</label><input id="pty-name" ref={renameRef} value={name} maxLength={48} onChange={event => setName(event.target.value)} /><button type="submit" disabled={!name.trim()}>Salvar</button><button type="button" onClick={() => { setRenaming(false); focus() }}>Cancelar</button></form> : null}
      {pendingPaste ? <form className="ide-pty-paste-confirm" aria-label="Confirmar colagem multilinha" onSubmit={event => {
        event.preventDefault()
        const payload = pendingPaste
        setPendingPaste(null)
        const surface = surfaces.current.get(payload.id)
        if (live.current.canWrite && live.current.activeId === payload.id) {
          surface?.enableInput(true)
          sendPaste(payload.id, payload.text)
        }
      }}><strong>Colar várias linhas?</strong><p>O shell pode executar comandos ao receber quebras de linha. Confira o conteúdo antes de continuar.</p><pre>{pendingPaste.text.slice(0, 2000)}</pre>{pendingPaste.text.length > 2000 ? <small>Prévia limitada aos primeiros 2.000 caracteres.</small> : null}<div><button type="button" ref={pasteCancelRef} onClick={cancelPaste}>Cancelar</button><button type="submit" disabled={!canWrite}>Colar no shell</button></div></form> : null}
    </div>
    <div className={`ide-pty-footer${active?.error ? ' has-error' : ''}`}>
      {active?.error ? <><span role="alert" title={active.error}>{active.error}</span><button onClick={() => controller.dismissError(active.id)} aria-label="Dispensar erro">×</button></> : <span role="status" title={notice || active?.connectionError || active?.cwd || ''}>{notice || (active?.status === 'Reconectando…' ? active.connectionError : active?.cwd ? `Diretório inicial: ${active.cwd}` : 'Ctrl+C interrompe · com seleção, copia · Ctrl+V cola · Ctrl+F busca')}</span>}
      {(active?.status === 'Reconectando…' || (active?.running && active?.error)) ? <button onClick={() => controller.reconnect()} disabled={!enabled}>Reconectar</button> : null}
      {active && !active.running && !active.pending ? <button onClick={() => controller.restart(active.id)} disabled={!enabled || active.closing}>Reabrir shell</button> : null}
      <small title="Fechar o painel mantém os shells em execução">{state.tabs.length}/{MAX_PTY_TABS} shells</small>
    </div>
  </div>
}

export default function IdePtyTerminal({ workspace, visible, createSurface = createXtermSurface }) {
  const scope = JSON.stringify([workspace.activeProjectId || '', workspace.runtimeWorkspaceId || ''])
  return <ScopedPtyTerminal key={scope} workspace={workspace} visible={visible} createSurface={createSurface} />
}
