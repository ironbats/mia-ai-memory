import './dom-environment.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountXtermSurface } from '../src/lib/xtermSurface.js'

function mockSurface() {
  let terminal
  class Terminal {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.writes = []; this.handlers = {}; this.parser = { registerOscHandler: (code, callback) => { this.osc = { code, callback }; return { dispose() {} } } }; terminal = this }
    loadAddon() {} open() {} focus() {} clear() {} dispose() { this.disposed = true }
    getSelection() { return this.selected ? 'selection' : '' } hasSelection() { return Boolean(this.selected) }
    onData(callback) { this.handlers.data = callback; return { dispose() {} } }
    onResize(callback) { this.handlers.resize = callback; return { dispose() {} } }
    onSelectionChange(callback) { this.handlers.selection = callback; return { dispose() {} } }
    attachCustomKeyEventHandler(callback) { this.key = callback }
    write(data, callback) { this.writes.push({ data, callback }) }
  }
  class FitAddon { fit() {} }
  class SearchAddon { clearDecorations() {} findNext() { return true } findPrevious() { return true } }
  const data = []; const actions = []
  const surface = mountXtermSurface(document.createElement('div'), { onData: (text, options) => data.push({ text, ...options }), onResize() {}, onFind: () => actions.push('find'), onNew() {}, onClear() {}, onCopy: () => actions.push('copy'), onRelative() {} }, { Terminal, FitAddon, SearchAddon })
  return { surface, terminal, data, actions }
}
const key = (name, extra = {}) => ({ type: 'keydown', key: name, preventDefault() {}, ...extra })

test('xterm serial parser queue suppresses historical device replies, preserves live replies even hidden', async () => {
  const { surface, terminal, data } = mockSurface()
  surface.enableInput(true)
  const old = surface.write('\x1b[6n', { replay: true })
  const live = surface.write('live')
  assert.equal(terminal.writes.length, 1)
  assert.equal(terminal.options.disableStdin, true)
  terminal.handlers.data('\x1b[1;1R')
  assert.deepEqual(data, [])
  terminal.writes[0].callback(); await old
  assert.equal(terminal.writes.length, 2)
  assert.equal(terminal.options.disableStdin, false)
  terminal.handlers.data('\x1b[1;9R')
  assert.deepEqual(data, [{ text: '\x1b[1;9R', protocol: true }])
  terminal.writes[1].callback(); await live
  surface.enableInput(false)
  assert.equal(terminal.options.disableStdin, true)
  const hidden = surface.write('hidden query')
  assert.equal(terminal.options.disableStdin, false)
  terminal.handlers.data('\x1b[1;20R')
  assert.equal(data.length, 2)
  terminal.writes[2].callback(); await hidden
  assert.equal(terminal.options.disableStdin, true)
  terminal.handlers.data('physical input')
  assert.equal(data.length, 2)
  surface.dispose()
})

test('selection-aware Ctrl+C, workbench shortcuts, OSC52 and disposal are safe', async () => {
  const { surface, terminal, actions } = mockSurface()
  surface.enableInput(true)
  assert.equal(terminal.key(key('c', { ctrlKey: true })), true)
  terminal.selected = true
  assert.equal(terminal.key(key('c', { ctrlKey: true })), false)
  assert.equal(terminal.key(key('c', { ctrlKey: true, shiftKey: true })), false)
  assert.deepEqual(actions, ['copy'])
  assert.equal(terminal.key(key('`', { ctrlKey: true, code: 'Backquote' })), false)
  assert.equal(terminal.key(key('j', { ctrlKey: true })), false)
  assert.equal(terminal.key(key('P', { ctrlKey: true, shiftKey: true })), false)
  assert.equal(terminal.osc.code, 52)
  assert.equal(terminal.osc.callback('clipboard secret'), true)
  const first = surface.write('first'); const second = surface.write('second')
  surface.dispose()
  await Promise.all([first, second])
  assert.equal(terminal.disposed, true)
})
