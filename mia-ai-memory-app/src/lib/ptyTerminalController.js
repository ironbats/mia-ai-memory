// A controller belongs to one immutable workspace scope. No terminal content is persisted.
export const MAX_PTY_TABS = 8
export const MAX_PTY_OUTPUT = 512000
export const MAX_PTY_INPUT = 65536
const message = error => error?.message || String(error)
const sessionOf = result => result?.session || result
const clientId = () => globalThis.crypto?.randomUUID?.() || `pty-${Date.now()}-${Math.random().toString(36).slice(2)}`
const utf8Size = value => new TextEncoder().encode(value).length
const isMissing = error => error.status === 404 || error.code === 'PTY_NOT_FOUND' || error.code === 'TERMINAL_NOT_FOUND'

export function createPtyTerminalController(adapter, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let attached = false
  let enabled = false
  let initialized = false
  let needsInitialShell = false
  let initializing = null
  let serial = 0
  let initAttempts = 0
  let initTimer
  let state = { tabs: [], activeId: '', loading: false, error: '' }
  const listeners = new Set()
  const resources = new Map()
  const publish = change => { state = { ...state, ...change }; listeners.forEach(listener => listener()) }
  const update = (id, change) => publish({ tabs: state.tabs.map(tab => tab.id === id ? { ...tab, ...change } : tab) })
  const tabFor = id => state.tabs.find(tab => tab.id === id)
  const resourceFor = id => {
    if (!resources.has(id)) resources.set(id, { outputParts: [], outputSize: 0, sinks: new Set(), cursor: 0, queue: [], queuedBytes: 0, failures: 0 })
    return resources.get(id)
  }
  const append = async (id, data, replay = false) => {
    if (!data) return
    const resource = resources.get(id)
    if (!resource || !tabFor(id)) return
    const part = { data, replay, delivered: false }
    resource.outputParts.push(part)
    resource.outputSize += data.length
    while (resource.outputSize > MAX_PTY_OUTPUT) {
      const first = resource.outputParts[0]
      const excess = resource.outputSize - MAX_PTY_OUTPUT
      if (first.data.length <= excess) { resource.outputSize -= first.data.length; resource.outputParts.shift() }
      else { first.data = first.data.slice(excess); resource.outputSize -= excess }
    }
    // Backpressure includes xterm's asynchronous parser, so hot output cannot queue forever.
    const parsed = await Promise.all([...resource.sinks].map(sink => sink(data, { replay })))
    if (parsed.some(result => result !== false)) part.delivered = true
  }
  const stopPoll = id => {
    const resource = resources.get(id)
    if (!resource) return
    cancel(resource.timer)
    resource.timer = null
    resource.poll?.abort()
    resource.poll = null
  }
  const refresh = () => Promise.resolve().then(() => adapter.refresh?.()).catch(() => {})
  const accept = async (id, session, owner) => {
    const resource = resources.get(id)
    const current = () => attached && resources.get(id) === resource && Boolean(tabFor(id)) && (!owner || resource.poll === owner)
    if (!resource || !current()) return
    const output = session.output || ''
    const outputStart = (session.nextCursor ?? resource.cursor + output.length) - output.length
    const replayLength = resource.replayUntil ? Math.min(output.length, Math.max(0, resource.replayUntil - outputStart)) : 0
    // Enqueue the complete response and claim its cursor atomically before yielding.
    // Reconnect waits for this renderer boundary and cannot replay a half-parsed chunk.
    resource.cursor = session.nextCursor ?? resource.cursor
    // Protocol replies from the first prompt need a usable session before parsing starts.
    update(id, { sessionId: session.id, shell: session.shell || '', cwd: session.cwd || '', running: Boolean(session.running), pending: false,
      cols: session.cols, rows: session.rows, exitCode: session.exitCode, signal: session.signal,
      connectionError: '', status: session.running ? 'Conectado' : `Encerrado · ${session.exitCode ?? session.signal ?? '?'}` })
    const chunks = []
    if (session.truncated) chunks.push(append(id, '\r\n\x1b[33m[Saída anterior expirou no buffer do runtime]\x1b[0m\r\n', true))
    if (replayLength) chunks.push(append(id, output.slice(0, replayLength), true))
    if (replayLength < output.length) chunks.push(append(id, output.slice(replayLength)))
    const rendering = Promise.all(chunks)
    resource.rendering = rendering
    await rendering
    if (resource.rendering === rendering) resource.rendering = null
    if (!current()) return
    if (!session.running && !resource.exited) {
      resource.exited = true
      await append(id, `\r\n\x1b[90m[Shell encerrado · ${session.exitCode ?? session.signal ?? '?'}]\x1b[0m\r\n`)
      refresh()
    }
  }
  const poll = (id, delay = 0) => {
    if (!attached || !tabFor(id)?.running) return
    const resource = resourceFor(id)
    if (resource.poll || resource.timer) return
    resource.timer = schedule(async () => {
      resource.timer = null
      if (!attached || !tabFor(id)?.running) return
      const abort = new AbortController()
      resource.poll = abort
      try {
        if (resource.rendering) await resource.rendering
        if (!attached || resource.poll !== abort || !tabFor(id)) return
        const result = await adapter.poll(tabFor(id).sessionId, resource.cursor, { signal: abort.signal })
        if (!attached || resource.poll !== abort || !tabFor(id)) return
        const session = sessionOf(result)
        if (!session?.id) throw new Error('O runtime não retornou a sessão do terminal.')
        resource.failures = 0
        await accept(id, session, abort)
        if (!attached || resource.poll !== abort || !tabFor(id)) return
        resource.poll = null
        if (session.running) poll(id, session.output ? 16 : 120)
      } catch (error) {
        if (!attached || resource.poll !== abort || !tabFor(id)) return
        resource.poll = null
        if (abort.signal.aborted) return
        if (isMissing(error)) {
          update(id, { running: false, status: 'Sessão perdida', error: 'O runtime perdeu esta sessão. Reinicie o terminal para abrir outro shell.' })
          return
        }
        update(id, { status: 'Reconectando…', connectionError: message(error) })
        poll(id, Math.min(15000, 500 * 2 ** Math.min(resource.failures++, 5)))
      }
    }, delay)
  }
  const create = async (options = {}) => {
    if (!attached || !enabled || state.tabs.length >= MAX_PTY_TABS) return null
    const id = clientId()
    const name = options.name || `Terminal ${++serial}`
    resourceFor(id)
    publish({ activeId: id, tabs: [...state.tabs, { id, clientId: id, name, pending: true, running: false, status: 'Abrindo shell…', error: '' }] })
    await start(id, options)
    return id
  }
  const start = async (id, options = {}) => {
    const resource = resourceFor(id)
    if (resource.creating || !enabled || !attached) return
    resource.creating = true
    update(id, { pending: true, error: '', status: 'Abrindo shell…' })
    try {
      const result = await adapter.create({ cols: options.cols || 80, rows: options.rows || 24, clientId: id })
      const session = sessionOf(result)
      if (!session?.id) throw new Error('O runtime não retornou a sessão criada.')
      if (!attached || !tabFor(id)) {
        // A replacement view may already have adopted this shell through list().
        // Leave it recoverable; the runtime's detached-session lease reaps true orphans.
        return
      }
      await accept(id, session)
      poll(id)
    } catch (error) {
      if (attached && tabFor(id)) update(id, { pending: false, status: 'Falha ao abrir', error: message(error) })
    } finally { resource.creating = false }
  }
  const initialize = async () => {
    if (!attached || !enabled || initialized || initializing) return initializing
    publish({ loading: true, error: '' })
    initializing = (async () => {
      try {
        const result = await adapter.list()
        if (!attached) return
        const sessions = result?.sessions || []
        const tabs = sessions.slice(0, MAX_PTY_TABS).map(session => ({ id: session.id, name: `Terminal ${++serial}`, sessionId: session.id, pending: false, running: Boolean(session.running), status: 'Reconectando…' }))
        publish({ tabs, activeId: tabs[0]?.id || '', loading: false })
        initialized = true
        initAttempts = 0
        // List is metadata only. Poll from zero once to recover the bounded runtime buffer.
        for (const tab of tabs) {
          resourceFor(tab.id).replayUntil = sessions.find(session => session.id === tab.id)?.nextCursor || 0
          if (tab.running) poll(tab.id)
          else {
            try {
              const result = await adapter.poll(tab.id, 0)
              if (attached && tabFor(tab.id)) await accept(tab.id, sessionOf(result))
            } catch (error) { if (attached) update(tab.id, { status: 'Sessão encerrada', error: message(error) }) }
          }
        }
        needsInitialShell = !tabs.length
        if (needsInitialShell && attached && enabled) { needsInitialShell = false; await create() }
      } catch (error) {
        if (!attached) return
        publish({ loading: false, error: `Não foi possível conectar ao terminal: ${message(error)}` })
        initTimer = schedule(() => { initTimer = null; initialize() }, Math.min(15000, 500 * 2 ** Math.min(initAttempts++, 5)))
      } finally { initializing = null }
    })()
    return initializing
  }
  const flush = async id => {
    const resource = resourceFor(id)
    if (resource.writing) return
    resource.writing = true
    while (attached && tabFor(id)?.running && resource.queue.length) {
      const data = resource.queue.shift()
      try {
        await adapter.write(tabFor(id).sessionId, data)
        resource.queuedBytes = Math.max(0, resource.queuedBytes - utf8Size(data))
      } catch (error) {
        resource.queue = []; resource.queuedBytes = 0
        if (attached && tabFor(id)) update(id, { error: `Entrada não confirmada: ${message(error)}. Nada foi reenviado; confira o shell antes de repetir.` })
        break
      }
    }
    if (!attached || !tabFor(id)?.running) { resource.queue = []; resource.queuedBytes = 0 }
    resource.writing = false
  }
  const close = async id => {
    const tab = tabFor(id)
    if (!attached || !tab || tab.pending || tab.closing) return false
    update(id, { closing: true, error: '' })
    try {
      if (tab.sessionId) {
        try { await adapter.close(tab.sessionId) }
        catch (error) { if (!isMissing(error)) throw error }
      }
      if (!attached || !tabFor(id)) return false
      stopPoll(id)
      resources.delete(id)
      const tabs = state.tabs.filter(item => item.id !== id)
      publish({ tabs, activeId: state.activeId === id ? tabs.at(-1)?.id || '' : state.activeId })
      refresh()
      return true
    } catch (error) {
      if (attached) update(id, { closing: false, error: `Não foi possível encerrar o shell: ${message(error)}` })
      return false
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    attach: () => { attached = true; state.tabs.forEach(tab => poll(tab.id)); if (enabled) initialize() },
    detach: () => { attached = false; cancel(initTimer); initTimer = null; resources.forEach((_, id) => stopPoll(id)) },
    setEnabled: value => {
      enabled = value
      if (value) {
        if (needsInitialShell && attached) { needsInitialShell = false; create() }
        else initialize()
      }
    },
    reconnect: () => {
      if (!attached || !enabled) return
      cancel(initTimer); initTimer = null
      if (!initialized) return initialize()
      state.tabs.forEach(tab => {
        if (tab.running) { stopPoll(tab.id); resourceFor(tab.id).failures = 0; poll(tab.id) }
      })
    },
    initialize,
    create,
    select: id => { if (tabFor(id)) publish({ activeId: id }) },
    rename: (id, name) => { const trimmed = name.trim().slice(0, 48); if (trimmed) update(id, { name: trimmed }) },
    onOutput: (id, sink) => {
      if (!tabFor(id)) return () => {}
      const resource = resourceFor(id)
      for (const part of resource.outputParts) {
        Promise.resolve(sink(part.data, { replay: part.replay || part.delivered })).then(parsed => { if (parsed !== false) part.delivered = true }).catch(() => {})
      }
      resource.sinks.add(sink)
      return () => resource.sinks.delete(sink)
    },
    clear: id => { const resource = resourceFor(id); resource.outputParts = []; resource.outputSize = 0 },
    dismissError: id => update(id, { error: '' }),
    write: (id, data, { protocol = false } = {}) => {
      const tab = tabFor(id)
      if (!attached || (!enabled && !protocol) || !tab?.running || tab.closing || !data) return false
      const resource = resourceFor(id)
      const size = utf8Size(data)
      if (resource.queuedBytes + size > MAX_PTY_INPUT) { update(id, { error: 'Entrada muito grande ou conexão lenta. Aguarde antes de colar novamente (limite de 64 KiB).' }); return false }
      resource.queuedBytes += size
      // Split on Unicode character boundaries to avoid corrupting emoji / non-BMP text.
      let chunk = ''
      for (const character of data) { chunk += character; if (chunk.length >= 4096) { resource.queue.push(chunk); chunk = '' } }
      if (chunk) resource.queue.push(chunk)
      flush(id)
      return true
    },
    resize: async (id, cols, rows) => {
      const tab = tabFor(id)
      if (!attached || !enabled || !tab?.running || tab.closing || cols < 2 || rows < 1) return
      const resource = resourceFor(id)
      resource.nextSize = { cols, rows }
      if (resource.resizing) return
      resource.resizing = true
      while (attached && tabFor(id)?.running && resource.nextSize) {
        const next = resource.nextSize; resource.nextSize = null
        if (resource.size?.cols === next.cols && resource.size?.rows === next.rows) continue
        try { await adapter.resize(tab.sessionId, next.cols, next.rows); resource.size = next }
        catch (error) { if (attached) update(id, { error: `Redimensionamento não confirmado: ${message(error)}` }); break }
      }
      resource.resizing = false
    },
    close,
    restart: async id => {
      const tab = tabFor(id)
      if (!enabled || !tab || tab.pending || tab.closing) return
      if (!tab.sessionId) return start(id)
      if (await close(id)) return create({ name: tab.name })
    }
  }
}
