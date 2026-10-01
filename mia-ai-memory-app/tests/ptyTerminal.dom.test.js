import './dom-environment.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import IdePtyTerminal from '../src/components/ide/IdePtyTerminal.jsx'

const tick = () => new Promise(resolve => setImmediate(resolve))
test('PTY StrictMode: readiness, fresh callbacks, retained surfaces, split navigation and project isolation', async () => {
  const root = createRoot(document.getElementById('root'))
  const instances = []; const creates = []; const writes = []; const closes = []
  const createSurface = async (host, events) => {
    const instance = { events, disposed: false, enabled: false, chunks: [], focus() {}, clear() {}, selection: () => '', enableInput(value) { this.enabled = value }, fit: () => ({ cols: 100, rows: 25 }), write(data, options) { this.chunks.push({ data, options }); return Promise.resolve() }, find: () => true, clearFind() {}, dispose() { this.disposed = true } }
    instances.push(instance); return instance
  }
  const makeWorkspace = (id, ready = true) => ({
    isReady: ready, activeProjectId: id, runtimeWorkspaceId: id, rootName: id,
    listPtyTerminals: async () => ({ sessions: [] }),
    createPtyTerminal: async options => { assert.equal(ready, true, 'stale unready callback must not execute'); creates.push({ id, options }); return { session: { id: `${id}-${creates.length}`, running: true, output: `${id} prompt`, nextCursor: id.length + 7 } } },
    pollPtyTerminal: (id, cursor, { signal } = {}) => new Promise((resolve, reject) => { signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }) }),
    writePtyTerminal: async (shell, data) => { writes.push({ id, shell, data }) }, resizePtyTerminal: async () => {},
    closePtyTerminal: async id => { closes.push(id); return { stopped: true } }, refresh: async () => {}
  })
  const render = async (workspace, visible = true) => act(async () => { root.render(React.createElement(React.StrictMode, {}, React.createElement(IdePtyTerminal, { workspace, visible, createSurface }))); await tick() })
  const click = label => act(async () => { document.querySelector(`[aria-label="${label}"]`).click(); await tick() })
  try {
    await render(makeWorkspace('alpha', false), false)
    assert.equal(creates.length, 0)
    await render(makeWorkspace('alpha'), false)
    assert.equal(creates.length, 0)
    await render(makeWorkspace('alpha'))
    assert.equal(creates.length, 1)
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1)
    const first = instances.filter(instance => !instance.disposed)[0]
    assert.ok(first.chunks.some(chunk => chunk.data === 'alpha prompt'))
    await act(async () => first.events.onData('echo one\r'))
    assert.equal(writes[0].id, 'alpha')
    await render(makeWorkspace('alpha'), false)
    assert.equal(first.disposed, false)
    await act(async () => first.events.onData('must not write'))
    assert.equal(writes.length, 1)
    await act(async () => first.events.onData('\x1b[1;1R', { protocol: true }))
    assert.equal(writes.length, 2, 'hidden live shells can answer a TUI query')
    await render(makeWorkspace('alpha'))
    assert.equal(creates.length, 1)
    await click('Novo terminal'); assert.equal(creates.length, 2)
    await click('Dividir terminal')
    assert.equal([...document.querySelectorAll('.ide-pty-slot')].filter(node => !node.hidden).length, 2)
    const activeSurface = instances.filter(instance => !instance.disposed).at(-1)
    await act(async () => activeSurface.events.onRelative(-1))
    assert.equal([...document.querySelectorAll('.ide-pty-slot')].filter(node => !node.hidden).length, 2, 'relative navigation keeps both split panes')
    await click('Buscar no terminal')
    assert.equal(document.activeElement.getAttribute('aria-label'), 'Texto para buscar no terminal')
    await click('Fechar busca')
    await render(makeWorkspace('beta'))
    assert.equal(creates.length, 3)
    assert.ok(instances.filter(instance => !instance.disposed).every(instance => instance.chunks.every(chunk => !chunk.data.includes('alpha'))))
    await act(async () => first.events.onData('stale'))
    assert.equal(writes.length, 2)
    assert.equal(closes.length, 0, 'switch/unmount does not terminate recoverable shells')
  } finally { await act(async () => root.unmount()) }
})
