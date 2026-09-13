import React, { useEffect, useMemo, useRef, useState } from "react"

const normalize = value => String(value || "").trim().toLowerCase()

const projectMeta = project => {
  if (!project) return "Nenhum projeto selecionado"
  if (project.permission !== "granted") return "Reconectar para abrir"
  if (project.gitRepository && project.gitBranch) return `⑂ ${project.gitBranch}`
  if (Number.isFinite(project.fileCount) && project.fileCount > 0) return `${project.fileCount} arquivos indexados`
  return project.loaded ? "Workspace carregado" : "Workspace disponível"
}

export default function ProjectSwitcher({ workspace, onAddProject, onSelectProject, onRemoveProject }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef(null)
  const searchRef = useRef(null)
  const projects = workspace.projects || []
  const activeProject = workspace.activeProject || projects.find(project => project.id === workspace.activeProjectId) || null
  const busy = Boolean(workspace.projectSwitching || workspace.workspaceBusy || workspace.scanning)
  const disabled = !workspace.projectRegistryReady || busy

  const filteredProjects = useMemo(() => {
    const term = normalize(query)
    const sorted = [...projects].sort((left, right) => {
      if (left.id === workspace.activeProjectId) return -1
      if (right.id === workspace.activeProjectId) return 1
      return String(left.name || "").localeCompare(String(right.name || ""), "pt-BR", { sensitivity: "base" })
    })
    if (!term) return sorted
    return sorted.filter(project => {
      const haystack = [project.name, project.gitBranch, project.permission, project.fileCount].map(normalize).join(" ")
      return haystack.includes(term)
    })
  }, [projects, query, workspace.activeProjectId])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = event => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open || projects.length < 6) return
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open, projects.length])

  useEffect(() => {
    if (busy) setOpen(false)
  }, [busy])

  const toggleOpen = () => {
    if (disabled) return
    setOpen(value => !value)
    setQuery("")
  }

  const selectProject = async project => {
    if (!project || project.id === workspace.activeProjectId) {
      setOpen(false)
      return
    }
    const changed = await onSelectProject(project.id)
    if (changed !== false) setOpen(false)
  }

  const addProject = async () => {
    setOpen(false)
    await onAddProject()
  }

  const removeProject = async (event, project) => {
    event.stopPropagation()
    const removed = await onRemoveProject(project)
    if (removed !== false && projects.length <= 1) setOpen(false)
  }

  return (
    <div className={`ide-project-hub${open ? " open" : ""}`} ref={rootRef} data-busy={busy ? "true" : "false"}>
      <button
        type="button"
        className="ide-project-trigger"
        onClick={toggleOpen}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Trocar projeto da IDE"
      >
        <span className="ide-project-trigger-icon">▣</span>
        <span className="ide-project-trigger-copy">
          <span className="ide-project-trigger-kicker">
            <em>Projeto ativo</em>
            <b>{projects.length} {projects.length === 1 ? "projeto" : "projetos"}</b>
          </span>
          <strong>{activeProject?.name || (workspace.projectRegistryReady ? "Selecionar projeto" : "Carregando projetos…")}</strong>
          <small>{busy ? "Atualizando workspace…" : projectMeta(activeProject)}</small>
        </span>
        <span className="ide-project-trigger-caret">⌄</span>
      </button>

      <button
        type="button"
        className="ide-project-add-primary"
        onClick={addProject}
        disabled={disabled}
        title="Adicionar outro projeto à IDE"
      >
        <span>＋</span><strong>Projeto</strong>
      </button>

      {open ? (
        <div className="ide-project-menu" role="dialog" aria-label="Projetos da IDE">
          <div className="ide-project-menu-head">
            <div>
              <span>Workspaces locais</span>
              <strong>Trocar projeto</strong>
              <small>O contexto, abas e alterações ficam isolados por projeto.</small>
            </div>
            <button type="button" onClick={addProject} disabled={disabled}><span>＋</span> Adicionar</button>
          </div>

          {projects.length >= 6 ? (
            <label className="ide-project-search">
              <span>⌕</span>
              <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar projeto, branch ou status…" />
              {query ? <button type="button" onClick={() => setQuery("")} aria-label="Limpar busca">×</button> : null}
            </label>
          ) : null}

          <div className="ide-project-list" role="listbox" aria-label="Projetos disponíveis">
            {filteredProjects.map(project => {
              const active = project.id === workspace.activeProjectId
              const reconnect = project.permission !== "granted"
              return (
                <div key={project.id} className={`ide-project-item${active ? " active" : ""}${reconnect ? " reconnect" : ""}`}>
                  <button type="button" className="ide-project-item-main" onClick={() => selectProject(project)} role="option" aria-selected={active}>
                    <span className="ide-project-item-icon">{active ? "◆" : "◇"}</span>
                    <span className="ide-project-item-copy">
                      <span className="ide-project-item-title">
                        <strong>{project.name}</strong>
                        {active ? <em>Ativo</em> : null}
                      </span>
                      <small>{projectMeta(project)}</small>
                    </span>
                    <span className="ide-project-item-status">
                      {project.dirtyCount ? <b className="dirty">{project.dirtyCount} não salvo{project.dirtyCount === 1 ? "" : "s"}</b> : null}
                      {reconnect ? <b className="reconnect">Reconectar</b> : null}
                      {!project.dirtyCount && !reconnect && active ? <b className="ready">Em uso</b> : null}
                    </span>
                  </button>
                  <button type="button" className="ide-project-item-remove" onClick={event => removeProject(event, project)} disabled={busy} title={`Remover ${project.name} da lista da IDE`} aria-label={`Remover ${project.name} da lista da IDE`}>×</button>
                </div>
              )
            })}
            {!filteredProjects.length ? <div className="ide-project-empty"><strong>Nenhum projeto encontrado</strong><span>Tente outro termo ou adicione um novo workspace.</span></div> : null}
          </div>

          <div className="ide-project-menu-foot">
            <span><i /> read/write</span>
            <small>Trocar de projeto não descarta o estado dos demais workspaces.</small>
          </div>
        </div>
      ) : null}
    </div>
  )
}
