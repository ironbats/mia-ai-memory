import React, { useMemo, useState } from "react"
import KeyValueEditor, { objectToRows, rowsToObject } from "./KeyValueEditor.jsx"
import Modal from "./Modal.jsx"

const secretRowsFor = credential => {
  const keys = Object.keys(credential?.maskedFields || {})
  return keys.length ? keys.map(key => ({ key, value: "" })) : [{ key: "token", value: "" }]
}

export default function McpEditor({ mcp, credentials, onClose, onSave }) {
  const editing = Boolean(mcp)
  const [name, setName] = useState(mcp?.name || "")
  const [description, setDescription] = useState(mcp?.description || "")
  const [transport, setTransport] = useState(mcp?.transport || "streamable-http")
  const [endpointUrl, setEndpointUrl] = useState(mcp?.endpointUrl || "")
  const [command, setCommand] = useState(mcp?.command || "")
  const [argsText, setArgsText] = useState((mcp?.args || []).join("\n"))
  const [publicHeaders, setPublicHeaders] = useState(objectToRows(mcp?.publicHeaders || {}))
  const [publicEnv, setPublicEnv] = useState(objectToRows(mcp?.publicEnv || {}))
  const [authType, setAuthType] = useState(mcp?.authType || "none")
  const [enabled, setEnabled] = useState(mcp?.enabled !== false)
  const [credentialChoice, setCredentialChoice] = useState(mcp?.credentialId || "none")
  const [credentialName, setCredentialName] = useState(mcp?.credential?.name || "")
  const [secretRows, setSecretRows] = useState(secretRowsFor(mcp?.credential))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const selectedCredential = useMemo(() => credentials.find(item => item.id === credentialChoice), [credentials, credentialChoice])
  const needsSecret = credentialChoice === "__new__" || credentialChoice === "__rotate__"

  const submit = async event => {
    event.preventDefault()
    setSaving(true)
    setError("")
    try {
      let credential
      if (credentialChoice === "none") credential = { mode: "none" }
      else if (credentialChoice === "__new__") credential = {
        mode: "new",
        name: credentialName || `${name || "mcp"} credential`,
        kind: authType || "token",
        provider: "mcp",
        secrets: rowsToObject(secretRows)
      }
      else if (credentialChoice === "__rotate__") credential = {
        mode: "rotate",
        name: credentialName || mcp?.credential?.name,
        kind: mcp?.credential?.kind || authType || "token",
        provider: mcp?.credential?.provider || "mcp",
        secrets: rowsToObject(secretRows)
      }
      else credential = { mode: "existing", id: credentialChoice }

      await onSave({
        name,
        description,
        transport,
        endpointUrl,
        command,
        args: argsText.split("\n").map(item => item.trim()).filter(Boolean),
        publicHeaders: rowsToObject(publicHeaders),
        publicEnv: rowsToObject(publicEnv),
        authType,
        enabled,
        credential
      })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={editing ? "Editar MCP" : "Cadastrar MCP"} subtitle="Cadastre qualquer servidor MCP HTTP, SSE ou stdio e mantenha autenticação separada da configuração pública." onClose={onClose} wide>
      <form className="config-form" onSubmit={submit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="form-grid two">
          <label><span>Nome do MCP</span><input required value={name} onChange={event => setName(event.target.value)} placeholder="GitHub MCP" /></label>
          <label><span>Transporte</span><select value={transport} onChange={event => setTransport(event.target.value)}><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option></select></label>
        </div>
        <label><span>Descrição</span><textarea rows="2" value={description} onChange={event => setDescription(event.target.value)} placeholder="O que esse MCP oferece aos agentes" /></label>
        {transport === "stdio" ? (
          <div className="form-grid two"><label><span>Comando</span><input required value={command} onChange={event => setCommand(event.target.value)} placeholder="npx" /></label><label><span>Argumentos</span><textarea rows="4" value={argsText} onChange={event => setArgsText(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-example'} /><small>Um argumento por linha.</small></label></div>
        ) : <label><span>Endpoint</span><input required value={endpointUrl} onChange={event => setEndpointUrl(event.target.value)} placeholder="https://mcp.exemplo.com/mcp" /></label>}

        <section className="form-section">
          <div className="form-section-head"><div><strong>Autenticação</strong><span>Segredos são criptografados com AES-256-GCM.</span></div></div>
          <div className="form-grid two">
            <label><span>Tipo</span><select value={authType} onChange={event => setAuthType(event.target.value)}><option value="none">Sem autenticação</option><option value="bearer">Bearer token</option><option value="api-key">API key</option><option value="oauth-token">OAuth token</option><option value="custom">Custom</option></select></label>
            <label><span>Credencial</span><select value={credentialChoice} onChange={event => {
              const next = event.target.value
              setCredentialChoice(next)
              if (next === "__rotate__") setSecretRows(secretRowsFor(mcp?.credential))
            }}><option value="none">Sem credencial</option>{credentials.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new__">+ Nova credencial</option>{editing && mcp?.credential ? <option value="__rotate__">↻ Rotacionar credencial atual</option> : null}</select></label>
          </div>
          {needsSecret ? <><label><span>Nome da credencial</span><input value={credentialName} onChange={event => setCredentialName(event.target.value)} placeholder={`${name || "mcp"} credential`} /></label><KeyValueEditor label="Campos secretos" hint="Use os nomes exigidos pelo MCP, como token, api_key, client_secret ou Authorization." rows={secretRows} onChange={setSecretRows} secret /></> : credentialChoice !== "none" ? <div className="credential-preview"><span>Credencial selecionada</span><strong>{selectedCredential?.name || mcp?.credential?.name}</strong><small>{Object.values(selectedCredential?.maskedFields || mcp?.credential?.maskedFields || {}).join(" · ")}</small></div> : null}
        </section>

        <section className="form-section">
          <div className="form-section-head"><div><strong>Configuração pública</strong><span>Headers e variáveis sem segredo podem ficar visíveis no cadastro.</span></div></div>
          <KeyValueEditor label="Headers públicos" rows={publicHeaders} onChange={setPublicHeaders} keyPlaceholder="X-Client" valuePlaceholder="valor" />
          <KeyValueEditor label="Variáveis de ambiente públicas" rows={publicEnv} onChange={setPublicEnv} keyPlaceholder="LOG_LEVEL" valuePlaceholder="info" />
        </section>

        <label className="toggle-field"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span><strong>MCP ativo</strong><small>Disponível para associação com agentes cadastrados.</small></span></label>
        <footer className="form-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Salvando…" : editing ? "Salvar alterações" : "Cadastrar MCP"}</button></footer>
      </form>
    </Modal>
  )
}
