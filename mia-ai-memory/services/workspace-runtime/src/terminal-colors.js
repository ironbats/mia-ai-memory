const ESCAPE = '\u001b'

export function createTerminalColorFilter() {
  let mode = 'text'
  let sequence = ''
  let previousEscape = false

  return chunk => {
    let output = ''
    for (const char of String(chunk ?? '')) {
      const code = char.charCodeAt(0)
      if (mode === 'text') {
        if (char === ESCAPE) {
          mode = 'escape'
        } else if (code === 0x9b) {
          mode = 'csi'
          sequence = ''
        } else if (code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f) {
          mode = 'string'
          previousEscape = false
        } else if (code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159))) {
          output += char
        }
      } else if (mode === 'escape') {
        if (char === '[') {
          mode = 'csi'
          sequence = ''
        } else if (']P^_'.includes(char)) {
          mode = 'string'
          previousEscape = false
        } else {
          mode = 'text'
        }
      } else if (mode === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          if (char === 'm' && /^[0-9;]{0,64}$/.test(sequence)) output += `${ESCAPE}[${sequence}m`
          mode = 'text'
          sequence = ''
        } else if (code >= 0x20 && code <= 0x3f && sequence.length < 96) {
          sequence += char
        } else {
          mode = 'text'
          sequence = ''
        }
      } else if (mode === 'string') {
        if (code === 7 || code === 0x9c || (previousEscape && char === '\\')) {
          mode = 'text'
          previousEscape = false
        } else {
          previousEscape = char === ESCAPE
        }
      }
    }
    return output
  }
}

export function terminalCommandEnvironment(command, environment = process.env) {
  const next = { ...environment, TERM: environment.TERM || 'xterm-256color' }
  const text = String(command || '').trim()
  const git = /^git\s+(?:--no-pager\s+)?(status|diff|log|show)(?=\s|$)/.exec(text)
  if (!git || /[|><]/.test(text) || /--(?:no-color|color=never)(?=\s|$)/.test(text)) return next
  const count = Number(environment.GIT_CONFIG_COUNT || 0)
  if (!Number.isSafeInteger(count) || count < 0 || count > 128) return next
  const setting = git[1] === 'status' ? 'color.status' : git[1] === 'diff' ? 'color.diff' : 'color.ui'
  next.GIT_CONFIG_COUNT = String(count + 1)
  next[`GIT_CONFIG_KEY_${count}`] = setting
  next[`GIT_CONFIG_VALUE_${count}`] = 'always'
  next.GIT_PAGER = 'cat'
  return next
}
