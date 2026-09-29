import { searchWorkspace } from "./ideSearch.js"

const SOURCE_EXTENSIONS = new Set(["java", "kt", "kts", "cs", "go", "rs", "py", "js", "jsx", "ts", "tsx", "mjs", "cjs", "c", "cc", "cpp", "cxx", "h", "hpp", "hh"])
const TYPE_LIKE = /^[A-Z_$][A-Za-z0-9_$]*$/

const escapePattern = value => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const simpleType = value => String(value || "").replace(/<.*$/, "").replace(/\[\]$/g, "").split(/[.$]/).pop()?.trim() || ""
const extensionOf = path => String(path || "").toLowerCase().split(".").pop()
const basenameOf = path => String(path || "").split("/").pop() || ""
const normalizeExcerpt = value => String(value || "").replace(/\s+/g, " ").trim()

export const identifierAt = (content, offset) => {
  const source = String(content || "")
  let position = Math.max(0, Math.min(Number(offset) || 0, source.length))
  if (position === source.length && position > 0) position -= 1
  if (!/[A-Za-z0-9_$]/.test(source[position] || "") && position > 0 && /[A-Za-z0-9_$]/.test(source[position - 1] || "")) position -= 1
  let start = position
  let end = position
  while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start -= 1
  while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1
  const symbol = source.slice(start, end)
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return null
  return { symbol, start, end }
}

const inferVariableType = (content, variable, language, offset) => {
  if (!variable) return ""
  const source = String(content || "").slice(0, Math.max(0, Number(offset) || 0))
  const escaped = escapePattern(variable)
  const patterns = []
  if (["Java", "Kotlin", "C#", "C", "C++"].includes(language)) {
    patterns.push(new RegExp(`\\b([A-Z_$][A-Za-z0-9_$.]*(?:\\s*<[^;=(){}\\n]+>)?(?:\\[\\])?)\\s+${escaped}\\b`, "g"))
    patterns.push(new RegExp(`\\b(?:val|var)\\s+${escaped}\\s*:\\s*([A-Z_$][A-Za-z0-9_$.]*)`, "g"))
  }
  if (["TypeScript", "React TSX", "JavaScript", "React JSX"].includes(language)) {
    patterns.push(new RegExp(`\\b${escaped}\\s*[!?]?\\s*:\\s*([A-Z_$][A-Za-z0-9_$.]*)`, "g"))
    patterns.push(new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*new\\s+([A-Z_$][A-Za-z0-9_$.]*)`, "g"))
  }
  if (language === "Go") {
    patterns.push(new RegExp(`\\bvar\\s+${escaped}\\s+[*]?([A-Z_$][A-Za-z0-9_$.]*)`, "g"))
    patterns.push(new RegExp(`\\b${escaped}\\s*:=\\s*&?([A-Z_$][A-Za-z0-9_$.]*)\\s*\\{`, "g"))
  }
  if (language === "Rust") patterns.push(new RegExp(`\\blet(?:\\s+mut)?\\s+${escaped}\\s*:\\s*&?(?:mut\\s+)?([A-Z_$][A-Za-z0-9_:]*)`, "g"))
  if (language === "Python") patterns.push(new RegExp(`\\b${escaped}\\s*:\\s*([A-Z_$][A-Za-z0-9_$.]*)`, "g"))
  let inferred = ""
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source))) inferred = simpleType(match[1])
  }
  return inferred
}

export const buildNavigationRequest = ({ content = "", language = "Plain Text", offset = 0 } = {}) => {
  const identifier = identifierAt(content, offset)
  if (!identifier) return null
  const before = content.slice(0, identifier.start)
  const receiver = before.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*$/)?.[1] || ""
  const scopeType = inferVariableType(content, receiver, language, identifier.start)
  return {
    ...identifier,
    receiver,
    scopeType,
    typeLike: TYPE_LIKE.test(identifier.symbol),
    language
  }
}

const declarationClass = (excerpt, symbol) => {
  const escaped = escapePattern(symbol)
  const rules = [
    [new RegExp(`\\binterface\\s+${escaped}\\b`), "interface", 980],
    [new RegExp(`\\btrait\\s+${escaped}\\b`), "interface", 980],
    [new RegExp(`\\babstract\\s+class\\s+${escaped}\\b`), "abstract", 970],
    [new RegExp(`\\b(?:class|record|struct|enum|type)\\s+${escaped}\\b`), "type", 940],
    [new RegExp(`\\btype\\s+${escaped}\\s*=`), "type", 940],
    [new RegExp(`\\b(?:function|func|fn|def|fun)\\s+${escaped}\\s*(?:<[^>]+>\\s*)?\\(`), "function", 910],
    [new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=`), "variable", 860],
    [new RegExp(`\\b${escaped}\\s*\\([^;{}]*\\)\\s*(?:throws\\s+[^{}]+)?\\{`), "method", 820]
  ]
  for (const [pattern, kind, score] of rules) if (pattern.test(excerpt)) return { kind, score }
  return null
}

const implementationClass = (excerpt, symbol) => {
  const escaped = escapePattern(symbol)
  const rules = [
    [new RegExp(`\\b(?:class|record|struct)\\s+[A-Za-z_$][A-Za-z0-9_$]*[^{}\\n]{0,260}\\bimplements\\b[^{}\\n]{0,260}\\b${escaped}\\b`), "implementation", 1180],
    [new RegExp(`\\b(?:class|record|struct)\\s+[A-Za-z_$][A-Za-z0-9_$]*[^{}\\n]{0,260}\\bextends\\b[^{}\\n]{0,260}\\b${escaped}\\b`), "extension", 1110],
    [new RegExp(`\\bclass\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*\\([^)]*\\)\\s*:\\s*[^{}\\n]{0,260}\\b${escaped}\\b`), "implementation", 1160],
    [new RegExp(`\\bclass\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*:\\s*[^{}\\n]{0,260}\\b${escaped}\\b`), "implementation", 1160],
    [new RegExp(`\\bimpl(?:<[^>]+>)?\\s+${escaped}\\s+for\\s+[A-Za-z_$][A-Za-z0-9_$:<>]*`), "implementation", 1180],
    [new RegExp(`\\bimpl(?:<[^>]+>)?\\s+${escaped}\\b`), "implementation", 1070],
    [new RegExp(`\\bclass\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*\\(\\s*${escaped}\\s*\\)`), "implementation", 1120]
  ]
  for (const [pattern, kind, score] of rules) if (pattern.test(excerpt)) return { kind, score }
  return null
}

const classifyOccurrence = (result, symbol) => {
  const excerpt = String(result.excerpt || "")
  const declaration = declarationClass(excerpt, symbol)
  const implementation = implementationClass(excerpt, symbol)
  const baseName = basenameOf(result.path).replace(/\.[^.]+$/, "")
  let score = 180
  let kind = "reference"
  if (declaration) {
    score = declaration.score
    kind = declaration.kind
  }
  if (implementation && implementation.score > score) {
    score = implementation.score
    kind = implementation.kind
  }
  if (baseName === symbol) score += 180
  if (baseName.startsWith(symbol)) score += 70
  return { ...result, symbol, kind, score, detail: normalizeExcerpt(excerpt).slice(0, 220) }
}

const sourcePathsFor = (paths, symbol = "") => {
  const source = paths.filter(path => SOURCE_EXTENSIONS.has(extensionOf(path)))
  const values = source.length ? source : paths
  if (!symbol) return values
  const normalized = symbol.toLowerCase()
  return [...values].sort((a, b) => {
    const aBase = basenameOf(a).replace(/\.[^.]+$/, "").toLowerCase()
    const bBase = basenameOf(b).replace(/\.[^.]+$/, "").toLowerCase()
    const aRank = aBase === normalized ? 0 : aBase.includes(normalized) ? 1 : 2
    const bRank = bBase === normalized ? 0 : bBase.includes(normalized) ? 1 : 2
    return aRank - bRank || a.localeCompare(b)
  })
}

const uniqueLocations = values => {
  const seen = new Set()
  return values.filter(item => {
    const key = `${item.path}:${item.line}:${item.column}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const searchSymbol = async ({ symbol, paths, drafts, readPath, signal }) => {
  if (!symbol) return []
  const result = await searchWorkspace({
    paths,
    drafts,
    readPath,
    query: symbol,
    caseSensitive: true,
    wholeWord: true,
    signal,
    onProgress: null
  })
  return result.results.map(item => classifyOccurrence(item, symbol))
}

const implementationKinds = new Set(["implementation", "extension"])
const declarationKinds = new Set(["interface", "abstract", "type", "function", "variable", "method"])

export const resolveNavigation = async ({ request, paths = [], drafts = new Map(), readPath, mode = "smart", signal }) => {
  if (!request?.symbol || typeof readPath !== "function") return []
  let scopeImplementationPaths = new Set()
  let scopeDeclarationPaths = new Set()
  if (request.scopeType && request.scopeType !== request.symbol) {
    const scopePaths = sourcePathsFor(paths, request.scopeType)
    const scopeOccurrences = await searchSymbol({ symbol: request.scopeType, paths: scopePaths, drafts, readPath, signal })
    scopeImplementationPaths = new Set(scopeOccurrences.filter(item => implementationKinds.has(item.kind)).map(item => item.path))
    scopeDeclarationPaths = new Set(scopeOccurrences.filter(item => declarationKinds.has(item.kind)).map(item => item.path))
  }
  const sourcePaths = sourcePathsFor(paths, request.symbol)
  const scopedPaths = [...sourcePaths].sort((a, b) => {
    const aRank = scopeImplementationPaths.has(a) ? 0 : scopeDeclarationPaths.has(a) ? 1 : 2
    const bRank = scopeImplementationPaths.has(b) ? 0 : scopeDeclarationPaths.has(b) ? 1 : 2
    return aRank - bRank
  })
  const occurrences = await searchSymbol({ symbol: request.symbol, paths: scopedPaths, drafts, readPath, signal })

  const enriched = occurrences.map(item => {
    let score = item.score
    if (scopeImplementationPaths.has(item.path)) score += 650
    else if (scopeDeclarationPaths.has(item.path)) score += 360
    if (item.path === request.currentPath) score += 40
    return { ...item, score }
  })

  const implementations = enriched.filter(item => implementationKinds.has(item.kind))
  const declarations = enriched.filter(item => declarationKinds.has(item.kind))
  const abstractTarget = declarations.some(item => item.kind === "interface" || item.kind === "abstract")
  let selected
  if (mode === "implementation") selected = implementations
  else if (mode === "definition") selected = declarations
  else if (request.scopeType && scopeImplementationPaths.size) selected = enriched.filter(item => scopeImplementationPaths.has(item.path) && (declarationKinds.has(item.kind) || implementationKinds.has(item.kind)))
  else if (request.typeLike && abstractTarget && implementations.length) selected = implementations
  else selected = declarations.length ? declarations : enriched

  if (!selected.length && mode === "implementation") selected = implementations.length ? implementations : enriched.filter(item => scopeImplementationPaths.has(item.path))
  if (!selected.length) selected = enriched

  return uniqueLocations(selected)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, 30)
}
