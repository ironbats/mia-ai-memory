import './dom-environment.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import IdeWorkbenchPanel from '../src/components/IdeWorkbenchPanel.jsx'

const analysis = { symbols: [], diagnostics: [] }
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('React StrictMode: hidden panel, project switching, scoped late output and input lock', async () => {
  const root = createRoot(document.getElementById('root'))
  const requests = []
  const makeWorkspace = id => ({ isReady: true, activeProjectId: id, runtimeWorkspaceId: id, rootName: id, terminalRuntimeAvailable: true, sessionChanges: [], gitWorkingChanges: [], refresh: async () => {}, executeTerminalCommand: command => {
    const pending = defer(); requests.push({ id, command, pending }); return pending.promise
  } })
  const alpha = makeWorkspace('alpha'); const beta = makeWorkspace('beta')
  const render = async (workspace, panel = 'terminal') => act(async () => root.render(React.createElement(React.StrictMode, {}, React.createElement(IdeWorkbenchPanel, { workspace, activePanel: panel, analysis, onPanelChange: () => {}, onClose: () => {}, onRevealLine: () => {} }))))
  const query = selector => document.querySelector(selector)
  const click = async label => act(async () => query(`[aria-label="${label}"]`).click())
  const input = text => {
    // React installs its change tracking when the input is created. Setter + input
    // event covers user input without reaching into a controller or React internals.
    const element = query('input')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, text)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const run = async text => { await act(async () => input(text)); await act(async () => query('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))) }
  try {
    await render(alpha)
    await run('delayed')
    assert.equal(requests.length, 1)
    await render(beta)
    await act(async () => requests[0].pending.resolve({ session: { id: 'a', output: 'alpha private output', running: false, exitCode: 0 } }))
    assert.doesNotMatch(query('.ide-terminal-output').textContent, /alpha private/)
    await render(alpha)
    assert.match(query('.ide-terminal-output').textContent, /alpha private/)
    await render(alpha, '')
    assert.equal(query('.ide-workbench').hidden, true)
    await render(alpha)
    assert.match(query('.ide-terminal-output').textContent, /alpha private/)
    await click('Novo terminal')
    assert.equal(document.querySelectorAll('[role="tab"]').length, 2)
    await render({ ...alpha, projectSwitching: true })
    assert.equal(query('input').readOnly, true)
    assert.equal(query('[aria-label="Novo terminal"]').disabled, true)
    await act(async () => query('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.equal(requests.length, 1)
    await render(alpha)
    await run('after switch')
    assert.equal(requests[1].id, 'alpha')
    await act(async () => requests[1].pending.resolve({ session: { id: 'b', output: 'done', running: false, exitCode: 0 } }))
    await click('Limpar saída')
    assert.doesNotMatch(query('.ide-terminal-output').textContent, /done/)
  } finally { await act(async () => root.unmount()) }
})
