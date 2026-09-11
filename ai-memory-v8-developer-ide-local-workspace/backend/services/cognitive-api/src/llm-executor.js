import { config } from "./config.js"

const failure = (message, status = 502) => Object.assign(new Error(message), { status, expose: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const secret = (secrets, names) => {
  const normalized = new Map(Object.entries(secrets || {}).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), String(value)]))
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""))
    if (value) return value.replace(/^Bearer\s+/i, "")
  }
  return ""
}

const requestJson = async (url, options, timeoutMs = config.chatAgentTimeoutMs) => {
  let response
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (String(error?.name) === "TimeoutError") throw failure("agent execution timed out", 504)
    throw failure(`agent connection failed: ${String(error?.message || error).slice(0, 300)}`)
  }
  const raw = await response.text()
  let body = {}
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      body = { raw }
    }
  }
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || body?.message || body?.raw || `HTTP ${response.status}`
    throw failure(`provider rejected the request: ${String(detail).slice(0, 500)}`, response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : 502)
  }
  return body
}

const historyAsText = history => history.map(message => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`).join("\n\n")

const openAiOutput = body => {
  if (typeof body?.output_text === "string" && body.output_text.trim()) return body.output_text.trim()
  const chunks = []
  for (const output of body?.output || []) {
    for (const item of output?.content || []) {
      if (typeof item?.text === "string") chunks.push(item.text)
      if (typeof item?.output_text === "string") chunks.push(item.output_text)
    }
  }
  return chunks.join("\n").trim()
}

const executeResponsesApi = async ({ agent, model, secrets, systemPrompt, history, userPrompt, conversationId }) => {
  const key = secret(secrets, ["api_key", "apikey", "openai_api_key", "xai_api_key", "token", "authorization"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409)
  const baseUrl = (agent.baseUrl || (String(agent.provider).toLowerCase() === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1")).replace(/\/$/, "")
  const input = [
    ...history.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content })),
    { role: "user", content: userPrompt }
  ]
  const payload = { model, instructions: systemPrompt, input }
  const provider = String(agent.provider || "").trim().toLowerCase()
  if (["openai", "xai", "grok"].includes(provider)) payload.prompt_cache_key = conversationId
  const body = await requestJson(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
  const content = openAiOutput(body)
  if (!content) throw failure(`${agent.name} returned an empty response`)
  return {
    content,
    metadata: {
      providerResponseId: body.id || null,
      usage: body.usage || null
    }
  }
}

const executeAnthropic = async ({ agent, model, secrets, systemPrompt, history, userPrompt }) => {
  const key = secret(secrets, ["api_key", "apikey", "anthropic_api_key", "token", "authorization"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409)
  const baseUrl = (agent.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "")
  const body = await requestJson(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: Number(agent.settings?.maxTokens || 8192),
      system: systemPrompt,
      messages: [
        ...history.map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content })),
        { role: "user", content: userPrompt }
      ]
    })
  })
  const content = (body.content || []).filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n").trim()
  if (!content) throw failure(`${agent.name} returned an empty response`)
  return { content, metadata: { providerResponseId: body.id || null, usage: body.usage || null } }
}

const executeGemini = async ({ agent, model, secrets, systemPrompt, history, userPrompt }) => {
  const key = secret(secrets, ["api_key", "apikey", "gemini_api_key", "google_api_key", "token"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409)
  const baseUrl = (agent.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "")
  const contents = [
    ...history.map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
    { role: "user", parts: [{ text: userPrompt }] }
  ]
  const body = await requestJson(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents })
  })
  const content = (body.candidates?.[0]?.content?.parts || []).map(part => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n").trim()
  if (!content) throw failure(`${agent.name} returned an empty response`)
  return { content, metadata: { finishReason: body.candidates?.[0]?.finishReason || null, usage: body.usageMetadata || null } }
}

const cursorPrompt = ({ systemPrompt, history, userPrompt }) => [systemPrompt, historyAsText(history), `User: ${userPrompt}`].filter(Boolean).join("\n\n")

const cursorHeaders = key => ({ Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, "Content-Type": "application/json" })

const pollCursorRun = async ({ baseUrl, key, agentId, runId }) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < config.cursorTimeoutMs) {
    const run = await requestJson(`${baseUrl}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      headers: cursorHeaders(key)
    }, Math.min(config.chatAgentTimeoutMs, 60000))
    const status = String(run.status || run.state || "").toUpperCase()
    if (["FINISHED", "COMPLETED", "SUCCESS", "SUCCEEDED"].includes(status)) return run
    if (["ERROR", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"].includes(status)) {
      throw failure(`Cursor run ended with status ${status}: ${String(run.error?.message || run.error || run.message || "execution failed").slice(0, 400)}`)
    }
    await sleep(config.cursorPollIntervalMs)
  }
  throw failure("Cursor execution timed out", 504)
}

const executeCursor = async ({ agent, model, secrets, systemPrompt, history, userPrompt, state, saveState, localWorkspace }) => {
  const key = secret(secrets, ["api_key", "apikey", "cursor_api_key", "token", "authorization"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409)
  const cursor = agent.settings?.cursor || {}
  const repositoryUrl = String(cursor.repositoryUrl || agent.settings?.repositoryUrl || "").trim()
  if (!repositoryUrl) throw failure("Cursor requires repositoryUrl in the agent configuration", 409)
  const baseUrl = (agent.baseUrl || "https://api.cursor.com/v1").replace(/\/$/, "")
  const promptText = cursorPrompt({ systemPrompt, history, userPrompt })
  const configuredMode = String(cursor.conversationMode || "agent").toLowerCase()
  const conversationMode = localWorkspace ? "plan" : ["agent", "plan"].includes(configuredMode) ? configuredMode : "agent"
  let externalAgentId = state?.external_thread_id || null
  let runId = null

  if (!externalAgentId) {
    const payload = {
      prompt: { text: promptText },
      repos: [{ url: repositoryUrl, startingRef: String(cursor.startingRef || "main") }],
      mode: conversationMode,
      autoCreatePR: localWorkspace ? false : cursor.autoCreatePR === true
    }
    if (model) payload.model = { id: model }
    const created = await requestJson(`${baseUrl}/agents`, {
      method: "POST",
      headers: cursorHeaders(key),
      body: JSON.stringify(payload)
    })
    externalAgentId = created.agent?.id || created.id
    runId = created.run?.id || created.runId
    if (!externalAgentId) throw failure("Cursor did not return an agent id")
    await saveState({ externalThreadId: externalAgentId, externalRunId: runId || null, metadata: { repositoryUrl } })
  } else {
    const payload = { prompt: { text: promptText }, mode: conversationMode }
    const created = await requestJson(`${baseUrl}/agents/${encodeURIComponent(externalAgentId)}/runs`, {
      method: "POST",
      headers: cursorHeaders(key),
      body: JSON.stringify(payload)
    })
    runId = created.run?.id || created.id || created.runId
    await saveState({ externalThreadId: externalAgentId, externalRunId: runId || null, metadata: { repositoryUrl } })
  }

  if (!runId) throw failure("Cursor did not return a run id")
  const run = await pollCursorRun({ baseUrl, key, agentId: externalAgentId, runId })
  const content = String(run.result || run.output?.text || run.output || "").trim()
  if (!content) throw failure("Cursor finished without a textual result")
  await saveState({ externalThreadId: externalAgentId, externalRunId: runId, metadata: { status: run.status || run.state || "FINISHED", git: run.git || null } })
  return {
    content,
    metadata: {
      externalAgentId,
      externalRunId: runId,
      git: run.git || null,
      localWorkspaceMode: Boolean(localWorkspace)
    }
  }
}

const adapterFor = agent => {
  const configured = String(agent.settings?.adapter || "").toLowerCase()
  if (configured) return configured
  const provider = String(agent.provider || "").trim().toLowerCase()
  if (provider === "openai") return "openai-responses"
  if (provider === "anthropic") return "anthropic-messages"
  if (provider === "google gemini" || provider === "gemini") return "gemini-generate-content"
  if (provider === "xai" || provider === "grok") return "xai-responses"
  if (provider === "cursor") return "cursor-cloud"
  if (provider.includes("openai compatible")) return "openai-responses"
  return ""
}

export const executeAgent = async input => {
  const adapter = adapterFor(input.agent)
  if (!adapter) throw failure(`agent provider ${input.agent.provider || input.agent.name} is not executable by the web chat`, 409)
  if (!input.model) throw failure("a model must be selected", 409)
  if (adapter === "openai-responses" || adapter === "xai-responses") return executeResponsesApi(input)
  if (adapter === "anthropic-messages") return executeAnthropic(input)
  if (adapter === "gemini-generate-content") return executeGemini(input)
  if (adapter === "cursor-cloud") return executeCursor(input)
  throw failure(`unsupported agent adapter ${adapter}`, 409)
}
