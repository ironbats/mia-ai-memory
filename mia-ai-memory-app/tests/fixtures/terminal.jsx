import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import IdeWorkbenchPanel from '../../src/components/IdeWorkbenchPanel.jsx'
import '../../src/styles.css'
import '../../src/styles/ide-workspace.css'
import '../../src/styles/workspace-ux.css'
import '../../src/styles/ide-terminal.css'
const sessions = new Map()
let count = 0
function Fixture() {
  const [project, setProject] = useState('alpha')
  const [panel, setPanel] = useState('terminal')
  const [switching, setSwitching] = useState(false)
  const workspace = {
    isReady: true, activeProjectId: project, runtimeWorkspaceId: project, projectSwitching: switching,
    rootName: project, terminalRuntimeAvailable: true, sessionChanges: [], gitWorkingChanges: [],
    gitRepository: true, gitBranch: 'main',
    executeTerminalCommand: async command => {
      const id = `${project}-${++count}`
      const long = command === 'long'
      const delayed = command === 'delayed'
      if (delayed) await new Promise(resolve => setTimeout(resolve, 400))
      const session = { id, running: long, output: long ? 'running\n' : `${project}: ${command}\n`, nextCursor: 0, exitCode: long ? null : 0 }
      sessions.set(id, session)
      return { session, cwd: '' }
    },
    pollTerminalSession: async id => ({ session: { ...sessions.get(id), output: '' } }),
    stopTerminalSession: async id => { sessions.set(id, { ...sessions.get(id), running: false, exitCode: 143 }); return true },
    refresh: async () => {}
  }
  return <main style={{ padding: 24, background: '#0e131c', minHeight: '100vh', color: '#d5ddef' }}>
    <style>{".ide-workbench { height: 100%; }"}</style>
    <h1>AI Memory IDE · Terminal</h1>
    <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
      <button onClick={() => setProject(project === 'alpha' ? 'beta' : 'alpha')}>Trocar projeto</button>
      <button onClick={() => setPanel(panel ? '' : 'terminal')}>Mostrar / ocultar</button>
      <button onClick={() => setSwitching(value => !value)}>Transição</button>
    </div>
    <div className="code-workspace" style={{ height: 380, '--ide-font-md': '13px', '--ide-font-sm': '12px', '--ide-font-xs': '11px', '--ide-workbench-tab-height': '32px' }}>
      <div style={{ height: 360 }}><IdeWorkbenchPanel workspace={workspace} analysis={{ diagnostics: [], symbols: [] }} activePanel={panel} onPanelChange={setPanel} onClose={() => setPanel('')} onRevealLine={() => {}} /></div>
    </div>
  </main>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>)
