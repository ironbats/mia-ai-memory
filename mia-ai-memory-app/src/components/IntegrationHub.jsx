import React, { useCallback, useEffect, useMemo, useState } from "react"
import AgentEditor from "./AgentEditor.jsx"
import CredentialEditor from "./CredentialEditor.jsx"
import McpEditor from "./McpEditor.jsx"
import MetricCard from "./MetricCard.jsx"
import { api } from "../lib/api.js"
import { confirmAction } from "../lib/dialogService.js"

const number = value => new Intl.NumberFormat("pt-BR").format(Number(value || 0))

const endpointLabel = mcp => mcp.transport === "stdio" ? [mcp.command, ...(mcp.args || [])].join(" ") : mcp.endpointUrl

export default function IntegrationHub({ scope }) {
  const [summary, setSummary] = useState(null)
  const [agents, setAgents] = useState([])
  const [models, setModels] = useState([])
  const [mcps, setMcps] = useState([])
  const [credentials, setCredentials] = useState([])
  const [view, setView] = useState("agents")
  const [editor, setEditor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [summaryData, agentData, modelData, mcpData, credentialData] = await Promise.all([
        api.integrationsSummary(),
        api.configAgents(),
        api.configModels(),
        api.configMcps(),
        api.configCredentials()
      ])
      setSummary(summaryData)
      setAgents(agentData.agents || [])
      setModels(modelData.models || [])
      setMcps(mcpData.mcps || [])
      setCredentials(credentialData.credentials || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const activeObserved = useMemo(() => agents.filter(agent => Number(agent.observed?.sessions || 0) > 0).length, [agents])

  const saveAgent = async payload => {
    if (editor?.resource?.id) await api.updateConfigAgent(editor.resource.id, payload)
    else await api.createConfigAgent(payload)
    await load()
  }

  const saveMcp = async payload => {
    if (editor?.resource?.id) await api.updateConfigMcp(editor.resource.id, payload)
    else await api.createConfigMcp(payload)
    await load()
  }

  const saveCredential = async payload => {
    if (editor?.resource?.id) await api.rotateCredential(editor.resource.id, payload)
    else await api.createCredential(payload)
    await load()
  }

  const remove = async (kind, item) => {
    const kindLabel = kind === "agent" ? "agente" : kind === "mcp" ? "MCP" : "credencial"
    const confirmed = await confirmAction({
      tone: "danger",
      title: `Excluir ${kindLabel}?`,
      description: `Você está removendo “${item.name}”. A exclusão não deve ser usada para uma desativação temporária.`,
      confirmLabel: `Excluir ${kindLabel}`
    })
    if (!confirmed) return
    setError("")
    try {
      if (kind === "agent") await api.deleteConfigAgent(item.id)
      if (kind === "mcp") await api.deleteConfigMcp(item.id)
      if (kind === "credential") await api.deleteCredential(item.id)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const toggleAgent = async agent => {
    try {
      await api.setConfigAgentEnabled(agent.id, !agent.enabled)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const toggleMcp = async mcp => {
    try {
      await api.setConfigMcpEnabled(mcp.id, !mcp.enabled)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section className="content-section integrations-section">
      <div className="section-heading integrations-heading">
        <div><span className="eyebrow">Agent & MCP registry</span><h2>Configure quem usa a memória</h2><p>Cadastre agentes por API key, MCP, modo híbrido ou integração externa. Credenciais ficam criptografadas e nunca voltam em texto aberto.</p></div>
        <button className="primary-button" onClick={() => setEditor({ type: view === "mcps" ? "mcp" : view === "credentials" ? "credential" : "agent" })}>+ {view === "mcps" ? "Novo MCP" : view === "credentials" ? "Nova credencial" : "Novo agente"}</button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}
      {summary?.credentialVault?.configured === false ? <div className="warning-banner">O cofre de credenciais não está configurado. Defina COGNITIVE_CREDENTIALS_MASTER_KEY_BASE64 no backend antes de salvar chaves.</div> : null}

      <div className="integration-metrics">
        <MetricCard label="Agentes" value={number(summary?.agents)} detail={`${number(summary?.activeAgents)} ativos`} />
        <MetricCard label="MCP Servers" value={number(summary?.mcps)} detail={`${number(summary?.activeMcps)} ativos`} />
        <MetricCard label="Credenciais" value={number(summary?.credentials)} detail="segredos criptografados" />
        <MetricCard label="Modelos" value={number(models.length)} detail="catálogo disponível no chat" />
        <MetricCard label="Com atividade" value={number(activeObserved)} detail="correlacionados a sessões" tone={activeObserved ? "good" : "warning"} />
      </div>

      <div className="integration-nav">
        <button className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}>Agentes</button>
        <button className={view === "mcps" ? "active" : ""} onClick={() => setView("mcps")}>MCP Servers</button>
        <button className={view === "credentials" ? "active" : ""} onClick={() => setView("credentials")}>Credenciais</button>
      </div>

      {loading ? <div className="loading-panel"><div className="pulse-ring" />Carregando configurações…</div> : null}

      {!loading && view === "agents" ? (
        <div className="registry-grid">
          {agents.map(agent => (
            <article className="registry-card" key={agent.id}>
              <header><div className="registry-icon">{agent.name.slice(0, 2).toUpperCase()}</div><div><h3>{agent.name}</h3><span>{agent.provider || "Custom"}{agent.model ? ` · ${agent.model}` : ""}{agent.settings?.systemDefault ? " · padrão" : ""}</span></div><button className={`status-pill ${agent.enabled ? "active" : "inactive"}`} onClick={() => toggleAgent(agent)}>{agent.enabled ? "Ativo" : "Inativo"}</button></header>
              <p>{agent.description || "Sem descrição."}</p>
              <dl className="registry-details"><div><dt>Conexão</dt><dd>{agent.connectionType}</dd></div><div><dt>Escopo</dt><dd>{agent.workspace && agent.project ? `${agent.workspace}/${agent.project}` : "global"}</dd></div><div><dt>Credencial</dt><dd>{agent.credential?.name || "—"}</dd></div><div><dt>Modelos / MCPs</dt><dd>{models.filter(item => item.agentId === agent.id).length} / {agent.mcpServers?.length || 0}</dd></div></dl>
              <div className="observed-strip"><span>Execução observada</span><strong>{number(agent.observed?.sessions)} sessões</strong><small>{number(agent.observed?.observations)} observações · {number(agent.observed?.memories)} memórias</small></div>
              <footer><button className="secondary-button compact" onClick={() => setEditor({ type: "agent", resource: agent })}>Editar</button><button className="danger-button compact" disabled={agent.settings?.systemDefault === true} title={agent.settings?.systemDefault ? "Agente default: desative em vez de excluir." : "Excluir agente"} onClick={() => remove("agent", agent)}>{agent.settings?.systemDefault ? "Padrão" : "Excluir"}</button></footer>
            </article>
          ))}
          {!agents.length ? <div className="registry-empty"><strong>Nenhum agente cadastrado.</strong><span>Cadastre o primeiro agente por API key, MCP ou integração externa.</span><button className="primary-button" onClick={() => setEditor({ type: "agent" })}>+ Cadastrar agente</button></div> : null}
        </div>
      ) : null}

      {!loading && view === "mcps" ? (
        <div className="registry-grid">
          {mcps.map(mcp => (
            <article className="registry-card" key={mcp.id}>
              <header><div className="registry-icon mcp">M</div><div><h3>{mcp.name}</h3><span>{mcp.transport}</span></div><button className={`status-pill ${mcp.enabled ? "active" : "inactive"}`} onClick={() => toggleMcp(mcp)}>{mcp.enabled ? "Ativo" : "Inativo"}</button></header>
              <p>{mcp.description || "Sem descrição."}</p>
              <div className="endpoint-box">{endpointLabel(mcp) || "Endpoint não informado"}</div>
              <dl className="registry-details"><div><dt>Auth</dt><dd>{mcp.authType}</dd></div><div><dt>Credencial</dt><dd>{mcp.credential?.name || "—"}</dd></div><div><dt>Headers</dt><dd>{Object.keys(mcp.publicHeaders || {}).length}</dd></div><div><dt>Env</dt><dd>{Object.keys(mcp.publicEnv || {}).length}</dd></div></dl>
              <footer><button className="secondary-button compact" onClick={() => setEditor({ type: "mcp", resource: mcp })}>Editar</button><button className="danger-button compact" onClick={() => remove("mcp", mcp)}>Excluir</button></footer>
            </article>
          ))}
          {!mcps.length ? <div className="registry-empty"><strong>Nenhum MCP cadastrado.</strong><span>Adicione servidores Streamable HTTP, SSE ou stdio.</span><button className="primary-button" onClick={() => setEditor({ type: "mcp" })}>+ Cadastrar MCP</button></div> : null}
        </div>
      ) : null}

      {!loading && view === "credentials" ? (
        <div className="credential-table">
          <div className="credential-head"><span>Credencial</span><span>Provider</span><span>Campos</span><span>Uso</span><span>Ações</span></div>
          {credentials.map(credential => <div className="credential-row" key={credential.id}><span><strong>{credential.name}</strong><small>{credential.kind}</small></span><span>{credential.provider || "—"}</span><span className="masked-values">{Object.entries(credential.maskedFields || {}).map(([key, value]) => <i key={key}>{key}: {value}</i>)}</span><span>{credential.usages}</span><span className="row-actions"><button className="secondary-button compact" onClick={() => setEditor({ type: "credential", resource: credential })}>Rotacionar</button><button className="danger-button compact" disabled={credential.usages > 0} onClick={() => remove("credential", credential)}>Excluir</button></span></div>)}
          {!credentials.length ? <div className="registry-empty"><strong>Nenhuma credencial cadastrada.</strong><span>Cadastre chaves e tokens sem armazená-los em texto aberto.</span><button className="primary-button" onClick={() => setEditor({ type: "credential" })}>+ Nova credencial</button></div> : null}
        </div>
      ) : null}

      <div className="integration-note"><strong>Como a execução aparece?</strong><span>Cadastros definem configuração e vínculo. Quando um agente real envia sessões ao ai-memory com o mesmo “Identificador observado”, este card passa a mostrar sessões, observações e memórias produzidas.</span></div>

      {editor?.type === "agent" ? <AgentEditor agent={editor.resource} mcps={mcps} credentials={credentials} models={models} scope={scope} onClose={() => setEditor(null)} onSave={saveAgent} /> : null}
      {editor?.type === "mcp" ? <McpEditor mcp={editor.resource} credentials={credentials} onClose={() => setEditor(null)} onSave={saveMcp} /> : null}
      {editor?.type === "credential" ? <CredentialEditor credential={editor.resource} onClose={() => setEditor(null)} onSave={saveCredential} /> : null}
    </section>
  )
}
