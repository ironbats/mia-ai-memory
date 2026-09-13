import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../lib/api.js"
import { confirmAction } from "../lib/dialogService.js"
import MessageContent from "./MessageContent.jsx"

const formatWhen = value => value ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "agora"
const formatSize = value => {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const downloadBlob = ({ blob, fileName }) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const modelForAgent = (models, agentId, preferred = "") => {
  const values = models.filter(item => item.agentId === agentId)
  if (preferred && values.some(item => item.modelId === preferred)) return preferred
  return values.find(item => item.isDefault)?.modelId || values[0]?.modelId || preferred
}

const memoryLabel = message => {
  const durable = message.memoryContext?.durable?.length || 0
  const prior = message.memoryContext?.priorChat?.length || 0
  const attached = message.memoryContext?.attachments?.length || 0
  const code = message.memoryContext?.workspace?.contextFileCount || 0
  return `${durable} memórias · ${prior} chats · ${attached} anexos${code ? ` · ${code} arquivos` : ""}`
}

const planStatus = message => message.metadata?.codeChangeResult?.status || message.metadata?.codeChangePlan?.status || "proposed"

const CHAT_ZOOM_STEPS = [100, 110, 120, 130, 140]

const loadChatZoom = () => {
  if (typeof window === "undefined") return 110
  try {
    const value = Number(window.localStorage.getItem("ai-memory.chat.zoom"))
    if (!Number.isFinite(value)) return 110
    return CHAT_ZOOM_STEPS.reduce((best, step) => Math.abs(step - value) < Math.abs(best - value) ? step : best, 110)
  } catch {
    return 110
  }
}

const buildChatMetrics = zoom => {
  const factor = zoom / 100
  const px = value => `${Math.round(value * factor * 10) / 10}px`
  return {
    "--chat-font-xs": px(9),
    "--chat-font-sm": px(10),
    "--chat-font-md": px(11),
    "--chat-font-lg": px(12),
    "--chat-font-body": px(14),
    "--chat-font-title": px(15),
    "--chat-control-height": px(34),
    "--chat-avatar-size": px(36)
  }
}


export default function ChatWorkspace({ scope, onConfigure, workspace, ideOpen, ideLayout = "split", onIDELayoutChange, onOpenIDE, onCloseIDE }) {
  const [bootstrap, setBootstrap] = useState({ agents: [], models: [], conversations: [] })
  const [chatZoom, setChatZoom] = useState(loadChatZoom)
  const [activeId, setActiveId] = useState("")
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [agentId, setAgentId] = useState("")
  const [model, setModel] = useState("")
  const [draft, setDraft] = useState("")
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [thinkingStage, setThinkingStage] = useState(0)
  const [pendingPrompt, setPendingPrompt] = useState("")
  const [pendingFiles, setPendingFiles] = useState([])
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)
  const [applyingId, setApplyingId] = useState("")
  const [downloadingId, setDownloadingId] = useState("")
  const [transferStatus, setTransferStatus] = useState("")
  const [codeNotice, setCodeNotice] = useState("")
  const fileInputRef = useRef(null)
  const composerRef = useRef(null)
  const threadEndRef = useRef(null)

  const agents = bootstrap.agents || []
  const models = bootstrap.models || []
  const conversations = bootstrap.conversations || []
  const selectedAgent = agents.find(item => item.id === agentId) || null
  const selectedModels = useMemo(() => models.filter(item => item.agentId === agentId), [models, agentId])
  const lastAssistantMessage = useMemo(() => [...messages].reverse().find(item => item.role === "assistant") || null, [messages])
  const continuityDetail = lastAssistantMessage ? memoryLabel(lastAssistantMessage) : `${agents.length} agentes disponíveis · memória independente do executor`
  const gitLabel = workspace?.gitRepository ? workspace.gitBranch || workspace.gitHeadShort || "Git" : ""
  const scopeKey = scope ? `${scope.workspace}/${scope.project}` : ""
  const stages = useMemo(() => workspace?.isReady ? [
    `Mapeando ${workspace.rootName}`,
    "Recuperando memória do projeto",
    "Combinando código e contexto entre agentes",
    `Executando ${selectedAgent?.name || "agente"}`,
    "Preparando alterações rastreáveis",
    "Registrando continuidade no AI Memory"
  ] : [
    "Recuperando memória do projeto",
    "Combinando contexto entre agentes",
    `Executando ${selectedAgent?.name || "agente"}`,
    "Registrando continuidade no AI Memory"
  ], [selectedAgent?.name, workspace?.isReady, workspace?.rootName])

  const refreshBootstrap = useCallback(async preferredId => {
    if (!scope) return null
    const data = await api.chatBootstrap(scope)
    setBootstrap(data)
    const nextId = preferredId && data.conversations.some(item => item.id === preferredId)
      ? preferredId
      : data.conversations[0]?.id || ""
    setActiveId(current => current && data.conversations.some(item => item.id === current) ? current : nextId)
    setAgentId(current => {
      if (current && data.agents.some(item => item.id === current)) return current
      const preferredAgent = data.agents.find(item => item.credentialReady) || data.agents[0]
      return preferredAgent?.id || ""
    })
    return data
  }, [scopeKey])

  const loadConversation = useCallback(async id => {
    if (!scope || !id) {
      setConversation(null)
      setMessages([])
      return
    }
    setLoading(true)
    setError("")
    try {
      const data = await api.chatConversation(id, scope)
      setConversation(data.conversation)
      setMessages(data.messages || [])
      if (data.conversation.defaultAgentId && agents.some(item => item.id === data.conversation.defaultAgentId)) setAgentId(data.conversation.defaultAgentId)
      return data
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [scopeKey, agents])

  useEffect(() => {
    setBootstrap({ agents: [], models: [], conversations: [] })
    setActiveId("")
    setConversation(null)
    setMessages([])
    setDraft("")
    setFiles([])
    setPendingFiles([])
    setError("")
    setDownloadingId("")
    setTransferStatus("")
    setCodeNotice("")
    if (scope) refreshBootstrap().catch(err => setError(err.message))
  }, [scopeKey, refreshBootstrap])

  useEffect(() => {
    if (activeId) loadConversation(activeId)
    else {
      setConversation(null)
      setMessages([])
    }
  }, [activeId, loadConversation])

  useEffect(() => {
    if (!agentId) {
      setModel("")
      return
    }
    setModel(current => modelForAgent(models, agentId, current || selectedAgent?.model || ""))
  }, [agentId, models, selectedAgent?.model])

  useEffect(() => {
    if (!sending) {
      setThinkingStage(0)
      return
    }
    const timer = window.setInterval(() => setThinkingStage(current => (current + 1) % stages.length), 2400)
    return () => window.clearInterval(timer)
  }, [sending, stages.length])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, sending, pendingPrompt, codeNotice])

  const changeChatZoom = direction => {
    setChatZoom(current => {
      const index = CHAT_ZOOM_STEPS.indexOf(current)
      const nextIndex = Math.min(CHAT_ZOOM_STEPS.length - 1, Math.max(0, index + direction))
      return CHAT_ZOOM_STEPS[nextIndex]
    })
  }

  useEffect(() => {
    try {
      window.localStorage.setItem("ai-memory.chat.zoom", String(chatZoom))
    } catch {
    }
  }, [chatZoom])

  const createConversation = async () => {
    if (!scope) return null
    const result = await api.createChatConversation({ ...scope, defaultAgentId: agentId || null })
    const created = result.conversation
    setConversation(created)
    setMessages([])
    setActiveId(created.id)
    await refreshBootstrap(created.id)
    return created
  }

  const newConversation = async () => {
    if (sending) return
    setError("")
    setCodeNotice("")
    try {
      await createConversation()
    } catch (err) {
      setError(err.message)
    }
  }

  const removeConversation = async (event, item) => {
    event.stopPropagation()
    if (sending && activeId === item.id) return
    const confirmed = await confirmAction({
      tone: "danger",
      title: "Excluir conversa?",
      description: `A conversa “${item.title}” e seu histórico deixarão de aparecer no chat. Esta ação não altera as memórias duráveis já consolidadas do projeto.`,
      confirmLabel: "Excluir conversa"
    })
    if (!confirmed) return
    setError("")
    try {
      await api.deleteChatConversation(item.id)
      if (activeId === item.id) {
        setActiveId("")
        setConversation(null)
        setMessages([])
      }
      await refreshBootstrap()
    } catch (err) {
      setError(err.message)
    }
  }

  const addFiles = incoming => {
    const values = [...incoming]
    const zipFiles = values.filter(file => file.name.toLowerCase().endsWith(".zip"))
    const exceedsLimit = files.length + zipFiles.length > 12
    if (zipFiles.length !== values.length) setError("Somente arquivos .zip são aceitos como anexos do chat.")
    else if (exceedsLimit) setError("O chat aceita até 12 arquivos ZIP por mensagem.")
    else setError("")
    setFiles(current => {
      const keys = new Set(current.map(file => `${file.name}:${file.size}:${file.lastModified}`))
      const next = [...current]
      for (const file of zipFiles) {
        const key = `${file.name}:${file.size}:${file.lastModified}`
        if (!keys.has(key) && next.length < 12) {
          keys.add(key)
          next.push(file)
        }
      }
      return next
    })
  }

  const reportCodeResult = async (conversationId, messageId, result) => {
    try {
      await api.reportChatCodeChange(conversationId, messageId, result)
      return true
    } catch {
      return false
    }
  }

  const applyCodePlan = async (message, automatic = false) => {
    const plan = message?.metadata?.codeChangePlan
    if (!plan) return
    if (plan.workspace?.source === "attachment") {
      setCodeNotice("Este plano foi gerado a partir de um ZIP anexado. Baixe a solução ZIP para preservar o projeto local conectado.")
      return
    }
    setApplyingId(message.id)
    setError("")
    setCodeNotice("")
    try {
      if (!workspace?.isReady) {
        await onOpenIDE?.()
        setCodeNotice("Projeto local conectado. Confirme a pasta e clique em Aplicar alterações novamente.")
        return
      }
      if (!plan.workspace?.projectId && (workspace.projects?.length || 0) > 1) throw new Error("Este plano foi criado antes do suporte multi-projeto. Gere a alteração novamente no projeto ativo para aplicar com segurança.")
      if (plan.workspace?.projectId && workspace.activeProjectId && plan.workspace.projectId !== workspace.activeProjectId) {
        const targetProject = workspace.projects?.find(project => project.id === plan.workspace.projectId)
        throw new Error(`O plano foi gerado para o projeto “${targetProject?.name || plan.workspace.rootName || "anterior"}”. Selecione esse projeto na IDE antes de aplicar as alterações.`)
      }
      if (plan.workspace?.rootName && workspace.rootName !== plan.workspace.rootName) throw new Error(`O plano foi gerado para “${plan.workspace.rootName}”. A pasta aberta é “${workspace.rootName}”.`)
      const result = await workspace.applyChangePlan(plan)
      const reported = await reportCodeResult(message.conversationId || conversation?.id, message.id, result)
      setCodeNotice(`${result.files.length} alteração(ões) aplicada(s) em ${workspace.rootName}${automatic ? " automaticamente" : ""}${reported ? "" : " · auditoria remota pendente"}.`)
      await loadConversation(message.conversationId || conversation?.id)
    } catch (applyError) {
      const status = applyError.code === "WORKSPACE_CONFLICT" ? "conflict" : "failed"
      await reportCodeResult(message.conversationId || conversation?.id, message.id, {
        status,
        error: applyError.message || String(applyError),
        conflicts: applyError.conflicts || [],
        workspace: workspace?.rootName || null,
        finishedAt: new Date().toISOString()
      })
      setError(applyError.message || String(applyError))
      await loadConversation(message.conversationId || conversation?.id).catch(() => {})
    } finally {
      setApplyingId("")
    }
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || sending) return
    if (!selectedAgent) {
      setError("Selecione um agente para executar este turno.")
      return
    }
    if (!selectedAgent.credentialReady && ["api-key", "hybrid"].includes(selectedAgent.connectionType)) {
      setError(`${selectedAgent.name} ainda não tem credencial associada.`)
      return
    }
    if (!model) {
      setError("Selecione um modelo para executar este turno.")
      return
    }

    const submittedAt = Date.now()
    const outgoingFiles = [...files]
    setDraft("")
    setFiles([])
    setPendingFiles(outgoingFiles)
    setSending(true)
    setError("")
    setCodeNotice("")
    setPendingPrompt(content)
    let currentConversation = conversation
    try {
      currentConversation = currentConversation || await createConversation()
      if (!currentConversation) throw new Error("Não foi possível criar a conversa.")
      const attachmentIds = []
      for (let index = 0; index < outgoingFiles.length; index += 1) {
        const file = outgoingFiles[index]
        setTransferStatus(`Lendo ZIP ${index + 1}/${outgoingFiles.length} · ${file.name}`)
        const result = await api.uploadChatAttachment(currentConversation.id, file)
        attachmentIds.push(result.attachment.id)
      }
      if (outgoingFiles.length) setTransferStatus("ZIP analisado · montando contexto para o agente")
      const workspaceContext = workspace?.isReady && !attachmentIds.length ? await workspace.buildAgentContext(content) : null
      const result = await api.sendChatMessage(currentConversation.id, { content, agentId, model, attachmentIds, workspaceContext })
      const generatedPlan = result.assistantMessage?.metadata?.codeChangePlan
      if (workspace?.autoApply && generatedPlan && generatedPlan.workspace?.source !== "attachment") await applyCodePlan(result.assistantMessage, true)
      else await loadConversation(currentConversation.id)
      await refreshBootstrap(currentConversation.id)
    } catch (err) {
      setError(err.message)
      const latest = currentConversation?.id ? await loadConversation(currentConversation.id).catch(() => null) : null
      const lastUserMessage = [...(latest?.messages || [])].reverse().find(message => message.role === "user")
      const persisted = lastUserMessage?.content === content && (!lastUserMessage.createdAt || new Date(lastUserMessage.createdAt).getTime() >= submittedAt - 5000)
      if (!persisted) {
        setDraft(current => current || content)
        setFiles(current => current.length ? current : outgoingFiles)
      }
    } finally {
      setPendingPrompt("")
      setPendingFiles([])
      setTransferStatus("")
      setSending(false)
      window.requestAnimationFrame(() => composerRef.current?.focus())
    }
  }

  const exportConversation = async () => {
    if (!conversation) return
    setError("")
    try {
      downloadBlob(await api.exportChatConversation(conversation.id, `${conversation.title}.zip`))
    } catch (err) {
      setError(err.message)
    }
  }

  const downloadCodePlan = async message => {
    const plan = message?.metadata?.codeChangePlan
    if (!plan || !(plan.operations || []).some(operation => operation.type === "write" && typeof operation.content === "string")) return
    setDownloadingId(message.id)
    setError("")
    try {
      const rootName = plan.workspace?.rootName || conversation?.title || "solution"
      downloadBlob(await api.exportChatCodeChange(message.conversationId || conversation?.id, message.id, `${rootName}-solution.zip`))
    } catch (err) {
      setError(err.message)
    } finally {
      setDownloadingId("")
    }
  }

  const downloadAttachment = async attachment => {
    setError("")
    try {
      downloadBlob(await api.downloadChatAttachment(attachment.id, attachment.fileName))
    } catch (err) {
      setError(err.message)
    }
  }

  const selectAgent = event => {
    const id = event.target.value
    setAgentId(id)
    const agent = agents.find(item => item.id === id)
    setModel(modelForAgent(models, id, agent?.model || ""))
  }

  const handleKeyDown = event => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }

  const cycleIDELayout = () => {
    const order = ["compact", "split", "wide"]
    const index = order.indexOf(ideLayout)
    onIDELayoutChange?.(order[(index + 1) % order.length])
  }

  if (!scope) {
    return <section className="chat-empty-scope"><strong>O chat precisa de um workspace/projeto.</strong><span>Sincronize um escopo do AI Memory para habilitar a continuidade compartilhada.</span></section>
  }

  return (
    <section className={`chat-workspace${ideOpen ? " ide-companion" : ""}`} style={buildChatMetrics(chatZoom)}>
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <div><span className="eyebrow">Memory-first chat</span><strong>Conversas</strong></div>
          <button className="chat-icon-button" onClick={newConversation} disabled={sending} title="Nova conversa">+</button>
        </div>
        <div className="chat-scope-chip"><span>escopo</span><strong>{scope.workspace}/{scope.project}</strong></div>
        <div className="chat-conversation-list">
          {conversations.map(item => (
            <button key={item.id} className={`chat-conversation-item${activeId === item.id ? " active" : ""}`} onClick={() => setActiveId(item.id)}>
              <span><strong>{item.title}</strong><small>{item.messageCount} mensagens · {formatWhen(item.lastMessageAt || item.createdAt)}</small></span>
              <i>{item.lastAgentName || "memory"}</i>
              <b onClick={event => removeConversation(event, item)} title="Excluir conversa">×</b>
            </button>
          ))}
          {!conversations.length ? <div className="chat-sidebar-empty"><strong>Nenhuma conversa.</strong><span>Crie uma ou simplesmente escreva abaixo.</span></div> : null}
        </div>
        <div className="chat-principle"><strong>Memória ≠ agente</strong><span>Você pode trocar o executor a qualquer turno sem reiniciar o contexto.</span></div>
      </aside>

      <div className="chat-main">
        <header className="chat-toolbar">
          <div className="chat-toolbar-title">
            <span className="eyebrow">Conversa independente</span>
            <strong>{conversation?.title || "Nova conversa"}</strong>
          </div>
          <div className="chat-runtime-selectors">
            <label><span>Agente</span><select value={agentId} onChange={selectAgent} disabled={sending}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}{agent.credentialReady ? "" : " · sem chave"}</option>)}</select></label>
            <label><span>Modelo</span><select value={model} onChange={event => setModel(event.target.value)} disabled={sending}>{selectedModels.length ? selectedModels.map(item => <option key={item.id} value={item.modelId}>{item.displayName}</option>) : <option value={model}>{model || "Sem modelo"}</option>}</select></label>
          </div>
          <div className="chat-toolbar-actions">
            <div className="chat-zoom-control" aria-label="Escala visual do chat"><button onClick={() => changeChatZoom(-1)} disabled={chatZoom === CHAT_ZOOM_STEPS[0]} title="Diminuir escala do chat">−</button><button className="chat-zoom-value" onClick={() => setChatZoom(110)} title="Restaurar escala recomendada">{chatZoom}%</button><button onClick={() => changeChatZoom(1)} disabled={chatZoom === CHAT_ZOOM_STEPS[CHAT_ZOOM_STEPS.length - 1]} title="Aumentar escala do chat">+</button></div>
            <button className={`chat-ide-button${ideOpen ? " active" : ""}`} onClick={ideOpen ? onCloseIDE : onOpenIDE}><span>&lt;/&gt;</span>{workspace?.isReady ? workspace.rootName : "Abrir IDE"}</button>
            {ideOpen ? <button className="chat-ide-resize" onClick={cycleIDELayout} title="Alternar tamanho da IDE">{ideLayout === "compact" ? "▯" : ideLayout === "wide" ? "▰" : "◫"}</button> : null}
            {workspace?.isReady ? <button className={`chat-auto-apply${workspace.autoApply ? " active" : ""}`} onClick={() => workspace.setAutoApply(!workspace.autoApply)} title="Quando ativo, planos de código sem conflito são gravados automaticamente na pasta local"><i />Auto apply</button> : null}
            {!selectedAgent?.credentialReady && ["api-key", "hybrid"].includes(selectedAgent?.connectionType) ? <button className="chat-config-warning" onClick={onConfigure}>Cadastrar chave</button> : <span className="chat-ready"><i />memória contínua</span>}
            <button className="secondary-button compact" onClick={exportConversation} disabled={!conversation || sending}>Exportar ZIP</button>
          </div>
        </header>

        <div className="chat-status-stack">
          <div className="chat-continuity">
            <div className="chat-continuity-route"><span className="route-agent">{(selectedAgent?.name || "AI").slice(0, 2).toUpperCase()}</span><i /><span className="route-memory">M</span>{workspace?.isReady ? <><i /><span className="route-code">&lt;/&gt;</span></> : null}</div>
            <div><strong>{workspace?.isReady ? `Memória + código · ${workspace.rootName}${gitLabel ? ` · ${gitLabel}` : ""}` : "Memória compartilhada ativa"}</strong><span>{workspace?.isReady ? `${workspace.filePaths.length} arquivos locais · ${workspace.contextPaths.length} fixados · ${continuityDetail}` : continuityDetail}</span></div>
            <b>{selectedAgent?.name || "selecione um agente"}</b>
          </div>
          {codeNotice ? <div className="chat-code-notice"><span>✓</span>{codeNotice}<button onClick={onOpenIDE}>Ver na IDE</button></div> : null}
          {transferStatus ? <div className="chat-transfer-status"><span className="chat-transfer-spinner" /><strong>{transferStatus}</strong><small>O ZIP é convertido em contexto seguro para qualquer agente.</small></div> : null}
          {error ? <div className="chat-error"><span>{error}</span>{error.includes("credencial") || error.includes("API key") || error.includes("repositoryUrl") ? <button onClick={onConfigure}>Abrir configuração</button> : error.includes("pasta") || error.includes("workspace") || error.includes("Conflito") ? <button onClick={onOpenIDE}>Abrir IDE</button> : null}</div> : null}
        </div>

        <div className="chat-thread">
          {loading ? <div className="chat-loading"><div className="pulse-ring" />Carregando conversa…</div> : null}
          {!loading && !messages.length && !sending ? (
            <div className="chat-welcome">
              <div className="chat-welcome-mark"><span /></div>
              <span className="eyebrow">AI Memory Web Chat</span>
              <h2>Troque o agente.<br /><em>Não perca o trabalho.</em></h2>
              <p>{workspace?.isReady ? `O projeto ${workspace.rootName} está conectado. Peça uma alteração e o agente receberá código + memória como contexto, gerando operações aplicáveis diretamente na pasta local.` : "O contexto é reconstruído a partir da memória consolidada, conversas anteriores e anexos. Abra a IDE para conectar também o código local ao agente."}</p>
              <div className="chat-welcome-points"><span>GPT</span><span>Claude</span><span>Gemini</span><span>Cursor</span><span>Grok</span>{workspace?.isReady ? <span className="code-point">{workspace.rootName}</span> : null}</div>
              {!workspace?.isReady ? <button className="chat-welcome-ide" onClick={onOpenIDE}>&lt;/&gt; Selecionar projeto e abrir IDE</button> : null}
            </div>
          ) : null}

          {messages.map(message => {
            const plan = message.metadata?.codeChangePlan
            const status = plan ? planStatus(message) : null
            return (
              <article key={message.id} className={`chat-message ${message.role} ${message.status}`}>
                <div className="chat-message-avatar">{message.role === "user" ? "YOU" : (message.agentName || "AI").slice(0, 2).toUpperCase()}</div>
                <div className="chat-message-body">
                  <header><strong>{message.role === "user" ? "Você" : message.agentName || "AI Memory"}</strong><span>{message.model || ""}</span><time>{formatWhen(message.createdAt)}</time></header>
                  <MessageContent content={message.content} plain={message.role === "user"} />
                  {message.attachments?.length ? <div className="chat-message-files">{message.attachments.map(attachment => <button key={attachment.id} onClick={() => downloadAttachment(attachment)}><span>ZIP</span><strong>{attachment.fileName}</strong><small>{attachment.manifest?.length ? `${attachment.manifest.length} arquivos · ` : ""}{formatSize(attachment.sizeBytes)}</small><i>↓</i></button>)}</div> : null}
                  {plan ? (() => {
                    const fromAttachment = plan.workspace?.source === "attachment"
                    const downloadable = (plan.operations || []).some(operation => operation.type === "write" && typeof operation.content === "string")
                    const deleteCount = (plan.operations || []).filter(operation => operation.type === "delete").length
                    return (
                      <div className={`chat-code-plan ${status}`}>
                        <div className="chat-code-plan-head"><span>&lt;/&gt;</span><div><strong>{plan.summary || "Alterações de código prontas"}</strong><small>{plan.operations?.length || 0} operação(ões) · {plan.workspace?.rootName || "workspace local"}{fromAttachment ? " · origem ZIP" : plan.workspace?.branch ? ` · ${plan.workspace.branch}` : ""}</small></div><i>{status === "applied" ? "APLICADO" : status === "conflict" ? "CONFLITO" : status === "failed" ? "FALHOU" : "PRONTO"}</i></div>
                        <div className="chat-code-files">{(plan.operations || []).slice(0, 8).map((operation, index) => <span key={`${operation.path}:${index}`}><i>{operation.type === "delete" ? "−" : operation.expectedExists === false ? "+" : "~"}</i><strong>{operation.path}</strong></span>)}{plan.operations?.length > 8 ? <small>+ {plan.operations.length - 8} arquivos</small> : null}</div>
                        {deleteCount ? <div className="chat-code-plan-hint">O ZIP contém somente arquivos criados/alterados. {deleteCount} exclusão(ões) ficam disponíveis para aplicação pela IDE.</div> : null}
                        {message.metadata?.codeChangeResult?.error ? <div className="chat-code-plan-error">{message.metadata.codeChangeResult.error}</div> : null}
                        <div className="chat-code-plan-actions">
                          <button onClick={onOpenIDE}>Abrir IDE</button>
                          {downloadable ? <button className="download" onClick={() => downloadCodePlan(message)} disabled={downloadingId === message.id}>{downloadingId === message.id ? "Gerando ZIP…" : "↓ Baixar solução ZIP"}</button> : null}
                          {!fromAttachment && status !== "applied" ? <button className="primary" onClick={() => applyCodePlan(message)} disabled={applyingId === message.id}>{applyingId === message.id ? "Aplicando…" : "Aplicar alterações"}</button> : status === "applied" ? <strong>✓ Gravado no projeto local</strong> : fromAttachment ? <strong>ZIP pronto para download</strong> : null}
                        </div>
                      </div>
                    )
                  })() : null}
                  {message.role === "assistant" ? <footer><span>{memoryLabel(message)}</span><i className={message.metadata?.memoryCapture === "degraded" ? "degraded" : ""}>{message.metadata?.memoryCapture === "captured" ? "capturado no core" : message.metadata?.memoryCapture === "degraded" ? "core degradado" : "contexto aplicado"}</i></footer> : null}
                </div>
              </article>
            )
          })}

          {sending && pendingPrompt ? (
            <article className="chat-message user pending">
              <div className="chat-message-avatar">YOU</div>
              <div className="chat-message-body"><header><strong>Você</strong><span>enviando</span></header><MessageContent content={pendingPrompt} plain />{workspace?.isReady && !pendingFiles.length ? <div className="chat-workspace-pending"><span>&lt;/&gt;</span><strong>{workspace.rootName}</strong><small>código local incluído no contexto</small></div> : null}{pendingFiles.length ? <div className="chat-pending-files">{pendingFiles.map(file => <span key={`${file.name}:${file.size}`}>{file.name}</span>)}</div> : null}</div>
            </article>
          ) : null}

          {sending ? (
            <article className="chat-message assistant thinking">
              <div className="chat-message-avatar">{(selectedAgent?.name || "AI").slice(0, 2).toUpperCase()}</div>
              <div className="chat-message-body"><header><strong>{selectedAgent?.name || "Agente"}</strong><span>{model}</span></header><div className="chat-thinking"><span><i /><i /><i /></span><strong>{stages[thinkingStage]}</strong></div></div>
            </article>
          ) : null}
          <div ref={threadEndRef} />
        </div>

        <div className={`chat-composer${dragging ? " dragging" : ""}`} onDragEnter={event => { event.preventDefault(); setDragging(true) }} onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files) }}>
          {workspace?.isReady ? <div className="chat-local-context"><span>&lt;/&gt;</span><strong>{workspace.rootName}</strong>{gitLabel ? <i className="chat-local-branch">⑂ {gitLabel}</i> : null}<small>{workspace.activePath || "projeto conectado"}</small><button onClick={onOpenIDE}>IDE</button></div> : null}
          {files.length ? <><div className="chat-zip-context-note"><span>ZIP</span><div><strong>{files.length} pacote{files.length > 1 ? "s" : ""} pronto{files.length > 1 ? "s" : ""} para análise</strong><small>O AI Memory lê o manifesto, ignora dependências/builds e usa o ZIP como fonte principal deste envio sem alterar automaticamente o projeto local.</small></div></div><div className="chat-file-queue">{files.map((file, index) => <span key={`${file.name}:${file.size}:${file.lastModified}`}><i>ZIP</i><strong>{file.name}</strong><small>{formatSize(file.size)}</small><button onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>)}</div></> : null}
          <div className="chat-compose-row">
            <input ref={fileInputRef} hidden type="file" accept=".zip,application/zip,application/x-zip-compressed" multiple onChange={event => { addFiles(event.target.files); event.target.value = "" }} />
            <button className="chat-attach" onClick={() => fileInputRef.current?.click()} disabled={sending} title="Anexar ZIP">+</button>
            <textarea ref={composerRef} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={handleKeyDown} disabled={sending} rows="2" placeholder={selectedAgent ? workspace?.isReady ? `Peça uma alteração em ${workspace.rootName} para ${selectedAgent.name}…` : `Pergunte ou peça uma execução para ${selectedAgent.name}…` : "Configure ou selecione um agente…"} />
            <button className="chat-send" onClick={send} disabled={sending || !draft.trim() || !selectedAgent || !model}>{sending ? <span className="chat-send-spinner" /> : "↑"}</button>
          </div>
          <div className="chat-composer-meta"><span>Enter envia · Shift+Enter quebra linha · Ctrl+S salva na IDE · arraste ZIPs aqui</span><strong>{selectedAgent?.name || "sem agente"} / {model || "sem modelo"}</strong></div>
        </div>
      </div>
    </section>
  )
}
