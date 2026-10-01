import React, { useRef, useState } from "react"
import { api } from "../lib/api.js"
import { confirmAction } from "../lib/dialogService.js"
import Modal from "./Modal.jsx"

const formatSize = value => {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function SkillManager({ scope, skills = [], onClose, onChanged }) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const enabledCount = skills.filter(skill => skill.enabled).length

  const upload = async fileList => {
    const files = [...fileList]
    if (!files.length) return
    const invalid = files.find(file => !file.name.toLowerCase().endsWith(".md"))
    if (invalid) {
      setError(`O arquivo ${invalid.name} não é um Skill .md.`)
      return
    }
    setBusy("upload")
    setError("")
    try {
      for (const file of files) await api.uploadChatSkill(scope, file)
      await onChanged?.()
    } catch (uploadError) {
      setError(uploadError.message || String(uploadError))
    } finally {
      setBusy("")
    }
  }

  const toggle = async skill => {
    setBusy(skill.id)
    setError("")
    try {
      await api.setChatSkillEnabled(skill.id, scope, !skill.enabled)
      await onChanged?.()
    } catch (toggleError) {
      setError(toggleError.message || String(toggleError))
    } finally {
      setBusy("")
    }
  }

  const remove = async skill => {
    const confirmed = await confirmAction({
      tone: "danger",
      title: "Excluir Skill?",
      description: `O Skill “${skill.name}” deixará de ser aplicado aos próximos turnos deste projeto.`,
      confirmLabel: "Excluir Skill"
    })
    if (!confirmed) return
    setBusy(skill.id)
    setError("")
    try {
      await api.deleteChatSkill(skill.id, scope)
      await onChanged?.()
    } catch (deleteError) {
      setError(deleteError.message || String(deleteError))
    } finally {
      setBusy("")
    }
  }

  return (
    <Modal title="Skills do projeto" subtitle="Arquivos Markdown ativos viram guardrails persistentes para todo turno do chat neste workspace/projeto." onClose={onClose} wide>
      <div className="chat-skill-manager">
        <div className="chat-skill-summary">
          <div><strong>{enabledCount}</strong><span>ativos</span></div>
          <div><strong>{skills.length}</strong><span>cadastrados</span></div>
          <p>O conteúdo de cada <b>.md</b> ativo é enviado automaticamente ao agente, independente do modelo escolhido. Reenviar um arquivo com o mesmo nome atualiza o Skill existente.</p>
          <input ref={inputRef} hidden type="file" accept=".md,text/markdown,text/plain" multiple onChange={event => { upload(event.target.files); event.target.value = "" }} />
          <button className="primary-button compact" onClick={() => inputRef.current?.click()} disabled={Boolean(busy)}>{busy === "upload" ? "Adicionando…" : "+ Adicionar .md"}</button>
        </div>

        {error ? <div className="chat-skill-error">{error}</div> : null}

        <div className="chat-skill-list">
          {skills.map(skill => (
            <article key={skill.id} className={`chat-skill-row${skill.enabled ? " enabled" : " disabled"}`}>
              <div className="chat-skill-icon">MD</div>
              <div className="chat-skill-info">
                <strong>{skill.name}</strong>
                <span>{skill.fileName} · {formatSize(skill.sizeBytes)}</span>
                <small>SHA {String(skill.sha256 || "").slice(0, 12)} · {skill.enabled ? "aplicado automaticamente" : "desativado"}</small>
              </div>
              <button className={`chat-skill-toggle${skill.enabled ? " active" : ""}`} onClick={() => toggle(skill)} disabled={Boolean(busy)} aria-pressed={skill.enabled}>{busy === skill.id ? "…" : skill.enabled ? "Ativo" : "Inativo"}</button>
              <button className="chat-skill-delete" onClick={() => remove(skill)} disabled={Boolean(busy)} title="Excluir Skill">×</button>
            </article>
          ))}
          {!skills.length ? <div className="chat-skill-empty"><strong>Nenhum Skill cadastrado.</strong><span>Adicione um .md com regras de arquitetura, padrões de código, guardrails, definição de pronto ou qualquer instrução persistente que o agente deve obedecer.</span></div> : null}
        </div>
      </div>
    </Modal>
  )
}
