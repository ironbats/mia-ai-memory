import React from 'react'
import IdeCommandTerminal from './IdeCommandTerminal.jsx'
import IdePtyTerminal from './IdePtyTerminal.jsx'

export default function IdeTerminal(props) {
  return props.workspace.terminalPtyAvailable
    ? <IdePtyTerminal {...props} />
    : <IdeCommandTerminal {...props} />
}
