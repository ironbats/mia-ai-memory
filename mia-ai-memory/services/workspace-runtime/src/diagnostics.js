import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const MAX_SOURCE_BYTES = 256 * 1024
const MAX_OUTPUT_CHARS = 64000
const MAX_DIAGNOSTICS = 80
const PROCESS_TIMEOUT_MS = 7000

const suffixFor = filePath => {
  const name = path.posix.basename(filePath.toLowerCase())
  if (name === "dockerfile" || name === "makefile") return name
  return path.posix.extname(name)
}

const languages = {
  ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "React JSX",
  ".ts": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".tsx": "React TSX",
  ".py": "Python", ".java": "Java", ".go": "Go", ".rs": "Rust",
  ".json": "JSON", ".jsonc": "JSONC", ".toml": "TOML", ".xml": "XML",
  ".sh": "Shell", ".bash": "Shell", ".rb": "Ruby", ".php": "PHP",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++"
}

const issue = (message, line = 1, column = 1, severity = "error") => ({
  severity,
  line: Math.max(1, Number(line) || 1),
  column: Math.max(1, Number(column) || 1),
  message: String(message || "Erro de sintaxe").trim().slice(0, 600)
})

const lineColumn = (source, offset) => {
  const prefix = source.slice(0, Math.max(0, Math.min(source.length, offset)))
  const lines = prefix.split("\n")
  return [lines.length, lines.at(-1).length + 1]
}

const parseJson = source => {
  try {
    JSON.parse(source)
    return []
  } catch (error) {
    const message = error?.message || "JSON inválido"
    const offset = message.match(/position\s+(\d+)/i)
    const location = message.match(/line\s+(\d+)\s+column\s+(\d+)/i)
    const [line, column] = location ? [Number(location[1]), Number(location[2])] : lineColumn(source, Number(offset?.[1] || source.length))
    return [issue(message, line, column)]
  }
}

const parseNode = output => {
  const location = output.match(/\[stdin\]:(\d+)(?::(\d+))?/)
  const excerpt = output.match(/\[stdin\]:\d+\r?\n[^\r\n]*\r?\n([ \t]*)\^/)
  const message = output.match(/(?:SyntaxError|TypeError):\s*([^\r\n]+)/)
  if (!location && !message) return []
  return [issue(message?.[1] || output.trim().split("\n").at(-1), Number(location?.[1] || 1), Number(location?.[2] || (excerpt?.[1]?.length || 0) + 1))]
}

const parseTsc = output => [...output.matchAll(/^[^\r\n]*\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+([^\r\n]+)/gm)]
  .filter(match => Number(match[3]) >= 1000 && Number(match[3]) < 2000 || Number(match[3]) >= 17000 && Number(match[3]) < 18000)
  .map(match => issue(`TS${match[3]}: ${match[4]}`, match[1], match[2]))

const parseJavaCompiler = output => output.split(/\r?\n/).filter(line => line.startsWith("DIAG\t")).map(line => {
  const [, location, column, severity, ...message] = line.split("\t")
  return issue(message.join(" "), location, column, severity === "WARNING" ? "warning" : "error")
})

const javaSyntaxParser = `import javax.tools.*;
import com.sun.source.util.JavacTask;
import java.nio.file.Path;
import java.util.List;
public class JavaSyntaxParser {
  public static void main(String[] args) throws Exception {
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
    try (StandardJavaFileManager manager = compiler.getStandardFileManager(collector, null, null)) {
      Iterable<? extends JavaFileObject> units = manager.getJavaFileObjects(Path.of(args[0]));
      JavacTask task = (JavacTask) compiler.getTask(null, manager, collector, List.of("-proc:none"), null, units);
      task.parse();
    }
    for (Diagnostic<? extends JavaFileObject> item : collector.getDiagnostics()) {
      String message = item.getMessage(null).replace("\\n", " ").replace("\\r", " ").replace("\\t", " ");
      System.out.println("DIAG\\t" + Math.max(1, item.getLineNumber()) + "\\t" + Math.max(1, item.getColumnNumber()) + "\\t" + item.getKind() + "\\t" + message);
    }
  }
}`

const parseGo = output => [...output.matchAll(/^(?:<standard input>|<stdin>|stdin|[^\r\n]+\.go):(\d+):(\d+):\s*([^\r\n]+)/gm)]
  .map(match => issue(match[3], match[1], match[2]))

const parseRust = output => [...output.matchAll(/^\s*-->\s+(?:<stdin>|stdin|[^\r\n]+\.rs):(\d+):(\d+)/gm)]
  .map(match => issue(output.slice(0, match.index).match(/error(?:\[[^\]]+\])?:\s*([^\r\n]+)(?![\s\S]*error:)/)?.[1] || "Erro de sintaxe Rust", match[1], match[2]))

const parseShell = output => [...output.matchAll(/(?:^|\n)(?:bash|[^\r\n]*?):\s*(?:line\s+)?(\d+):\s*([^\r\n]+)/g)]
  .map(match => issue(match[2], match[1], 1))

const parseRuby = output => [...output.matchAll(/(?:^|\n)(?:-|stdin|[^\r\n]+\.rb):(\d+):\s*([^\r\n]+)/g)]
  .map(match => issue(match[2], match[1], 1))

const parsePhp = output => [...output.matchAll(/(?:on\s+line\s+)(\d+)/g)]
  .map(match => issue(output.match(/(?:Parse|Fatal) error:\s*([^\r\n]+)/)?.[1] || "Erro de sintaxe PHP", match[1], 1))

const parseClang = output => [...output.matchAll(/^(?:<stdin>|stdin|[^\r\n]+):(\d+):(\d+):\s*(error|warning):\s*([^\r\n]+)/gm)]
  .map(match => issue(match[4], match[1], match[2], match[3]))

const parsePythonJson = output => {
  try {
    const parsed = JSON.parse(output)
    if (!Array.isArray(parsed)) return []
    return parsed.map(item => issue(item.message, item.line, item.column, item.severity)).slice(0, MAX_DIAGNOSTICS)
  } catch {
    return []
  }
}

const pythonCheck = "import ast,json,sys\ns=sys.stdin.read()\ntry:\n ast.parse(s, filename='editor.py')\n print('[]')\nexcept SyntaxError as e:\n print(json.dumps([{'message':e.msg,'line':e.lineno or 1,'column':e.offset or 1}],ensure_ascii=False))"
const xmlCheck = "import xml.etree.ElementTree as ET,json,sys\ntry:\n ET.fromstring(sys.stdin.read())\n print('[]')\nexcept ET.ParseError as e:\n print(json.dumps([{'message':str(e),'line':e.position[0],'column':e.position[1]+1}],ensure_ascii=False))"
const tomlCheck = "import tomllib,json,sys\ntry:\n tomllib.loads(sys.stdin.read())\n print('[]')\nexcept tomllib.TOMLDecodeError as e:\n print(json.dumps([{'message':str(e),'line':getattr(e,'lineno',1),'column':getattr(e,'colno',1)}],ensure_ascii=False))"

const execute = ({ file, args, stdin, signal, cwd, timeoutMs = PROCESS_TIMEOUT_MS }) => new Promise(resolve => {
  let child
  try {
    child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } })
  } catch (error) {
    resolve({ error: error.code || "SPAWN_FAILED", output: "", code: null })
    return
  }
  let output = ""
  let timeout = false
  let overflow = false
  let settled = false
  const append = chunk => {
    output += String(chunk)
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS)
      overflow = true
      child.kill("SIGKILL")
    }
  }
  child.stdout.on("data", append)
  child.stderr.on("data", append)
  const kill = () => child.kill("SIGKILL")
  signal?.addEventListener("abort", kill, { once: true })
  const timer = setTimeout(() => { timeout = true; kill() }, timeoutMs)
  child.on("error", error => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener("abort", kill)
    resolve({ error: error.code || "SPAWN_FAILED", output, code: null })
  })
  child.on("close", code => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener("abort", kill)
    resolve({ code, output, timeout, overflow, aborted: Boolean(signal?.aborted) })
  })
  child.stdin.on("error", () => {})
  child.stdin.end(stdin)
  if (signal?.aborted) kill()
})

const providerFor = (ext, tempFile) => {
  if ([".js", ".mjs", ".cjs"].includes(ext)) return {
    tool: "Node.js", file: process.execPath,
    args: ["--check", `--input-type=${ext === ".cjs" ? "commonjs" : "module"}`],
    stdin: true, parse: parseNode
  }
  if ([".ts", ".tsx", ".mts", ".cts", ".jsx"].includes(ext)) return {
    tool: "TypeScript (tsc)", file: "tsc",
    args: ["--noEmit", "--noResolve", "--noLib", "--skipLibCheck", "--pretty", "false", "--target", "ES2020", "--module", "esnext", "--jsx", "preserve", ...(ext === ".jsx" ? ["--allowJs", "--checkJs", "false"] : []), tempFile],
    stdin: false, parse: parseTsc
  }
  if (ext === ".py") return { tool: "Python AST", file: "python3", args: ["-c", pythonCheck], stdin: true, parse: parsePythonJson }
  if (ext === ".xml") return { tool: "Python XML", file: "python3", args: ["-c", xmlCheck], stdin: true, parse: parsePythonJson }
  if (ext === ".toml") return { tool: "Python TOML", file: "python3", args: ["-c", tomlCheck], stdin: true, parse: parsePythonJson }
  if (ext === ".go") return { tool: "gofmt", file: "gofmt", args: ["-e"], stdin: true, parse: parseGo }
  if (ext === ".rs") return { tool: "rustfmt", file: "rustfmt", args: ["--emit", "stdout", "--edition", "2021"], stdin: true, parse: parseRust }
  if ([".sh", ".bash"].includes(ext)) return { tool: "Bash", file: "bash", args: ["-n"], stdin: true, parse: parseShell }
  if (ext === ".rb") return { tool: "Ruby", file: "ruby", args: ["-c"], stdin: true, parse: parseRuby }
  if (ext === ".php") return { tool: "PHP", file: "php", args: ["-l"], stdin: true, parse: parsePhp }
  if (ext === ".java") return { tool: "Java Compiler API (parser)", file: "java", args: [path.join(path.dirname(tempFile), "JavaSyntaxParser.java"), tempFile], stdin: false, parse: parseJavaCompiler, timeoutMs: 12000 }
  if ([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"].includes(ext)) return {
    tool: "Clang (arquivo isolado)", file: "clang", args: ["-fsyntax-only", "-fno-color-diagnostics", "-x", [".c", ".h"].includes(ext) ? "c" : "c++", "-"], stdin: true, parse: parseClang
  }
  return null
}

export const diagnoseSource = async ({ filePath, content, signal }) => {
  if (typeof filePath !== "string" || !filePath.trim() || typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) {
    const error = new Error("Arquivo inválido ou maior que 256 KiB")
    error.code = "DIAGNOSTIC_INVALID_INPUT"
    throw error
  }
  const ext = suffixFor(filePath)
  const language = languages[ext] || "Outro"
  if (ext === ".json") {
    const diagnostics = parseJson(content)
    return { status: diagnostics.length ? "issues" : "ok", language, provider: "JSON.parse", diagnostics }
  }
  if (ext === ".jsonc") return { status: "unavailable", language, provider: "", reason: "JSON com comentários exige um analisador JSONC instalado.", diagnostics: [] }
  let directory = ""
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-memory-diag-"))
    const name = path.basename(filePath).replace(/[^A-Za-z0-9._-]/g, "_") || `editor${ext}`
    const tempFile = path.join(directory, name)
    const provider = providerFor(ext, tempFile)
    if (!provider) return { status: "unavailable", language, provider: "", reason: `Não há verificador configurado para ${language}. Use o terminal para compilar o projeto.`, diagnostics: [] }
    if (!provider.stdin) await fs.writeFile(tempFile, content, { encoding: "utf8", mode: 0o600 })
    if (ext === ".java") await fs.writeFile(path.join(directory, "JavaSyntaxParser.java"), javaSyntaxParser, { encoding: "utf8", mode: 0o600 })
    const result = await execute({ file: provider.file, args: provider.args, stdin: provider.stdin ? content : "", cwd: directory, signal, timeoutMs: provider.timeoutMs })
    if (result.aborted) return { status: "cancelled", language, provider: provider.tool, diagnostics: [] }
    if (result.timeout) return { status: "timeout", language, provider: provider.tool, reason: "Tempo limite do analisador excedido.", diagnostics: [] }
    if (result.error === "ENOENT") return { status: "unavailable", language, provider: provider.tool, reason: `Instale ${provider.tool} no PATH da máquina que executa o Workspace Runtime.`, diagnostics: [] }
    if (result.error || result.overflow) return { status: "failed", language, provider: provider.tool, reason: result.overflow ? "O analisador produziu saída excessiva." : "Falha ao iniciar analisador.", diagnostics: [] }
    const diagnostics = (provider.parse(result.output) || []).slice(0, MAX_DIAGNOSTICS)
    if (result.code !== 0 && !diagnostics.length && !(provider.tool === "TypeScript (tsc)" && /error TS\d+:/.test(result.output))) {
      return { status: "failed", language, provider: provider.tool, reason: String(result.output || `Verificador retornou código ${result.code}`).slice(0, 400), diagnostics: [] }
    }
    return { status: diagnostics.length ? "issues" : "ok", language, provider: provider.tool, diagnostics }
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

export const DIAGNOSTIC_SOURCE_LIMIT = MAX_SOURCE_BYTES
