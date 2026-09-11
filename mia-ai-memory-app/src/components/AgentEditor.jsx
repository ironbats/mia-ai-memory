import React, { useMemo, useState } from "react"
import KeyValueEditor, { rowsToObject } from "./KeyValueEditor.jsx"
import Modal from "./Modal.jsx"

const providers = ["OpenAI", "Anthropic", "Google Gemini", "xAI", "Cursor", "Azure OpenAI", "OpenAI Compatible", "Ollama", "Claude Code", "Codex", "OpenCode", "Custom"]

const credentialRows = credential => {
  const keys = Object.keys(credential?.maskedFields || {})
  return keys.length ? keys.map(key => ({ key, value: "" })) : [{ key: "api_key", value: "" }]
}

const adapterForProvider = provider => {
  const value = provider.trim().toLowerCase()
  if (value === "openai") return "openai-responses"
  if (value === "anthropic") return "anthropic-messages"
  if (value === "google gemini") return "gemini-generate-content"
  if (value === "xai") return "xai-responses"
  if (value === "cursor") return "cursor-cloud"
  if (value === "openai compatible") return "openai-responses"
  return ""
}

export default function AgentEditor({ agent, mcps, credentials, models = [], scope, onClose, onSave }) {
  const editing = Boolean(agent)
  const initialCredentialChoice = agent?.credentialId || (editing ? "none" : "__new__")
  const [name, setName] = useState(agent?.name || "")
  const [description, setDescription] = useState(agent?.description || "")
  const [connectionType, setConnectionType] = useState(agent?.connectionType || "api-key")
  const [provider, setProvider] = useState(agent?.provider || "OpenAI")
  const [model, setModel] = useState(agent?.model || "")
  const [baseUrl, setBaseUrl] = useState(agent?.baseUrl || "")
  const [workspace, setWorkspace] = useState(agent?.workspace || scope?.workspace || "")
  const [project, setProject] = useState(agent?.project || scope?.project || "")
  const [observedAgentKind, setObservedAgentKind] = useState(agent?.observedAgentKind || "")
  const [enabled, setEnabled] = useState(agent?.enabled !== false)
  const [mcpIds, setMcpIds] = useState(agent?.mcpServers?.map(item => item.id) || [])
  const [credentialChoice, setCredentialChoice] = useState(initialCredentialChoice)
  const [credentialName, setCredentialName] = useState(agent?.credential?.name || "")
  const [secretRows, setSecretRows] = useState(credentialRows(agent?.credential))
  const [cursorRepositoryUrl, setCursorRepositoryUrl] = useState(agent?.settings?.cursor?.repositoryUrl || "")
  const [cursorStartingRef, setCursorStartingRef] = useState(agent?.settings?.cursor?.startingRef || "main")
  const [cursorConversationMode, setCursorConversationMode] = useState(agent?.settings?.cursor?.conversationMode || "agent")
  const [cursorAutoCreatePR, setCursorAutoCreatePR] = useState(agent?.settings?.cursor?.autoCreatePR === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const selectedCredential = useMemo(() => credentials.find(item => item.id === credentialChoice), [credentials, credentialChoice])
  const availableModels = useMemo(() => models.filter(item => item.provider.toLowerCase() === provider.toLowerCase()), [models, provider])
  const needsCredentialFields = credentialChoice === "__new__" || credentialChoice === "__rotate__"
  const showMcpBindings = connectionType === "mcp" || connectionType === "hybrid"
  const isCursor = provider.toLowerCase() === "cursor"

  const toggleMcp = id => setMcpIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])

  const changeProvider = value => {
    setProvider(value)
    const candidate = models.find(item => item.provider.toLowerCase() === value.toLowerCase() && item.isDefault)
    if (candidate) setModel(candidate.modelId)
  }

  const submit = async event => {
    event.preventDefault()
    setSaving(true)
    setError("")
    try {
      let credential
      if (!(connectionType === "api-key" || connectionType === "hybrid")) credential = { mode: "none" }
      else if (credentialChoice === "none") credential = { mode: "none" }
      else if (credentialChoice === "__new__") credential = {
        mode: "new",
        name: credentialName || `${name || "agent"} credential`,
        kind: "api-key",
        provider,
        secrets: rowsToObject(secretRows)
      }
      else if (credentialChoice === "__rotate__") credential = {
        mode: "rotate",
        name: credentialName || agent?.credential?.name,
        kind: agent?.credential?.kind || "api-key",
        provider: provider || agent?.credential?.provider || "",
        secrets: rowsToObject(secretRows)
      }
      else credential = { mode: "existing", id: credentialChoice }

      const nextSettings = { ...(agent?.settings || {}) }
      const adapter = adapterForProvider(provider)
      if (adapter) nextSettings.adapter = adapter
      if (isCursor) {
        nextSettings.cursor = {
          repositoryUrl: cursorRepositoryUrl,
          startingRef: cursorStartingRef || "main",
          conversationMode: cursorConversationMode || "agent",
          autoCreatePR: cursorAutoCreatePR
        }
      }

      await onSave({
        name,
        description,
        connectionType,
        provider,
        model,
        baseUrl,
        workspace,
        project,
        observedAgentKind,
        enabled,
        mcpIds: showMcpBindings ? mcpIds : [],
        settings: nextSettings,
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
    <Modal title={editing ? "Editar agente" : "Cadastrar agente"} subtitle="Configure um executor por API key, MCP ou modo híbrido. O chat preserva a memória fora do agente." onClose={onClose} wide>
      <form className="config-form" onSubmit={submit}>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="form-grid two">
          <label><span>Nome do agente</span><input required value={name} onChange={event => setName(event.target.value)} placeholder="Backend Principal Engineer" /></label>
          <label><span>Tipo de conexão</span><select value={connectionType} onChange={event => setConnectionType(event.target.value)}><option value="api-key">API Key</option><option value="mcp">MCP</option><option value="hybrid">API Key + MCP</option><option value="external">Agente externo</option></select></label>
        </div>
        <label><span>Descrição</span><textarea rows="2" value={description} onChange={event => setDescription(event.target.value)} placeholder="Responsabilidade e contexto desse agente" /></label>
        <div className="form-grid three">
          <label><span>Provider</span><input list="agent-provider-options" value={provider} onChange={event => changeProvider(event.target.value)} placeholder="OpenAI, Anthropic, xAI..." /><datalist id="agent-provider-options">{providers.map(item => <option key={item} value={item} />)}</datalist></label>
          <label><span>Modelo</span><input list="agent-model-options" value={model} onChange={event => setModel(event.target.value)} placeholder="Selecione ou informe o model id" /><datalist id="agent-model-options">{availableModels.map(item => <option key={item.id} value={item.modelId}>{item.displayName}</option>)}</datalist><small>{availableModels.length ? `${availableModels.length} modelos default disponíveis para ${provider}.` : "Model id livre para providers customizados."}</small></label>
          <label><span>Base URL</span><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.exemplo.com/v1" /></label>
        </div>
        <div className="form-grid three">
          <label><span>Workspace</span><input value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="vazio = global" /></label>
          <label><span>Projeto</span><input value={project} onChange={event => setProject(event.target.value)} placeholder="vazio = global" /></label>
          <label><span>Identificador observado</span><input value={observedAgentKind} onChange={event => setObservedAgentKind(event.target.value)} placeholder="claude-code, codex, cursor..." /><small>Correlaciona sessões reais e capturas de memória com este agente.</small></label>
        </div>

        {isCursor ? (
          <section className="form-section">
            <div className="form-section-head"><div><strong>Cursor Cloud</strong><span>Configuração de execução remota para o chat.</span></div></div>
            <label><span>Repository URL</span><input required value={cursorRepositoryUrl} onChange={event => setCursorRepositoryUrl(event.target.value)} placeholder="https://github.com/org/repository" /></label>
            <div className="form-grid two">
              <label><span>Starting ref</span><input value={cursorStartingRef} onChange={event => setCursorStartingRef(event.target.value)} placeholder="main" /></label>
              <label><span>Conversation mode</span><select value={cursorConversationMode} onChange={event => setCursorConversationMode(event.target.value)}><option value="agent">agent</option><option value="plan">plan</option></select></label>
            </div>
            <label className="toggle-field"><input type="checkbox" checked={cursorAutoCreatePR} onChange={event => setCursorAutoCreatePR(event.target.checked)} /><span><strong>Criar PR automaticamente</strong><small>Ative apenas quando o fluxo do repositório permitir publicação automática.</small></span></label>
          </section>
        ) : null}

        {(connectionType === "api-key" || connectionType === "hybrid") ? (
          <section className="form-section">
            <div className="form-section-head"><div><strong>Credencial</strong><span>A chave nunca volta em texto aberto pela API.</span></div></div>
            <div className="form-grid two">
              <label><span>Usar credencial</span><select value={credentialChoice} onChange={event => {
                const next = event.target.value
                setCredentialChoice(next)
                if (next === "__rotate__") setSecretRows(credentialRows(agent?.credential))
              }}><option value="none">Sem credencial</option>{credentials.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new__">+ Nova credencial</option>{editing && agent?.credential ? <option value="__rotate__">↻ Rotacionar credencial atual</option> : null}</select></label>
              {needsCredentialFields ? <label><span>Nome da credencial</span><input value={credentialName} onChange={event => setCredentialName(event.target.value)} placeholder={`${name || "agent"} credential`} /></label> : <div className="credential-preview"><span>Selecionada</span><strong>{selectedCredential?.name || agent?.credential?.name || "Nenhuma"}</strong><small>{Object.values(selectedCredential?.maskedFields || agent?.credential?.maskedFields || {}).join(" · ")}</small></div>}
            </div>
            {needsCredentialFields ? <KeyValueEditor label="Campos secretos" hint="Use api_key para os agentes default. O valor é criptografado pelo vault." rows={secretRows} onChange={setSecretRows} secret keyPlaceholder="api_key" valuePlaceholder="Valor secreto" /> : null}
          </section>
        ) : null}

        {showMcpBindings ? (
          <section className="form-section">
            <div className="form-section-head"><div><strong>MCP Servers</strong><span>Associe um ou mais MCPs já cadastrados.</span></div></div>
            <div className="binding-grid">
              {mcps.map(mcp => <label className={`binding-card${mcpIds.includes(mcp.id) ? " selected" : ""}`} key={mcp.id}><input type="checkbox" checked={mcpIds.includes(mcp.id)} onChange={() => toggleMcp(mcp.id)} /><span><strong>{mcp.name}</strong><small>{mcp.transport} · {mcp.enabled ? "ativo" : "inativo"}</small></span></label>)}
              {!mcps.length ? <div className="form-empty">Nenhum MCP cadastrado. Salve este agente depois de cadastrar o MCP desejado.</div> : null}
            </div>
          </section>
        ) : null}

        <label className="toggle-field"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span><strong>Agente ativo</strong><small>Quando ativo, fica disponível como executor no chat.</small></span></label>
        <footer className="form-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Salvando…" : editing ? "Salvar alterações" : "Cadastrar agente"}</button></footer>
      </form>
    </Modal>
  )
}
