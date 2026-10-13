const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const escape = /\u001b\[([0-9;]*)m/g

const reset = () => ({ foreground: null, background: null, bold: false })

const paletteColor = index => {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null
  if (index < 16) return `${index >= 8 ? 'bright-' : ''}${colors[index % 8]}`
  if (index >= 232) {
    const shade = 8 + 10 * (index - 232)
    return `rgb(${shade},${shade},${shade})`
  }
  const component = position => {
    const value = Math.floor((index - 16) / (6 ** position)) % 6
    return value === 0 ? 0 : 55 + value * 40
  }
  return `rgb(${component(2)},${component(1)},${component(0)})`
}

const applySgr = (previous, parameters) => {
  let state = { ...previous }
  const codes = parameters === '' ? [0] : parameters.split(';').map(Number)
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]
    if (code === 0) state = reset()
    else if (code === 1) state.bold = true
    else if (code === 22) state.bold = false
    else if (code === 39) state.foreground = null
    else if (code === 49) state.background = null
    else if (code >= 30 && code <= 37) state.foreground = colors[code - 30]
    else if (code >= 40 && code <= 47) state.background = colors[code - 40]
    else if (code >= 90 && code <= 97) state.foreground = `bright-${colors[code - 90]}`
    else if (code >= 100 && code <= 107) state.background = `bright-${colors[code - 100]}`
    else if ((code === 38 || code === 48) && codes[i + 1] === 5 && Number.isInteger(codes[i + 2])) {
      const color = paletteColor(codes[i + 2])
      if (color) state[code === 38 ? 'foreground' : 'background'] = color
      i += 2
    } else if ((code === 38 || code === 48) && codes[i + 1] === 2 && codes.length >= i + 5) {
      const values = codes.slice(i + 2, i + 5)
      if (values.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
        state[code === 38 ? 'foreground' : 'background'] = `rgb(${values.join(',')})`
      }
      i += 4
    }
  }
  return state
}

export function parseTerminalAnsi(text, initialState = reset()) {
  const segments = []
  let state = { ...initialState }
  let start = 0
  const append = end => {
    if (end > start) segments.push({ text: text.slice(start, end), ...state })
  }
  for (const match of text.matchAll(escape)) {
    append(match.index)
    state = applySgr(state, match[1])
    start = match.index + match[0].length
  }
  append(text.length)
  return { segments, state }
}

export const emptyTerminalAnsiState = reset

const normalizeHeading = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()

const gitSection = value => {
  const heading = normalizeHeading(value)
  if (/^(changes to be committed|mudancas a serem submetidas|alteracoes a serem submetidas|alteracoes preparadas para commit)\s*:/.test(heading)) return 'staged'
  if (/^(changes not staged for commit|changes not staged|mudancas nao preparadas|alteracoes nao preparadas|mudancas nao adicionadas|alteracoes nao adicionadas)(?:\s+para\s+commit)?\s*:/.test(heading)) return 'unstaged'
  if (/^(untracked files|arquivos nao monitorados|arquivos nao rastreados|arquivos sem rastreamento)\s*:/.test(heading)) return 'untracked'
  if (/^(unmerged paths|caminhos nao mesclados|arquivos em conflito)\s*:/.test(heading)) return 'conflict'
  return null
}

export function isGitStatusCommand(command) {
  const value = String(command ?? '').trim()
  return /^git(?:\s+--no-pager)?(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?(?:\s+--no-pager)?\s+status(?=\s|$)/.test(value)
}

export function getExecutedTerminalCommand(entry) {
  const text = String(entry ?? '').trimEnd().split(/\r?\n/).at(-1) || ''
  const delimiter = text.lastIndexOf('$ ')
  return delimiter < 0 ? text.trim() : text.slice(delimiter + 2).trim()
}

const statusRecord = line => {
  const match = /^([ MARCUD?!])([ MARCUD?!]) (.+)/.exec(line)
  if (!match || (match[1] === ' ' && match[2] === ' ') || (match[1] === '!' && match[2] === '!')) return null
  if (match[1] === '?' && match[2] === '?') return { type: 'untracked', first: match[1], second: match[2], rest: match[3] }
  if (/[U]/.test(match[1] + match[2]) || /^(AA|DD)$/.test(match[1] + match[2])) return { type: 'conflict', first: match[1], second: match[2], rest: match[3] }
  const staged = match[1] !== ' '
  const unstaged = match[2] !== ' '
  return { type: staged && unstaged ? 'mixed' : staged ? 'staged' : 'unstaged', first: match[1], second: match[2], rest: match[3] }
}

const verboseStatusRecord = line => /^[ \t]+(?:new file|modified|deleted|renamed|copied|typechange|both modified|both added|both deleted|added|novo arquivo|modificado|excluido|excluído|renomeado|copiado|adicionado|alterado)\s*:\s*\S/i.test(line)
const untrackedStatusRecord = line => /^[ \t]+\S/.test(line) && !/^[ \t]+\(/.test(line)

export function colorizeGitStatusOutput(text) {
  const lines = String(text ?? '').match(/[^\n]*\n|[^\n]+$/g) || []
  const segments = []
  let section = null
  const append = (value, foreground = null) => {
    if (!value) return
    const previous = segments.at(-1)
    if (previous?.foreground === foreground) previous.text += value
    else segments.push({ text: value, foreground, background: null, bold: false })
  }
  for (const line of lines) {
    const heading = gitSection(line)
    if (heading) {
      section = heading
      append(line)
      continue
    }
    const record = section === null ? statusRecord(line) : null
    if (record) {
      if (record.type === 'mixed') {
        append(record.first, 'green')
        append(record.second, 'red')
        append(' ')
        append(record.rest + (line.endsWith('\n') ? '\n' : ''), 'yellow')
      } else if (record.type === 'staged' || record.type === 'unstaged') {
        append(record.first, record.type === 'staged' ? 'green' : null)
        append(record.second, record.type === 'unstaged' ? 'red' : null)
        append(' ')
        append(record.rest + (line.endsWith('\n') ? '\n' : ''), record.type === 'staged' ? 'green' : 'red')
      } else {
        append(line, 'red')
      }
      continue
    }
    if (section && verboseStatusRecord(line)) {
      append(line, section === 'staged' ? 'green' : 'red')
    } else if ((section === 'untracked' || section === 'conflict') && untrackedStatusRecord(line)) {
      append(line, 'red')
    } else {
      append(line)
    }
  }
  return segments
}


export function isGitCommitCommand(command) {
  const value = String(command ?? '').trim()
  return /^git(?:(?:\s+--no-pager)|(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))|(?:\s+-c\s+\S+))*\s+commit(?=\s|$)/.test(value)
}

const gitCommitHeader = /^\[[^\]\r\n]+\s[0-9a-f]{4,64}\]\s+\S/i
const gitCommitSummary = /^(\s*\d+\s+(?:files?\s+changed|arquivos?\s+(?:alterados?|modificados?)))(.*)$/i
const gitCommitCount = /\d[\d,.]*\s+(?:insertions?\(\+\)|deletions?\(-\)|inser[cç][oõ]es?\(\+\)|exclus[oõ]es?\(-\))/gi

export function colorizeGitCommitOutput(text) {
  const value = String(text ?? '')
  const lines = value.match(/[^\n]*\n|[^\n]+$/g) || []
  const segments = []
  const append = (part, foreground = null, bold = false) => {
    if (!part) return
    const previous = segments.at(-1)
    if (previous?.foreground === foreground && previous?.bold === bold) previous.text += part
    else segments.push({ text: part, foreground, background: null, bold })
  }
  if (!lines.some(line => gitCommitHeader.test(line))) {
    append(value)
    return segments
  }
  for (const line of lines) {
    if (gitCommitHeader.test(line)) {
      append(line, 'green', true)
      continue
    }
    if (/^\s*(?:create mode|rewrite|rename|copy|mode change)\s+/i.test(line)) {
      append(line, 'green')
      continue
    }
    if (/^\s*delete mode\s+/i.test(line)) {
      append(line, 'red')
      continue
    }
    const summary = gitCommitSummary.exec(line.replace(/\r?\n$/, ''))
    if (!summary) {
      append(line)
      continue
    }
    append(summary[1], 'green')
    const remainder = line.slice(summary[1].length)
    let cursor = 0
    for (const match of remainder.matchAll(gitCommitCount)) {
      append(remainder.slice(cursor, match.index))
      append(match[0], /(?:deletions?|exclus[oõ]es?)\(-\)/i.test(match[0]) ? 'red' : 'green')
      cursor = match.index + match[0].length
    }
    append(remainder.slice(cursor))
  }
  return segments
}

export function mergeTerminalColorSegments(nativeSegments, fallbackSegments) {
  const result = []
  let nativeIndex = 0
  let fallbackIndex = 0
  let nativeOffset = 0
  let fallbackOffset = 0
  while (nativeIndex < nativeSegments.length && fallbackIndex < fallbackSegments.length) {
    const native = nativeSegments[nativeIndex]
    const fallback = fallbackSegments[fallbackIndex]
    const length = Math.min(native.text.length - nativeOffset, fallback.text.length - fallbackOffset)
    if (length > 0) {
      const text = native.text.slice(nativeOffset, nativeOffset + length)
      const foreground = native.foreground ?? fallback.foreground
      const background = native.background ?? fallback.background
      const bold = native.bold || fallback.bold
      const previous = result.at(-1)
      if (previous?.foreground === foreground && previous?.background === background && previous?.bold === bold) previous.text += text
      else result.push({ text, foreground, background, bold })
    }
    nativeOffset += length
    fallbackOffset += length
    if (nativeOffset === native.text.length) {
      nativeIndex += 1
      nativeOffset = 0
    }
    if (fallbackOffset === fallback.text.length) {
      fallbackIndex += 1
      fallbackOffset = 0
    }
  }
  return result
}
