const STRUCTURED_LANGUAGES = new Set(["Java", "Kotlin", "C#", "Go", "Rust", "JavaScript", "TypeScript"])
const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "synchronized", "when", "match"])
const JOIN_AFTER_BRACE = new Set(["else", "catch", "finally", "while"])
const WORD_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const NUMBER_PATTERN = /^(?:\d|\.\d)/
const OPERATORS = [">>>=", "<<=", ">>=", "===", "!==", ">>>", "**=", "&&=", "||=", "??=", "::", "->", "=>", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**", "??", "?.", "...", "=", "+", "-", "*", "/", "%", "!", "&", "|", "^", "~", "?"]

const trimTrailingWhitespace = content => String(content || "").split("\n").map(line => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n*$/, "\n")
const isWordLike = token => token && (token.type === "word" || token.type === "number" || token.type === "string")

const readQuoted = (source, start, quote) => {
  let index = start + 1
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === quote) return index + 1
    index += 1
  }
  return source.length
}

const canStartRegex = previous => !previous || ["(", "[", "{", "=", ":", ",", ";", "!", "&&", "||", "?", "=>"].includes(previous.value) || ["return", "case", "throw", "yield", "await"].includes(previous.value)

const readRegex = (source, start) => {
  let index = start + 1
  let escaped = false
  let inClass = false
  while (index < source.length) {
    const char = source[index]
    if (escaped) {
      escaped = false
      index += 1
      continue
    }
    if (char === "\\") {
      escaped = true
      index += 1
      continue
    }
    if (char === "[") inClass = true
    if (char === "]") inClass = false
    if (char === "/" && !inClass) {
      index += 1
      while (/[A-Za-z]/.test(source[index] || "")) index += 1
      return index
    }
    if (char === "\n") return start + 1
    index += 1
  }
  return start + 1
}

const scanTokens = (source, language) => {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2)
      const finish = end < 0 ? source.length : end
      tokens.push({ type: "line-comment", value: source.slice(index, finish) })
      index = finish
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      const finish = end < 0 ? source.length : end + 2
      tokens.push({ type: "block-comment", value: source.slice(index, finish) })
      index = finish
      continue
    }
    if ((language === "JavaScript" || language === "TypeScript") && char === "/" && canStartRegex(tokens[tokens.length - 1])) {
      const end = readRegex(source, index)
      if (end > index + 1) {
        tokens.push({ type: "string", value: source.slice(index, end) })
        index = end
        continue
      }
    }
    if (char === "\"" || char === "'" || char === "`") {
      const end = readQuoted(source, index, char)
      tokens.push({ type: "string", value: source.slice(index, end) })
      index = end
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1
      while (/[A-Za-z0-9_$]/.test(source[end] || "")) end += 1
      tokens.push({ type: "word", value: source.slice(index, end) })
      index = end
      continue
    }
    if (/\d/.test(char)) {
      let end = index + 1
      while (/[A-Za-z0-9_.]/.test(source[end] || "")) end += 1
      tokens.push({ type: "number", value: source.slice(index, end) })
      index = end
      continue
    }
    const operator = OPERATORS.find(value => source.startsWith(value, index))
    if (operator) {
      tokens.push({ type: "operator", value: operator })
      index += operator.length
      continue
    }
    tokens.push({ type: "punctuation", value: char })
    index += 1
  }
  return tokens
}

const formatStructured = (tokens, indentSize, language) => {
  const lines = []
  let line = ""
  let indent = 0
  let parenDepth = 0
  let bracketDepth = 0
  let annotationDepth = -1
  let genericDepth = 0
  let previous = null

  const indentation = () => " ".repeat(Math.max(0, indent) * indentSize)
  const commit = force => {
    const value = line.trimEnd()
    if (value || force) lines.push(value || "")
    line = ""
  }
  const ensureIndent = () => { if (!line) line = indentation() }
  const append = (value, spaced = false) => {
    ensureIndent()
    if (spaced && line.trim() && !/\s$/.test(line)) line += " "
    line += value
  }
  const appendWord = token => {
    const needsSpace = isWordLike(previous) || previous?.value === ")" || previous?.value === "]" || [">", ">>", ">>>"].includes(previous?.value)
    append(token.value, needsSpace)
  }
  const nextSignificant = index => tokens[index + 1] || null

  tokens.forEach((token, index) => {
    const next = nextSignificant(index)
    if (token.type === "line-comment") {
      append(token.value, Boolean(line.trim()))
      commit(false)
      previous = token
      return
    }
    if (token.type === "block-comment") {
      if (line.trim()) commit(false)
      const parts = token.value.split("\n")
      parts.forEach(part => {
        line = `${indentation()}${part.trimEnd()}`
        commit(false)
      })
      previous = token
      return
    }
    if (token.type === "word" || token.type === "number" || token.type === "string") {
      const annotationName = previous?.value === "@"
      appendWord(token)
      if (annotationName && next?.value !== "(") {
        annotationDepth = -1
        commit(false)
      }
      previous = token
      return
    }
    if (token.value === "@") {
      if (line.trim()) commit(false)
      append("@")
      annotationDepth = parenDepth
      previous = token
      return
    }
    if (token.value === "{") {
      append("{", Boolean(line.trim()) && !/[\s([{.]$/.test(line))
      commit(false)
      indent += 1
      previous = token
      return
    }
    if (token.value === "}") {
      if (line.trim()) commit(false)
      indent = Math.max(0, indent - 1)
      append("}")
      if (next && [";", ",", ")", "]"].includes(next.value)) {
        previous = token
        return
      }
      if (next?.type === "word" && JOIN_AFTER_BRACE.has(next.value)) {
        line += " "
        previous = token
        return
      }
      commit(false)
      previous = token
      return
    }
    if (token.value === ";") {
      append(";")
      if (parenDepth === 0) commit(false)
      else line += " "
      previous = token
      return
    }
    if (token.value === "(") {
      append("(", previous?.type === "word" && CONTROL_WORDS.has(previous.value))
      parenDepth += 1
      previous = token
      return
    }
    if (token.value === ")") {
      line = line.trimEnd()
      append(")")
      parenDepth = Math.max(0, parenDepth - 1)
      if (annotationDepth === parenDepth && next && next.value !== "." && next.value !== "::") {
        annotationDepth = -1
        commit(false)
      }
      previous = token
      return
    }
    if (token.value === "[") {
      append("[")
      bracketDepth += 1
      previous = token
      return
    }
    if (token.value === "]") {
      line = line.trimEnd()
      append("]")
      bracketDepth = Math.max(0, bracketDepth - 1)
      previous = token
      return
    }
    if (token.value === "<") {
      const generic = previous?.type === "word" && /^[A-Z_$]/.test(previous.value) || genericDepth > 0 && [",", "?", "extends", "super"].includes(previous?.value)
      if (generic) {
        line = line.trimEnd()
        append("<")
        genericDepth += 1
      } else {
        line = line.trimEnd()
        append("<", true)
        line += " "
      }
      previous = token
      return
    }
    if (token.value === ">") {
      line = line.trimEnd()
      if (genericDepth > 0) {
        append(">")
        genericDepth = Math.max(0, genericDepth - 1)
      } else {
        append(">", true)
        line += " "
      }
      previous = token
      return
    }
    if (token.value === ",") {
      line = line.trimEnd()
      append(",")
      line += " "
      previous = token
      return
    }
    if (token.value === "." || token.value === "?." || token.value === "::") {
      line = line.trimEnd()
      append(token.value)
      previous = token
      return
    }
    if (token.value === ":") {
      line = line.trimEnd()
      append(":", language === "Java" && parenDepth > 0)
      line += " "
      previous = token
      return
    }
    if (token.type === "operator") {
      if ([">>", ">>>"].includes(token.value) && genericDepth > 0) {
        line = line.trimEnd()
        append(token.value)
        genericDepth = Math.max(0, genericDepth - token.value.length)
      } else if (["!", "~", "++", "--", "?"].includes(token.value)) append(token.value)
      else if (["->", "=>"].includes(token.value)) {
        line = line.trimEnd()
        append(token.value, true)
        line += " "
      } else if (["=", "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "%="].includes(token.value)) {
        line = line.trimEnd()
        append(token.value, true)
        line += " "
      } else append(token.value)
      previous = token
      return
    }
    append(token.value)
    previous = token
  })

  if (line.trim()) commit(false)
  const compact = []
  for (const current of lines) {
    if (!current.trim() && (!compact.length || !compact[compact.length - 1].trim())) continue
    compact.push(current)
  }
  return `${compact.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
}

const formatBraceLanguage = (content, language) => {
  if (String(content || "").includes('"""')) return trimTrailingWhitespace(content)
  const indentSize = ["Java", "Kotlin", "C#"].includes(language) ? 4 : 2
  const tokens = scanTokens(String(content || ""), language)
  return formatStructured(tokens, indentSize, language)
}

const formatJson = content => {
  try {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`
  } catch {
    return trimTrailingWhitespace(content)
  }
}

export const canFormatLanguage = language => language === "JSON" || STRUCTURED_LANGUAGES.has(language)

export const formatDocument = ({ content = "", language = "Plain Text" } = {}) => {
  const source = String(content || "")
  let formatted = source
  let engine = "whitespace"
  if (language === "JSON") {
    formatted = formatJson(source)
    engine = "json"
  } else if (STRUCTURED_LANGUAGES.has(language)) {
    formatted = formatBraceLanguage(source, language)
    engine = "structured"
  } else formatted = trimTrailingWhitespace(source)
  return { content: formatted, changed: formatted !== source, engine, supported: canFormatLanguage(language) }
}
