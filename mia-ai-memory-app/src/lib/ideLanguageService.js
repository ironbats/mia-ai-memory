const MAX_ANALYSIS_CHARS = 500000

const languageKeywords = {
  JavaScript: ["async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "let", "new", "of", "return", "static", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield"],
  "React JSX": ["async", "await", "class", "const", "export", "extends", "for", "from", "function", "if", "import", "let", "new", "return", "this", "throw", "try"],
  TypeScript: ["abstract", "any", "as", "asserts", "async", "await", "boolean", "class", "const", "declare", "enum", "export", "extends", "from", "function", "implements", "import", "infer", "interface", "keyof", "let", "namespace", "never", "new", "number", "private", "protected", "public", "readonly", "return", "satisfies", "static", "string", "type", "unknown", "void"],
  "React TSX": ["abstract", "as", "async", "await", "boolean", "class", "const", "enum", "export", "extends", "from", "function", "implements", "import", "interface", "let", "private", "protected", "public", "readonly", "return", "string", "type"],
  Java: ["abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "package", "private", "protected", "public", "record", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "var", "void", "volatile", "while"],
  Go: ["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"],
  Rust: ["as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while"],
  Python: ["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"],
  Kotlin: ["as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "val", "var", "when", "while"],
  "C#": ["abstract", "as", "async", "await", "base", "bool", "break", "byte", "case", "catch", "char", "class", "const", "continue", "decimal", "default", "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "get", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long", "namespace", "new", "null", "object", "operator", "out", "override", "params", "private", "protected", "public", "readonly", "record", "ref", "return", "sbyte", "sealed", "set", "short", "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while"],
  SQL: ["alter", "and", "as", "asc", "begin", "between", "by", "case", "create", "delete", "desc", "distinct", "drop", "else", "end", "exists", "from", "group", "having", "in", "index", "insert", "into", "is", "join", "left", "like", "limit", "not", "null", "on", "or", "order", "outer", "primary", "references", "returning", "right", "select", "set", "table", "then", "union", "unique", "update", "values", "when", "where", "with"]
}

const lineNumberAt = (content, index) => content.slice(0, Math.max(0, index)).split("\n").length

const extractMatches = (content, regex, kind, nameIndex = 1, detailBuilder = null) => {
  const values = []
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(content))) {
    const name = match[nameIndex]
    if (!name) continue
    values.push({
      name,
      kind,
      line: lineNumberAt(content, match.index),
      detail: detailBuilder ? detailBuilder(match) : match[0].trim().replace(/\s+/g, " ").slice(0, 140)
    })
    if (!match[0].length) regex.lastIndex += 1
  }
  return values
}

const symbolProviders = {
  JavaScript: content => [
    ...extractMatches(content, /\bclass\s+([A-Za-z_$][\w$]*)/g, "class"),
    ...extractMatches(content, /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, "function"),
    ...extractMatches(content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, "function"),
    ...extractMatches(content, /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/gm, "method")
  ],
  "React JSX": content => symbolProviders.JavaScript(content),
  TypeScript: content => [
    ...extractMatches(content, /\b(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, "class"),
    ...extractMatches(content, /\binterface\s+([A-Za-z_$][\w$]*)/g, "interface"),
    ...extractMatches(content, /\benum\s+([A-Za-z_$][\w$]*)/g, "enum"),
    ...extractMatches(content, /\btype\s+([A-Za-z_$][\w$]*)\s*=/g, "type"),
    ...extractMatches(content, /\bfunction\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*\(/g, "function"),
    ...extractMatches(content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, "function"),
    ...extractMatches(content, /^\s*(?:(?:public|private|protected|static|readonly|async|abstract|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*\([^;{}]*\)\s*(?::[^={]+)?\{/gm, "method")
  ],
  "React TSX": content => symbolProviders.TypeScript(content),
  Java: content => [
    ...extractMatches(content, /\b(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+|sealed\s+|non-sealed\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g, "type", 2, match => match[1]),
    ...extractMatches(content, /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)*(?:<[^>]+>\s*)?[A-Za-z_$][\w$<>,.?\[\]\s]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^\{]+)?\{/gm, "method")
  ],
  Go: content => [
    ...extractMatches(content, /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm, "type"),
    ...extractMatches(content, /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, "function")
  ],
  Rust: content => [
    ...extractMatches(content, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, "function"),
    ...extractMatches(content, /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/gm, "struct"),
    ...extractMatches(content, /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/gm, "enum"),
    ...extractMatches(content, /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/gm, "trait"),
    ...extractMatches(content, /^\s*impl(?:<[^>]+>)?\s+([^\s{]+)/gm, "impl")
  ],
  Python: content => [
    ...extractMatches(content, /^\s*class\s+([A-Za-z_]\w*)/gm, "class"),
    ...extractMatches(content, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, "function")
  ],
  Kotlin: content => [
    ...extractMatches(content, /\b(?:data\s+|sealed\s+|open\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/g, "class"),
    ...extractMatches(content, /\binterface\s+([A-Za-z_]\w*)/g, "interface"),
    ...extractMatches(content, /\b(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)\s*\(/g, "function")
  ],
  "C#": content => [
    ...extractMatches(content, /\b(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|sealed\s+|partial\s+)*(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/g, "type"),
    ...extractMatches(content, /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|partial)\s+)+[A-Za-z_][\w<>,.?\[\]\s]*\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:where[^\{]+)?\{/gm, "method")
  ]
}

const scanDelimiters = (content, language) => {
  const pairs = { "(": ")", "[": "]", "{": "}" }
  const closers = new Set(Object.values(pairs))
  const stack = []
  const diagnostics = []
  let quote = ""
  let escaped = false
  let lineComment = false
  let blockComment = false
  let line = 1
  const hashComments = new Set(["Python", "Ruby", "Shell", "PowerShell", "YAML", "TOML", "Makefile"]).has(language)

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]
    if (char === "\n") {
      line += 1
      lineComment = false
      continue
    }
    if (lineComment) continue
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) quote = ""
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    if (hashComments && char === "#") {
      lineComment = true
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (pairs[char]) {
      stack.push({ char, line })
      continue
    }
    if (closers.has(char)) {
      const last = stack.pop()
      if (!last || pairs[last.char] !== char) diagnostics.push({ severity: "error", line, message: `Delimitador '${char}' sem abertura correspondente.` })
    }
  }

  for (const item of stack.slice(-20)) diagnostics.push({ severity: "error", line: item.line, message: `Delimitador '${item.char}' não foi fechado.` })
  return diagnostics
}

const jsonDiagnostics = content => {
  try {
    JSON.parse(content)
    return []
  } catch (error) {
    const message = error?.message || "JSON inválido"
    const position = Number(message.match(/position\s+(\d+)/i)?.[1] || 0)
    return [{ severity: "error", line: lineNumberAt(content, position), message }]
  }
}

const conflictDiagnostics = content => {
  const result = []
  const lines = content.split("\n")
  lines.forEach((line, index) => {
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(line)) result.push({ severity: "error", line: index + 1, message: "Marcador de conflito de merge detectado." })
  })
  return result
}

const duplicateDiagnosticKey = item => `${item.severity}:${item.line}:${item.message}`

export const analyzeDocument = ({ content = "", language = "Plain Text" } = {}) => {
  const source = content.length > MAX_ANALYSIS_CHARS ? content.slice(0, MAX_ANALYSIS_CHARS) : content
  const provider = symbolProviders[language]
  const symbols = (provider ? provider(source) : []).sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)).slice(0, 500)
  const diagnostics = [
    ...(language === "JSON" ? jsonDiagnostics(source) : scanDelimiters(source, language)),
    ...conflictDiagnostics(source)
  ]
  const uniqueDiagnostics = [...new Map(diagnostics.map(item => [duplicateDiagnosticKey(item), item])).values()].slice(0, 200)
  return {
    symbols,
    diagnostics: uniqueDiagnostics,
    provider: provider ? "local-symbol-provider" : "delimiter-provider",
    symbolCount: symbols.length,
    errorCount: uniqueDiagnostics.filter(item => item.severity === "error").length,
    warningCount: uniqueDiagnostics.filter(item => item.severity === "warning").length,
    truncated: source.length !== content.length
  }
}

export const wordPrefixAt = (content, offset) => {
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, content.length))
  const before = content.slice(0, safeOffset)
  const match = before.match(/[A-Za-z_$][A-Za-z0-9_$]*$/)
  return match?.[0] || ""
}

export const getCompletions = ({ content = "", language = "Plain Text", offset = 0, limit = 12 } = {}) => {
  const prefix = wordPrefixAt(content, offset)
  const start = Math.max(0, offset - 120000)
  const end = Math.min(content.length, offset + 40000)
  const sample = content.slice(start, end)
  const identifiers = sample.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || []
  const words = [...(languageKeywords[language] || []), ...identifiers]
  const unique = [...new Set(words)]
  const normalized = prefix.toLowerCase()
  return unique
    .filter(word => !normalized || word.toLowerCase().startsWith(normalized))
    .filter(word => word !== prefix)
    .sort((a, b) => {
      const aExact = normalized && a.toLowerCase().startsWith(normalized) ? 0 : 1
      const bExact = normalized && b.toLowerCase().startsWith(normalized) ? 0 : 1
      return aExact - bExact || a.length - b.length || a.localeCompare(b)
    })
    .slice(0, limit)
    .map(word => ({ label: word, kind: (languageKeywords[language] || []).includes(word) ? "keyword" : "symbol" }))
}
