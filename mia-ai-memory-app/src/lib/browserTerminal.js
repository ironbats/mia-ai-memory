import { formatUnifiedDiff, changeStatusLetter } from "./ideDiff.js"


const lineText = value => String(value ?? "").split("\n")
export async function runBrowserCommand(command, workspace, analysis) {
  const sessionChanges = workspace.sessionChanges || []
  const [base = "", ...args] = command.split(/\s+/)
  const argument = args.join(" ").trim()
  const output = []
  if (base === "help") {
    output.push({ type: "output", text: "help · clear · pwd · ls [path] · find <texto> · open <arquivo> · cat <arquivo> · save · refresh · git branch · git status · git diff [arquivo] · symbols · problems\nPara Git real, builds, servidores e comandos arbitrários, conecte o projeto como HOST RW pelo Workspace Runtime." })
  } else if (base === "pwd") {
    output.push({ type: "output", text: `/${workspace.rootName || "workspace"}` })
  } else if (base === "ls") {
    const prefix = argument ? `${argument.replace(/^\.\//, "").replace(/\/$/, "")}/` : ""
    const items = workspace.filePaths.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split("/")[0]).filter(Boolean)
    output.push({ type: "output", text: [...new Set(items)].sort().slice(0, 200).join("\n") || "Nenhum item encontrado." })
  } else if (base === "find") {
    const normalized = argument.toLowerCase()
    const matches = workspace.filePaths.filter(path => path.toLowerCase().includes(normalized)).slice(0, 100)
    output.push({ type: "output", text: matches.join("\n") || "Nenhum arquivo encontrado." })
  } else if (base === "open") {
    if (!argument) throw new Error("Informe o caminho do arquivo.")
    await workspace.openFile(argument)
    output.push({ type: "success", text: `Aberto: ${argument}` })
  } else if (base === "cat") {
    if (!argument) throw new Error("Informe o caminho do arquivo.")
    const tab = workspace.tabs.find(item => item.path === argument)
    const content = tab ? tab.content : await workspace.readPath(argument)
    output.push({ type: "output", text: lineText(content).slice(0, 240).join("\n") })
  } else if (base === "save") {
    const count = await workspace.saveAll()
    output.push({ type: "success", text: `${count} arquivo(s) salvo(s).` })
  } else if (base === "refresh") {
    await workspace.refresh()
    output.push({ type: "success", text: "Workspace atualizado." })
  } else if (base === "git" && args[0] === "branch") {
    output.push({ type: "output", text: workspace.gitRepository ? `* ${workspace.gitBranch || `(detached ${workspace.gitHeadShort || "HEAD"})`}` : "Projeto sem repositório Git detectado." })
  } else if (base === "git" && args[0] === "status") {
    if (!sessionChanges.length) output.push({ type: "success", text: `On branch ${workspace.gitBranch || "local"}\nNenhuma alteração registrada nesta sessão do navegador. Este resultado não substitui git status do filesystem físico.` })
    else output.push({ type: "output", text: `On branch ${workspace.gitBranch || "local"}\n${sessionChanges.map(change => `${changeStatusLetter(change)}  ${change.path}`).join("\n")}` })
  } else if (base === "git" && args[0] === "diff") {
    const requestedPath = args.slice(1).join(" ").trim()
    const targets = requestedPath ? sessionChanges.filter(item => item.path === requestedPath) : sessionChanges
    output.push({ type: "output", text: targets.length ? targets.map(formatUnifiedDiff).join("\n\n") : "Nenhuma alteração registrada nesta sessão do navegador." })
  } else if (base === "symbols") {
    output.push({ type: "output", text: analysis.symbols.length ? analysis.symbols.map(item => `${item.kind.padEnd(10)} ${String(item.line).padStart(4)}  ${item.name}`).join("\n") : "Nenhum símbolo detectado no arquivo ativo." })
  } else if (base === "problems") {
    output.push({ type: "output", text: analysis.diagnostics.length ? analysis.diagnostics.map(item => `${item.severity.toUpperCase()} Ln ${item.line}: ${item.message}`).join("\n") : "Nenhum problema local detectado." })
  } else {
    throw new Error(`Este projeto está em ${workspace.workspaceMode === "portable" ? "Browser Workspace" : "modo de navegador"}. Conecte-o como HOST RW para executar o comando real: ${command}`)
  }
  return output
}

