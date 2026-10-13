let pendingEngine = null

const resourceUrl = name => `${import.meta.env.BASE_URL || "/"}vendor/codemirror/${name}`

const loadResource = (tag, url, key) => new Promise((resolve, reject) => {
  const existing = document.querySelector(`[data-ide-editor-resource="${key}"]`)
  if (existing?.dataset.state === "ready") {
    resolve()
    return
  }
  const element = existing || document.createElement(tag)
  const success = () => {
    element.dataset.state = "ready"
    resolve()
  }
  const failure = () => {
    element.remove()
    reject(new Error(`Falha ao carregar o mecanismo de edição: ${url}`))
  }
  element.addEventListener("load", success, { once: true })
  element.addEventListener("error", failure, { once: true })
  if (!existing) {
    element.dataset.ideEditorResource = key
    if (tag === "link") {
      element.rel = "stylesheet"
      element.href = url
    } else {
      element.src = url
      element.async = true
    }
    document.head.appendChild(element)
  }
})

export const loadIdeEditorEngine = () => {
  if (typeof document === "undefined") return Promise.reject(new Error("Editor disponível somente no navegador."))
  if (window.CodeMirror?.commands?.selectNextOccurrence && document.querySelector('[data-ide-editor-resource="styles"][data-state="ready"]')) return Promise.resolve(window.CodeMirror)
  if (!pendingEngine) {
    pendingEngine = Promise.all([
      loadResource("link", resourceUrl("ide-editor.css"), "styles"),
      loadResource("script", resourceUrl("ide-editor.js"), "engine")
    ]).then(() => {
      if (!window.CodeMirror?.commands?.selectNextOccurrence) throw new Error("O mecanismo de edição foi carregado de forma incompleta.")
      return window.CodeMirror
    }).catch(error => {
      pendingEngine = null
      throw error
    })
  }
  return pendingEngine
}

const modes = {
  JavaScript: "text/javascript",
  "React JSX": "text/jsx",
  TypeScript: "text/typescript",
  "React TSX": "text/typescript-jsx",
  Java: "text/x-java",
  Kotlin: "text/x-kotlin",
  Scala: "text/x-scala",
  "C#": "text/x-csharp",
  "C++": "text/x-c++src",
  C: "text/x-csrc",
  "C/C++ Header": "text/x-c++src",
  "C++ Header": "text/x-c++src",
  Go: "text/x-go",
  Rust: "text/x-rustsrc",
  Python: "text/x-python",
  Ruby: "text/x-ruby",
  PHP: "application/x-httpd-php",
  Swift: "text/x-swift",
  Shell: "text/x-sh",
  PowerShell: "application/x-powershell",
  SQL: "text/x-sql",
  HTML: "text/html",
  XML: "application/xml",
  Vue: "text/html",
  Svelte: "text/html",
  CSS: "text/css",
  SCSS: "text/x-scss",
  Sass: "text/x-sass",
  Less: "text/x-less",
  JSON: "application/json",
  YAML: "text/x-yaml",
  TOML: "text/x-toml",
  Markdown: "text/x-gfm",
  MDX: "text/x-gfm",
  "Protocol Buffers": "text/x-protobuf",
  Dockerfile: "text/x-dockerfile",
  Makefile: "text/x-sh",
  Terraform: "text/x-properties",
  Diff: "text/x-diff"
}

export const editorModeForLanguage = language => modes[language] || "text/plain"
