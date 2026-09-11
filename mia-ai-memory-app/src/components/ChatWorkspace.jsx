import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../lib/api.js"
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
  return `${durable} memórias · ${prior} chats · ${attached} anexos`
}

export default function ChatWorkspace({ scope, onConfigure }) {
  const [bootstrap, setBootstrap] = useState({ agents: [], models: [], conversations: [] })
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
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)
  const threadEndRef = useRef(null)

  const agents = bootstrap.agents || []
  const models = bootstrap.models || []
  const conversations = bootstrap.conversations || []
  const selectedAgent = agents.find(item => item.id === agentId) || null
  const selectedModels = useMemo(() => models.filter(item => item.agentId === agentId), [models, agentId])
  const lastAssistantMessage = useMemo(() => [...messages].reverse().find(item => item.role === "assistant") || null, [messages])
  const continuityDetail = lastAssistantMessage ? memoryLabel(lastAssistantMessage) : `${agents.length} agentes disponíveis · memória independente do executor`
  const scopeKey = scope ? `${scope.workspace}/${scope.project}` : ""
  const stages = useMemo(() => [
    "Recuperando memória do projeto",
    "Combinando contexto entre agentes",
    `Executando ${selectedAgent?.name || "agente"}`,
    "Registrando continuidade no AI Memory"
  ], [selectedAgent?.name])

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
      if (data.conversation.defaultAgentId && agents.some(item => item.id === data.conversation.defaultAgentId)) {
        setAgentId(data.conversation.defaultAgentId)
      }
    } catch (err) {
      setError(err.message)
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
    setError("")
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
    const timer = window.setInterval(() => setThinkingStage(current => (current + 1) % stages.length), 2600)
    return () => window.clearInterval(timer)
  }, [sending, stages.length])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, sending, pendingPrompt])

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
    try {
      await createConversation()
    } catch (err) {
      setError(err.message)
    }
  }

  const removeConversation = async (event, item) => {
    event.stopPropagation()
    if (sending && activeId === item.id) return
    if (!window.confirm(`Excluir a conversa “${item.title}”?`)) return
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
    const zipFiles = [...incoming].filter(file => file.name.toLowerCase().endsWith(".zip"))
    if (zipFiles.length !== incoming.length) setError("Somente arquivos .zip são aceitos no chat.")
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

    setSending(true)
    setError("")
    setPendingPrompt(content)
    let currentConversation = conversation
    try {
      currentConversation = currentConversation || await createConversation()
      if (!currentConversation) throw new Error("Não foi possível criar a conversa.")
      const attachmentIds = []
      for (const file of files) {
        const result = await api.uploadChatAttachment(currentConversation.id, file)
        attachmentIds.push(result.attachment.id)
      }
      await api.sendChatMessage(currentConversation.id, { content, agentId, model, attachmentIds })
      setDraft("")
      setFiles([])
      await loadConversation(currentConversation.id)
      await refreshBootstrap(currentConversation.id)
    } catch (err) {
      setError(err.message)
      if (currentConversation?.id) await loadConversation(currentConversation.id).catch(() => {})
    } finally {
      setPendingPrompt("")
      setSending(false)
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

  if (!scope) {
    return <section className="chat-empty-scope"><strong>O chat precisa de um workspace/projeto.</strong><span>Sincronize um escopo do AI Memory para habilitar a continuidade compartilhada.</span></section>
  }

  return (
    <section className="chat-workspace">
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
            {!selectedAgent?.credentialReady && ["api-key", "hybrid"].includes(selectedAgent?.connectionType) ? <button className="chat-config-warning" onClick={onConfigure}>Cadastrar chave</button> : <span className="chat-ready"><i />memória contínua</span>}
            <button className="secondary-button compact" onClick={exportConversation} disabled={!conversation || sending}>Exportar ZIP</button>
          </div>
        </header>

        <div className="chat-status-stack">
          <div className="chat-continuity">
            <div className="chat-continuity-route"><span className="route-agent">{(selectedAgent?.name || "AI").slice(0, 2).toUpperCase()}</span><i /><span className="route-memory">M</span></div>
            <div><strong>Memória compartilhada ativa</strong><span>{continuityDetail}</span></div>
            <b>{selectedAgent?.name || "selecione um agente"}</b>
          </div>
          {error ? <div className="chat-error"><span>{error}</span>{error.includes("credencial") || error.includes("API key") || error.includes("repositoryUrl") ? <button onClick={onConfigure}>Abrir configuração</button> : null}</div> : null}
        </div>

        <div className="chat-thread">
          {loading ? <div className="chat-loading"><div className="pulse-ring" />Carregando conversa…</div> : null}
          {!loading && !messages.length && !sending ? (
            <div className="chat-welcome">
              <div className="chat-welcome-mark"><span /></div>
              <span className="eyebrow">AI Memory Web Chat</span>
              <h2>Troque o agente.<br /><em>Não perca o trabalho.</em></h2>
              <p>O contexto é reconstruído a partir da memória consolidada, conversas anteriores e anexos. O modelo escolhido executa apenas o turno atual.</p>
              <div className="chat-welcome-points"><span>GPT</span><span>Claude</span><span>Gemini</span><span>Cursor</span><span>Grok</span></div>
            </div>
          ) : null}

          {messages.map(message => (
            <article key={message.id} className={`chat-message ${message.role} ${message.status}`}>
              <div className="chat-message-avatar">{message.role === "user" ? "YOU" : (message.agentName || "AI").slice(0, 2).toUpperCase()}</div>
              <div className="chat-message-body">
                <header><strong>{message.role === "user" ? "Você" : message.agentName || "AI Memory"}</strong><span>{message.model || ""}</span><time>{formatWhen(message.createdAt)}</time></header>
                <MessageContent content={message.content} plain={message.role === "user"} />
                {message.attachments?.length ? <div className="chat-message-files">{message.attachments.map(attachment => <button key={attachment.id} onClick={() => downloadAttachment(attachment)}><span>ZIP</span><strong>{attachment.fileName}</strong><small>{formatSize(attachment.sizeBytes)}</small><i>↓</i></button>)}</div> : null}
                {message.role === "assistant" ? <footer><span>{memoryLabel(message)}</span><i className={message.metadata?.memoryCapture === "degraded" ? "degraded" : ""}>{message.metadata?.memoryCapture === "captured" ? "capturado no core" : message.metadata?.memoryCapture === "degraded" ? "core degradado" : "contexto aplicado"}</i></footer> : null}
              </div>
            </article>
          ))}

          {sending && pendingPrompt ? (
            <article className="chat-message user pending">
              <div className="chat-message-avatar">YOU</div>
              <div className="chat-message-body"><header><strong>Você</strong><span>enviando</span></header><MessageContent content={pendingPrompt} plain />{files.length ? <div className="chat-pending-files">{files.map(file => <span key={`${file.name}:${file.size}`}>{file.name}</span>)}</div> : null}</div>
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
          {files.length ? <div className="chat-file-queue">{files.map((file, index) => <span key={`${file.name}:${file.size}:${file.lastModified}`}><i>ZIP</i><strong>{file.name}</strong><small>{formatSize(file.size)}</small><button onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>)}</div> : null}
          <div className="chat-compose-row">
            <input ref={fileInputRef} hidden type="file" accept=".zip,application/zip,application/x-zip-compressed" multiple onChange={event => { addFiles(event.target.files); event.target.value = "" }} />
            <button className="chat-attach" onClick={() => fileInputRef.current?.click()} disabled={sending} title="Anexar ZIP">+</button>
            <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={handleKeyDown} disabled={sending} rows="2" placeholder={selectedAgent ? `Pergunte ou peça uma execução para ${selectedAgent.name}…` : "Configure ou selecione um agente…"} />
            <button className="chat-send" onClick={send} disabled={sending || !draft.trim() || !selectedAgent || !model}>{sending ? <span className="chat-send-spinner" /> : "↑"}</button>
          </div>
          <div className="chat-composer-meta"><span>Enter envia · Shift+Enter quebra linha · arraste ZIPs aqui</span><strong>{selectedAgent?.name || "sem agente"} / {model || "sem modelo"}</strong></div>
        </div>
      </div>
    </section>
  )
}
