// Command consoles, not persistent shells. Runtime cwd is shared by this workspace.
export const MAX_TERMINAL_TABS = 8
const MAX_OUTPUT = 160000
export const appendOutput = (previous, entries) => {
  const next = [...previous, ...entries.map(entry => ({ ...entry, text: String(entry.text ?? '').slice(-MAX_OUTPUT) }))]
  let size = 0
  return next.reverse().filter(entry => { size += entry.text.length; return size <= MAX_OUTPUT }).reverse().slice(-600)
}
export const exitEntry = session => ({ type: session.exitCode === 0 ? 'success' : 'error', text: `\nProcesso finalizado: ${session.exitCode ?? '?'}${session.signal ? ` · ${session.signal}` : ''}\n` })
export const navigateHistory = (history, index, draft, value, direction) => {
  if (!history.length) return { index: -1, draft, value }
  const savedDraft = index === -1 ? value : draft
  const next = direction < 0 ? (index < 0 ? history.length - 1 : Math.max(0, index - 1)) : (index < 0 ? -1 : index + 1 >= history.length ? -1 : index + 1)
  return { index: next, draft: savedDraft, value: next < 0 ? savedDraft : history[next] }
}

export function createTerminalController({ schedule = setTimeout, cancel = clearTimeout } = {}) {
  let serial = 0
  let disposed = false
  let state = { tabs: [], activeId: '', cwd: '' }
  const listeners = new Set()
  const timers = new Map()
  const jobs = new Map()
  const publish = next => { if (!disposed) { state = next; listeners.forEach(listener => listener()) } }
  const update = (id, change) => publish({ ...state, tabs: state.tabs.map(tab => tab.id === id ? { ...tab, ...change(tab) } : tab) })
  const append = (id, entries) => update(id, tab => ({ entries: appendOutput(tab.entries, entries) }))
  const create = () => {
    if (disposed || state.tabs.length >= MAX_TERMINAL_TABS) return
    const id = `terminal-${++serial}`
    publish({ ...state, activeId: id, tabs: [...state.tabs, { id, name: `Terminal ${serial}`, entries: [], input: '', history: [], historyIndex: -1, draft: '', busy: false, stopping: false, sessionId: '', status: 'Pronto' }] })
  }
  const poll = (id, job) => {
    timers.set(id, schedule(async () => {
      timers.delete(id)
      if (disposed || jobs.get(id) !== job) return
      try {
        const result = await job.adapter.poll(job.sessionId, job.cursor)
        if (disposed || jobs.get(id) !== job) return
        const session = result.session
        if (!session) throw new Error('Resposta do runtime sem sessão.')
        if (session.truncated) append(id, [{ type: 'system', text: '\nParte da saída anterior expirou no buffer do runtime.\n' }])
        if (session.output) append(id, [{ type: 'output', text: session.output }])
        job.cursor = session.nextCursor ?? job.cursor
        update(id, () => ({ status: session.running ? 'Executando' : `Saída ${session.exitCode ?? '?'}` }))
        if (session.running) poll(id, job)
        else {
          jobs.delete(id)
          append(id, [exitEntry(session)])
          update(id, () => ({ busy: false, stopping: false, sessionId: '' }))
          Promise.resolve().then(() => job.adapter.refresh?.()).catch(() => {})
        }
      } catch (error) {
        if (disposed || jobs.get(id) !== job) return
        if (error.status === 404 || error.code === 'TERMINAL_NOT_FOUND') {
          jobs.delete(id)
          append(id, [{ type: 'error', text: '\nSessão não encontrada no runtime. O processo pode ter sido encerrado ou o runtime reiniciado.\n' }])
          update(id, () => ({ busy: false, stopping: false, sessionId: '', status: 'Sessão perdida' }))
          return
        }
        update(id, () => ({ status: 'Reconectando…' }))
        // Preserve the cursor and process handle; a transient network error is not exit.
        poll(id, job)
      }
    }, 600))
  }
  const run = async (id, adapter) => {
    const tab = state.tabs.find(tab => tab.id === id)
    const command = tab?.input.trim()
    if (disposed || !command || tab.busy) return
    update(id, current => ({ input: '', draft: '', historyIndex: -1, history: [...current.history.filter(item => item !== command), command].slice(-120) }))
    if (command === 'clear') { update(id, () => ({ entries: [] })); return }
    append(id, [{ type: 'command', text: `${adapter.rootName || 'workspace'}${state.cwd ? `/${state.cwd}` : ''}$ ${command}\n` }])
    update(id, () => ({ busy: true, status: 'Iniciando…' }))
    try {
      const result = await adapter.execute(command)
      if (disposed) return
      if (result.entries) {
        append(id, result.entries)
        update(id, () => ({ busy: false, status: 'Pronto' }))
        return
      }
      const session = result.session
      if (!session) throw new Error('Resposta do runtime sem sessão.')
      publish({ ...state, cwd: result.cwd ?? state.cwd })
      if (session.output) append(id, [{ type: 'output', text: session.output }])
      if (session.running) {
        const job = { adapter, sessionId: session.id, cursor: session.nextCursor ?? 0 }
        jobs.set(id, job)
        update(id, () => ({ sessionId: session.id, status: 'Executando' }))
        poll(id, job)
      } else {
        if (!session.builtin) append(id, [exitEntry(session)])
        update(id, () => ({ busy: false, status: session.builtin ? 'Pronto' : `Saída ${session.exitCode ?? '?'}` }))
        Promise.resolve().then(() => adapter.refresh?.()).catch(() => {})
      }
    } catch (error) {
      append(id, [{ type: 'error', text: `${error.message || error}\n` }])
      update(id, () => ({ busy: false, status: 'Erro' }))
    }
  }
  create()
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    create,
    select: id => { if (state.tabs.some(tab => tab.id === id)) publish({ ...state, activeId: id }) },
    input: (id, input) => update(id, () => ({ input, historyIndex: -1, draft: input })),
    history: (id, direction) => update(id, tab => {
      const next = navigateHistory(tab.history, tab.historyIndex, tab.draft, tab.input, direction)
      return { historyIndex: next.index, draft: next.draft, input: next.value }
    }),
    clear: id => update(id, () => ({ entries: [] })),
    close: id => {
      if (state.tabs.find(tab => tab.id === id)?.busy) return false
      const tabs = state.tabs.filter(tab => tab.id !== id)
      publish({ ...state, tabs, activeId: state.activeId === id ? tabs.at(-1)?.id || '' : state.activeId })
      if (!tabs.length) create()
      return true
    },
    run,
    stop: async id => {
      const job = jobs.get(id)
      if (!job || disposed || state.tabs.find(tab => tab.id === id)?.stopping) return
      update(id, () => ({ stopping: true }))
      try {
        const stopped = await job.adapter.stop(job.sessionId)
        if (disposed || jobs.get(id) !== job) return
        if (!stopped) throw new Error('O runtime não confirmou a interrupção. Acompanhando o processo.')
        update(id, () => ({ status: 'Encerrando…' }))
      } catch (error) {
        if (disposed || jobs.get(id) !== job) return
        append(id, [{ type: 'error', text: `${error.message || error}\n` }])
        update(id, () => ({ stopping: false }))
      }
    },
    resume: () => { disposed = false },
    dispose: () => { disposed = true; timers.forEach(cancel); timers.clear(); jobs.clear(); listeners.clear() }
  }
}
