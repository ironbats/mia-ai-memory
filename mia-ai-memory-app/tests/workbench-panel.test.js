import './dom-environment.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import IdeWorkbenchPanel from '../src/components/IdeWorkbenchPanel.jsx'

// DOM regression only; jsdom does not validate browser painting or dimensions.
test('maximize and restore controls preserve the mounted command terminal', async () => {
  const root = createRoot(document.getElementById('root'))
  const workspace = { isReady: true, activeProjectId: 'one', rootName: 'project', sessionChanges: [], gitWorkingChanges: [] }
  let toggles = 0
  let closed = 0
  const render = async maximized => act(async () => root.render(React.createElement(IdeWorkbenchPanel, {
    activePanel: 'terminal', workspace, analysis: { symbols: [], diagnostics: [] },
    onPanelChange: () => {}, onClose: () => { closed++ },
    maximized, onToggleMaximize: () => { toggles++ }
  })))
  try {
    await render(false)
    const input = document.querySelector('[aria-label="Comando do terminal"]')
    assert.ok(input)
    const maximize = document.querySelector('[aria-label="Maximizar painel"]')
    assert.equal(maximize.getAttribute('aria-pressed'), 'false')
    await act(async () => maximize.click())
    assert.equal(toggles, 1)
    await render(true)
    assert.equal(document.querySelector('[aria-label="Comando do terminal"]'), input)
    const restore = document.querySelector('[aria-label="Restaurar painel"]')
    assert.equal(restore.getAttribute('aria-pressed'), 'true')
    await act(async () => restore.click())
    assert.equal(toggles, 2)
    await act(async () => document.querySelector('.ide-workbench-close').click())
    assert.equal(closed, 1)
  } finally { await act(async () => root.unmount()) }
})
