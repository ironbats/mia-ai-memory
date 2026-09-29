import React from "react"

const ExplorerIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 3.75h6.5l2 2H20v14.5H4z" />
    <path d="M4 8h16" />
  </svg>
)

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="5.75" />
    <path d="m15 15 5 5" />
  </svg>
)

const SourceControlIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="7" cy="5" r="2" />
    <circle cx="17" cy="7" r="2" />
    <circle cx="7" cy="19" r="2" />
    <path d="M7 7v10M9 11c5 0 6-2 6-2" />
  </svg>
)

const ProblemsIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3.5 21 20H3z" />
    <path d="M12 9v5" />
    <path d="M12 17.25h.01" />
  </svg>
)

const OutlineIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 5h12M6 12h12M6 19h12" />
    <path d="M3.5 5h.01M3.5 12h.01M3.5 19h.01" />
  </svg>
)

const TerminalIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 7 4 5-4 5M12 17h7" />
  </svg>
)

const ActivityButton = ({ label, title, active, badge, onClick, children }) => (
  <button type="button" className={active ? "active" : ""} aria-label={label} aria-pressed={active} title={title} onClick={onClick}>
    <span className="ide-activity-icon">{children}</span>
    {badge !== undefined && badge !== null && Number(badge) > 0 ? <b>{Number(badge) > 99 ? "99+" : badge}</b> : null}
  </button>
)

export default function IdeActivityBar({ sidebarMode, explorerVisible, workbenchPanel, changeCount, problemCount, symbolCount, terminalRuntimeAvailable, onExplorer, onSearch, onPanel }) {
  return (
    <nav className="ide-activitybar" aria-label="Navegacao principal da IDE">
      <div className="ide-activitybar-primary">
        <ActivityButton label="Explorer" title="Explorer · Ctrl/Cmd+Shift+E" active={explorerVisible && sidebarMode === "files"} onClick={onExplorer}><ExplorerIcon /></ActivityButton>
        <ActivityButton label="Buscar" title="Buscar no projeto · Ctrl/Cmd+Shift+F" active={explorerVisible && sidebarMode === "search"} onClick={onSearch}><SearchIcon /></ActivityButton>
        <ActivityButton label="Source Control" title="Source Control · Ctrl/Cmd+Shift+G" active={workbenchPanel === "changes"} badge={changeCount} onClick={() => onPanel("changes")}><SourceControlIcon /></ActivityButton>
        <ActivityButton label="Problems" title="Problems · Ctrl/Cmd+Shift+M" active={workbenchPanel === "problems"} badge={problemCount} onClick={() => onPanel("problems")}><ProblemsIcon /></ActivityButton>
        <ActivityButton label="Outline" title="Outline · Ctrl/Cmd+Shift+O" active={workbenchPanel === "outline"} badge={symbolCount} onClick={() => onPanel("outline")}><OutlineIcon /></ActivityButton>
      </div>
      <div className="ide-activitybar-secondary">
        <ActivityButton label="Terminal" title="Terminal · Ctrl/Cmd+`" active={workbenchPanel === "terminal"} onClick={() => onPanel("terminal")}><TerminalIcon /></ActivityButton>
        <span className={`ide-activity-runtime${terminalRuntimeAvailable ? " online" : ""}`} title={terminalRuntimeAvailable ? "Workspace Runtime conectado" : "Workspace Runtime indisponivel"}>{terminalRuntimeAvailable ? "HOST" : "WEB"}</span>
      </div>
    </nav>
  )
}
