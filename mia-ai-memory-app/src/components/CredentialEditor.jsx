import React, { useState } from "react"
import KeyValueEditor, { rowsToObject } from "./KeyValueEditor.jsx"
import Modal from "./Modal.jsx"

export default function CredentialEditor({ credential, onClose, onSave }) {
  const editing = Boolean(credential)
  const keys = Object.keys(credential?.maskedFields || {})
  const [name, setName] = useState(credential?.name || "")
  const [kind, setKind] = useState(credential?.kind || "api-key")
  const [provider, setProvider] = useState(credential?.provider || "")
  const [rows, setRows] = useState(keys.length ? keys.map(key => ({ key, value: "" })) : [{ key: "api_key", value: "" }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const submit = async event => {
    event.preventDefault()
    setSaving(true)
    setError("")
    try {
      await onSave({ name, kind, provider, secrets: rowsToObject(rows) })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={editing ? "Rotacionar credencial" : "Cadastrar credencial"} subtitle={editing ? "O valor atual não é exibido. Informe os novos segredos para substituir a versão armazenada." : "Cadastre uma chave reutilizável por agentes e MCPs."} onClose={onClose}>
      <form className="config-form" onSubmit={submit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="form-grid two"><label><span>Nome</span><input required value={name} onChange={event => setName(event.target.value)} placeholder="OpenAI produção" /></label><label><span>Tipo</span><input required value={kind} onChange={event => setKind(event.target.value)} placeholder="api-key, bearer, oauth-token" /></label></div>
        <label><span>Provider</span><input value={provider} onChange={event => setProvider(event.target.value)} placeholder="OpenAI, Anthropic, MCP..." /></label>
        <KeyValueEditor label="Campos secretos" hint="Nenhum valor secreto será retornado depois do salvamento." rows={rows} onChange={setRows} secret />
        <footer className="form-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Salvando…" : editing ? "Rotacionar" : "Salvar credencial"}</button></footer>
      </form>
    </Modal>
  )
}
