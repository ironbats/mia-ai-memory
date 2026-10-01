import './dom-environment.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountXtermSurface } from '../src/lib/xtermSurface.js'

function setup() {
  let terminal
  let search
  const viewport = []
  const host = document.createElement('div')
  class Terminal {
    constructor(options) {
      terminal = this
      this.options = options
      this.cols = 80
      this.rows = 24
      this.handlers = {}
      this.writes = []
      this.pasted = []
      this.disposeCount = 0
      this.buffer = { active: { viewportY: 0, baseY: 0 } }
      this.parser = { registerOscHandler: () => ({ dispose() {} }) }
    }
    loadAddon() {}
    open() {}
    focus() {}
    clear() { this.buffer.active.viewportY = this.buffer.active.baseY }
    dispose() { this.disposeCount++ }
    getSelection() { return '' }
    hasSelection() { return false }
    onData(callback) { this.handlers.data = callback; return { dispose() {} } }
    onResize(callback) { this.handlers.resize = callback; return { dispose() {} } }
    onSelectionChange(callback) { this.handlers.selection = callback; return { dispose() {} } }
    onScroll(callback) { this.handlers.scroll = callback; return { dispose() {} } }
    attachCustomKeyEventHandler(callback) { this.key = callback }
    write(data, callback) { this.writes.push({ data, callback }) }
    paste(text) { this.pasted.push(text) }
    scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY; this.handlers.scroll() }
    resize(cols, rows) { this.cols = cols; this.rows = rows; this.handlers.resize({ cols, rows }) }
  }
  class FitAddon { proposeDimensions() { return { cols: 1000, rows: 1000 } } }
  class SearchAddon {
    constructor() { search = this; this.cleared = 0 }
    clearDecorations() { this.cleared++ }
    findNext() { return true }
    findPrevious() { return true }
  }
  const surface = mountXtermSurface(host, {
    onData() {}, onResize() {}, onFind() {}, onNew() {}, onClear() {}, onCopy() {}, onRelative() {},
    onViewport: value => viewport.push(value)
  }, { Terminal, FitAddon, SearchAddon })
  return { surface, terminal, search, host, viewport }
}

test('viewport reports unread output without moving the user and clears it at the bottom', async () => {
  const { surface, terminal, viewport } = setup()
  try {
    terminal.buffer.active = { viewportY: 2, baseY: 20 }
    terminal.handlers.scroll()
    assert.deepEqual(viewport.at(-1), { atBottom: false, unread: false })
    const writing = surface.write('new output')
    terminal.writes[0].callback()
    await writing
    assert.equal(terminal.buffer.active.viewportY, 2)
    assert.deepEqual(viewport.at(-1), { atBottom: false, unread: true })
    const count = viewport.length
    terminal.handlers.scroll()
    assert.equal(viewport.length, count)
    surface.scrollToBottom()
    assert.equal(terminal.buffer.active.viewportY, 20)
    assert.deepEqual(viewport.at(-1), { atBottom: true, unread: false })
  } finally { surface.dispose() }
})

test('historical replay does not mark output unread and blocks physical typing', async () => {
  const { surface, terminal, viewport, host } = setup()
  try {
    surface.enableInput(true)
    terminal.buffer.active = { viewportY: 0, baseY: 10 }
    const writing = surface.write('history', { replay: true })
    let prevented = false
    assert.equal(terminal.key({ type: 'keydown', key: 'a', preventDefault() { prevented = true } }), false)
    assert.equal(prevented, true)
    const event = new window.Event('paste', { bubbles: true, cancelable: true })
    host.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
    terminal.writes[0].callback()
    await writing
    assert.deepEqual(viewport.at(-1), { atBottom: false, unread: false })
    assert.equal(terminal.key({ type: 'keydown', key: 'a', preventDefault() {} }), true)
  } finally { surface.dispose() }
})

test('paste is delegated intact to xterm only when input is enabled and not replaying', async () => {
  const { surface, terminal } = setup()
  const text = 'echo one\necho two\n'
  try {
    assert.equal(surface.paste(text), false)
    surface.enableInput(true)
    assert.equal(surface.paste(text), true)
    assert.deepEqual(terminal.pasted, [text])
    const writing = surface.write('history', { replay: true })
    assert.equal(surface.paste('blocked'), false)
    terminal.writes[0].callback()
    await writing
    assert.equal(surface.paste(''), false)
    surface.enableInput(false)
    assert.equal(surface.paste('hidden'), false)
    surface.dispose()
    assert.equal(surface.paste('disposed'), false)
    assert.deepEqual(terminal.pasted, [text])
  } finally { surface.dispose() }
  assert.equal(terminal.disposeCount, 1)
})

test('search cleanup and bounded fitting preserve renderer contracts', () => {
  const { surface, terminal, search, host } = setup()
  try {
    assert.equal(surface.find('match', false), true)
    assert.equal(surface.find('', false), false)
    assert.equal(search.cleared, 1)
    surface.clearFind()
    assert.equal(search.cleared, 2)
    assert.deepEqual(surface.fit(), { cols: 80, rows: 24 })
    Object.defineProperty(host, 'clientWidth', { value: 1000 })
    Object.defineProperty(host, 'clientHeight', { value: 1000 })
    assert.deepEqual(surface.fit(), { cols: 500, rows: 300 })
    assert.equal(terminal.cols, 500)
    surface.dispose()
    assert.equal(surface.find('match', false), false)
  } finally { surface.dispose() }
})
