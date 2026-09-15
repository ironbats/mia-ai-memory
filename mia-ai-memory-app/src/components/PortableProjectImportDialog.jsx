import React, { useEffect, useRef, useState } from "react"
import useDialogFocus from "../hooks/useDialogFocus.js"

const supportsDirectoryInput = () => {
  if (typeof document === "undefined") return false
  const input = document.createElement("input")
  return "webkitdirectory" in input
}

export default function PortableProjectImportDialog({ open, busy = false, error = "", folderPickerSupported = false, onCancel, onDropProject, onPickFolder, onFolderFiles, onZipProject }) {
  const dialogRef = useRef(null)
  const fileInputRef = useRef(null)
  const directoryInputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)
  const directoryInputSupported = supportsDirectoryInput()
  useDialogFocus(dialogRef, open)

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = event => {
      if (event.key !== "Escape" || busy) return
      event.preventDefault()
      onCancel?.()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [busy, onCancel, open])

  useEffect(() => {
    if (!open) setDragActive(false)
  }, [open])

  useEffect(() => {
    const input = directoryInputRef.current
    if (!input) return
    input.setAttribute("webkitdirectory", "")
    input.setAttribute("directory", "")
  }, [open])

  if (!open) return null

  const handleDrop = event => {
    event.preventDefault()
    event.stopPropagation()
    setDragActive(false)
    if (busy) return
    onDropProject?.(event.dataTransfer)
  }

  const handleZip = event => {
    const file = event.target.files?.[0] || null
    event.target.value = ""
    if (!file || busy) return
    onZipProject?.(file)
  }

  const handleFolderFiles = event => {
    const files = [...(event.target.files || [])]
    event.target.value = ""
    if (!files.length || busy) return
    onFolderFiles?.(files)
  }

  const openFolderSelection = () => {
    if (busy) return
    if (folderPickerSupported) {
      onPickFolder?.()
      return
    }
    if (directoryInputSupported && directoryInputRef.current) {
      directoryInputRef.current.value = ""
      directoryInputRef.current.click()
      return
    }
    onPickFolder?.()
  }

  const folderDescription = folderPickerSupported
    ? "Solte a pasta raiz aqui ou clique para abri-la pelo seletor de diretório do navegador."
    : directoryInputSupported
      ? "Solte a pasta raiz aqui ou clique em Selecionar pasta. Neste modo de compatibilidade, o navegador pode exibir a própria confirmação de segurança antes de liberar os arquivos."
      : "Solte a pasta raiz aqui. Este navegador não expõe seleção de diretório por clique; use arrastar e soltar ou importe um ZIP."

  const folderDetail = folderPickerSupported
    ? "Leitura local pelo seletor seguro de diretório"
    : directoryInputSupported
      ? "Seleção compatível de pasta · estrutura preservada"
      : "Arraste a pasta ou utilize ZIP neste navegador"

  return (
    <div className="ide-dialog-backdrop portable-import-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !busy) onCancel?.()
    }}>
      <section ref={dialogRef} className="portable-import-dialog" role="dialog" aria-modal="true" aria-label="Importar projeto no Browser Workspace">
        <header className="portable-import-head">
          <span className="portable-import-mark">&lt;/&gt;</span>
          <div>
            <span className="eyebrow">AI Memory IDE · Browser Workspace</span>
            <h3>Importar projeto neste navegador</h3>
            <p>Escolha a origem do projeto. O AI Memory mantém as confirmações da aplicação dentro da própria UX; permissões de segurança do sistema continuam sob controle do navegador.</p>
          </div>
        </header>

        <div className="portable-import-methods">
          <button
            type="button"
            className={`portable-import-drop${dragActive ? " dragging" : ""}`}
            onClick={openFolderSelection}
            onDragEnter={event => { event.preventDefault(); if (!busy) setDragActive(true) }}
            onDragOver={event => { event.preventDefault(); if (!busy) setDragActive(true) }}
            onDragLeave={event => {
              event.preventDefault()
              if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false)
            }}
            onDrop={handleDrop}
            disabled={busy}
          >
            <span className="portable-import-method-icon">↳</span>
            <strong>Arraste ou selecione a pasta do projeto</strong>
            <small>{folderDescription}</small>
            <span className="portable-import-method-action">Selecionar pasta</span>
            <em>{folderDetail}</em>
          </button>

          <div className="portable-import-divider"><span>ou</span></div>

          <button type="button" className="portable-import-zip" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <span className="portable-import-method-icon">ZIP</span>
            <strong>Selecionar arquivo ZIP</strong>
            <small>Funciona entre navegadores e máquinas sem depender do acesso direto à pasta original.</small>
            <em>.zip · dependências, builds e segredos são ignorados</em>
          </button>

          <input
            ref={directoryInputRef}
            className="portable-import-file-input"
            type="file"
            multiple
            onChange={handleFolderFiles}
            tabIndex={-1}
            aria-hidden="true"
          />
          <input ref={fileInputRef} className="portable-import-file-input" type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={handleZip} tabIndex={-1} aria-hidden="true" />
        </div>

        {busy ? <div className="portable-import-progress"><i /><div><strong>Preparando projeto…</strong><span>Lendo estrutura, filtrando artefatos e montando o workspace editável.</span></div></div> : null}
        {error ? <div className="portable-import-error"><strong>Não foi possível importar o projeto</strong><span>{error}</span></div> : null}

        <div className="portable-import-note">
          <span>LOCAL</span>
          <p>Nenhum arquivo é enviado automaticamente ao servidor por este importador. Este modo cria uma cópia editável no navegador e não altera a pasta física original. Para Git real, terminal real e escrita no disco, inicie o Workspace Runtime e adicione o projeto como HOST RW.</p>
        </div>

        <footer className="portable-import-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancelar</button>
        </footer>
      </section>
    </div>
  )
}
