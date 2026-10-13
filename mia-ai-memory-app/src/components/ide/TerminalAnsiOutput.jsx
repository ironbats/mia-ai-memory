import React, { useMemo } from 'react'
import { colorizeGitCommitOutput, colorizeGitStatusOutput, emptyTerminalAnsiState, getExecutedTerminalCommand, isGitCommitCommand, isGitStatusCommand, mergeTerminalColorSegments, parseTerminalAnsi } from '../../lib/terminalAnsi.js'

const colorClass = (value, prefix) => value && !value.startsWith('rgb(') ? ` terminal-${prefix}-${value}` : ''

const groupTerminalEntries = entries => {
  const groups = []
  let currentCommand = ''
  for (const entry of entries) {
    const type = entry.type
    const value = String(entry.text ?? '')
    if (type === 'command') currentCommand = getExecutedTerminalCommand(value)
    if (type === 'output' && groups.at(-1)?.type === 'output' && groups.at(-1).command === currentCommand) {
      groups.at(-1).text += value
    } else {
      groups.push({ type, text: value, command: currentCommand })
    }
    if (type === 'success' || type === 'error') currentCommand = ''
  }
  return groups
}

export default function TerminalAnsiOutput({ entries }) {
  const rendered = useMemo(() => {
    let state = emptyTerminalAnsiState()
    return groupTerminalEntries(entries).map((entry, index) => {
      if (entry.type !== 'output') state = emptyTerminalAnsiState()
      const parsed = parseTerminalAnsi(entry.text, state)
      state = parsed.state
      const hasNativeColors = parsed.segments.some(segment => segment.foreground || segment.background)
      const segments = entry.type === 'output' && isGitStatusCommand(entry.command) && !hasNativeColors
        ? colorizeGitStatusOutput(entry.text)
        : entry.type === 'output' && isGitCommitCommand(entry.command)
          ? mergeTerminalColorSegments(parsed.segments, colorizeGitCommitOutput(parsed.segments.map(segment => segment.text).join('')))
          : parsed.segments
      return <span key={index} className={`terminal-${entry.type}`}>
        {segments.map((segment, part) => <span key={part} className={`terminal-ansi${segment.bold ? ' terminal-ansi-bold' : ''}${colorClass(segment.foreground, 'fg')}${colorClass(segment.background, 'bg')}`} style={{ ...(segment.foreground?.startsWith('rgb(') ? { color: segment.foreground } : {}), ...(segment.background?.startsWith('rgb(') ? { backgroundColor: segment.background } : {}) }}>{segment.text}</span>)}
      </span>
    })
  }, [entries])
  return <pre>{rendered}</pre>
}
