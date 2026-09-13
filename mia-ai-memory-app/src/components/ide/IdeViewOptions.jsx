import React, { useEffect, useRef } from "react"

export default function IdeViewOptions({ layout, onLayoutChange, explorerHidden, onToggleExplorer, onReset,
  zoom, onZoom, onResetZoom, panelOpen, onTogglePanel }) {
  const ref = useRef(null)
  useEffect(() => {
    const outside = event => { if (!ref.current?.contains(event.target)) ref.current?.removeAttribute("open") }
    const escape = event => { if (event.key === "Escape" && ref.current?.open) { ref.current.removeAttribute("open"); ref.current.querySelector("summary")?.focus() } }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape) }
  }, [])
  return <details className="ide-view-options" ref={ref}>
    <summary title="Configurar aparência e distribuição dos painéis">◫ Visualizar</summary>
    <div className="ide-view-menu" aria-label="Opções de visualização">
      <strong>Distribuição IDE / chat</strong>
      <div className="ide-view-presets">{[["compact", "Mais chat"], ["split", "Equilibrado"], ["wide", "Mais IDE"]].map(([id, label]) => <button key={id} aria-pressed={layout === id} onClick={() => onLayoutChange(id)}>{label}</button>)}</div>
      <p>Arraste a divisória central para escolher a proporção. Duplo clique restaura 50/50.</p>
      <button aria-pressed={!explorerHidden} onClick={onToggleExplorer}>{explorerHidden ? "Mostrar" : "Recolher"} explorador <kbd>Ctrl+B</kbd></button>
      <button aria-pressed={panelOpen} onClick={onTogglePanel}>{panelOpen ? "Recolher" : "Mostrar"} painel inferior <kbd>Ctrl+J</kbd></button>
      <strong>Escala da IDE</strong>
      <div className="ide-view-presets"><button disabled={zoom <= 90} onClick={() => onZoom(-1)}>−</button><button onClick={onResetZoom}>{zoom}%</button><button disabled={zoom >= 130} onClick={() => onZoom(1)}>+</button></div>
      <button onClick={onReset}>Restaurar layout e escala</button>
    </div>
  </details>
}
