export const TERMINAL_THEME = {
  background: '#181818', foreground: '#cccccc', cursor: '#aeafad', cursorAccent: '#181818',
  selectionBackground: '#264f78', selectionInactiveBackground: '#3a3d41',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff'
}

export async function createXtermSurface(host, events) {
  const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([
    import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-search'), import('@xterm/xterm/css/xterm.css')
  ])
  return mountXtermSurface(host, events, { Terminal, FitAddon, SearchAddon })
}

export function mountXtermSurface(host, events, { Terminal, FitAddon, SearchAddon }) {
  const terminal = new Terminal({
    theme: TERMINAL_THEME, fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: 13, lineHeight: 1.2, cursorBlink: true, cursorStyle: 'block', scrollback: 5000,
    convertEol: false, disableStdin: true, screenReaderMode: true,
    linkHandler: { activate: () => {} }, windowOptions: {}
  })
  const fit = new FitAddon()
  const search = new SearchAddon({ highlightLimit: 500 })
  terminal.loadAddon(fit)
  terminal.loadAddon(search)
  terminal.open(host)
  let inputEnabled = false
  let replaying = false
  let disposed = false
  let writing = false
  let currentResolve
  let unread = false
  let viewportState = ''
  const writes = []
  const atBottom = () => {
    const buffer = terminal.buffer?.active
    return !buffer || buffer.viewportY >= buffer.baseY
  }
  const notifyViewport = (received = false) => {
    if (disposed) return
    const bottom = atBottom()
    if (bottom) unread = false
    else if (received) unread = true
    const next = `${bottom}:${unread}`
    if (next === viewportState) return
    viewportState = next
    events.onViewport?.({ atBottom: bottom, unread })
  }
  const drain = () => {
    if (writing || disposed || !writes.length) return
    const next = writes.shift()
    writing = true
    replaying = Boolean(next.replay)
    terminal.options.disableStdin = replaying
    currentResolve = next.resolve
    terminal.write(next.data, () => {
      writing = false; replaying = false; currentResolve = null
      if (!disposed) terminal.options.disableStdin = !inputEnabled
      notifyViewport(!next.replay)
      next.resolve(!disposed)
      drain()
    })
  }
  const disposables = [
    terminal.parser.registerOscHandler(52, () => true),
    terminal.onData(data => { if (!disposed && !replaying && (inputEnabled || writing)) events.onData(data, { protocol: writing }) }),
    terminal.onResize(size => events.onResize(size)),
    terminal.onSelectionChange(() => events.onSelection?.(terminal.hasSelection())),
    terminal.onScroll?.(() => notifyViewport())
  ].filter(Boolean)
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.isComposing) return true
    const key = event.key.toLowerCase()
    const primary = event.ctrlKey || event.metaKey
    if (event.ctrlKey && ((event.code === 'Backquote' && !event.shiftKey) || key === 'j' || (event.shiftKey && key === 'p'))) return false
    if (primary && key === 'f') { event.preventDefault(); events.onFind(); return false }
    if (event.ctrlKey && event.shiftKey && event.code === 'Backquote') { event.preventDefault(); events.onNew(); return false }
    if (primary && event.shiftKey && key === 'k') { event.preventDefault(); events.onClear(); return false }
    if (primary && event.shiftKey && key === 'c') { event.preventDefault(); events.onCopy(); return false }
    if (primary && key === 'c' && terminal.hasSelection()) return false
    if (primary && key === 'v') return false
    if (event.ctrlKey && (event.key === 'PageUp' || event.key === 'PageDown')) {
      event.preventDefault(); events.onRelative(event.key === 'PageUp' ? -1 : 1); return false
    }
    if (!inputEnabled || replaying) { event.preventDefault(); return false }
    return true
  })
  const inputEvents = ['keypress', 'beforeinput', 'input', 'paste', 'compositionstart', 'compositionupdate', 'compositionend']
  const blockInput = event => { if (!inputEnabled || replaying) { event.preventDefault(); event.stopImmediatePropagation() } }
  inputEvents.forEach(name => host.addEventListener(name, blockInput, true))
  return {
    write: (data, { replay = false } = {}) => new Promise(resolve => {
      if (disposed) { resolve(false); return }
      writes.push({ data, replay, resolve }); drain()
    }),
    focus: () => { if (!disposed) terminal.focus() },
    clear: () => { if (!disposed) { terminal.clear(); search.clearDecorations(); notifyViewport() } },
    selection: () => disposed ? '' : terminal.getSelection(),
    paste: text => {
      if (disposed || !inputEnabled || replaying || typeof text !== 'string' || !text) return false
      terminal.paste(text)
      return true
    },
    scrollToBottom: () => { if (!disposed) { terminal.scrollToBottom(); notifyViewport() } },
    enableInput: enabled => { if (!disposed) { inputEnabled = enabled; terminal.options.disableStdin = replaying || (!enabled && !writing) } },
    fit: () => {
      if (!disposed && host.clientWidth > 0 && host.clientHeight > 0) {
        const size = fit.proposeDimensions()
        if (size) terminal.resize(Math.min(500, Math.max(2, size.cols)), Math.min(300, Math.max(1, size.rows)))
      }
      return { cols: terminal.cols, rows: terminal.rows }
    },
    find: (term, previous, options = {}) => {
      if (disposed) return false
      return term ? search[previous ? 'findPrevious' : 'findNext'](term, { caseSensitive: options.caseSensitive, incremental: options.incremental }) : (search.clearDecorations(), false)
    },
    clearFind: () => { if (!disposed) search.clearDecorations() },
    dispose: () => {
      if (disposed) return
      disposed = true
      inputEvents.forEach(name => host.removeEventListener(name, blockInput, true))
      currentResolve?.(false)
      writes.splice(0).forEach(item => item.resolve(false))
      disposables.forEach(item => item.dispose())
      terminal.dispose()
    }
  }
}
