import { config } from "./config.js"

const failure = (message, status = 502, code = "PROVIDER_ERROR") => Object.assign(new Error(message), { status, expose: true, code })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const secret = (secrets, names) => {
  const normalized = new Map(Object.entries(secrets || {}).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), String(value)]))
  for (const name of names) {
    const value = normalized.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""))
    if (value) return value.replace(/^Bearer\s+/i, "")
  }
  return ""
}

const retryableStatus = status => [408, 425, 429, 500, 502, 503, 504].includes(Number(status))

const retryAfterMs = response => {
  const raw = response?.headers?.get?.("retry-after")
  if (!raw) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(config.chatAgentRetryMaxDelayMs, Math.round(seconds * 1000))
  const date = Date.parse(raw)
  if (!Number.isFinite(date)) return 0
  return Math.min(config.chatAgentRetryMaxDelayMs, Math.max(0, date - Date.now()))
}

const retryDelay = (attempt, response = null) => {
  const instructed = retryAfterMs(response)
  if (instructed > 0) return instructed
  return Math.min(config.chatAgentRetryMaxDelayMs, config.chatAgentRetryDelayMs * Math.max(1, 2 ** (attempt - 1)))
}

const safeProgress = async (onProgress, payload) => {
  if (typeof onProgress !== "function") return
  try {
    await onProgress(payload)
  } catch {
  }
}

const parseBody = async response => {
  const raw = await response.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

const requestJson = async (url, options, timeoutMs = config.chatAgentTimeoutMs, retryOptions = {}) => {
  const maxAttempts = Math.max(1, Number(retryOptions.maxAttempts || config.chatAgentMaxAttempts))
  const onProgress = retryOptions.onProgress
  const operation = retryOptions.operation || "provider-request"
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await safeProgress(onProgress, { phase: "requesting", operation, attempt, maxAttempts })
    let response
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const timedOut = String(error?.name) === "TimeoutError" || String(error?.name) === "AbortError"
      lastError = timedOut
        ? failure("provider request exceeded the current attempt window", 504, "PROVIDER_ATTEMPT_TIMEOUT")
        : failure(`provider connection failed: ${String(error?.message || error).slice(0, 300)}`, 502, "PROVIDER_CONNECTION_FAILED")
      if (attempt >= maxAttempts) break
      const delayMs = retryDelay(attempt)
      await safeProgress(onProgress, { phase: "retrying", operation, attempt, maxAttempts, reason: lastError.code, delayMs })
      await sleep(delayMs)
      continue
    }

    const body = await parseBody(response)
    if (response.ok) {
      await safeProgress(onProgress, { phase: "responded", operation, attempt, maxAttempts })
      return body
    }

    const detail = body?.error?.message || body?.error || body?.message || body?.raw || `HTTP ${response.status}`
    const status = response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : retryableStatus(response.status) ? response.status : 502
    lastError = failure(`provider rejected the request: ${String(detail).slice(0, 500)}`, status, `PROVIDER_HTTP_${response.status}`)
    if (!retryableStatus(response.status) || attempt >= maxAttempts) break
    const delayMs = retryDelay(attempt, response)
    await safeProgress(onProgress, { phase: "retrying", operation, attempt, maxAttempts, reason: lastError.code, delayMs, providerStatus: response.status })
    await sleep(delayMs)
  }

  if (lastError?.code === "PROVIDER_ATTEMPT_TIMEOUT") {
    throw failure(`provider did not finish after ${maxAttempts} automatic attempt${maxAttempts === 1 ? "" : "s"}`, 504, "PROVIDER_RETRY_EXHAUSTED")
  }
  if (lastError?.code === "PROVIDER_CONNECTION_FAILED") {
    throw failure(`provider connection could not be restored after ${maxAttempts} automatic attempt${maxAttempts === 1 ? "" : "s"}`, 502, "PROVIDER_RETRY_EXHAUSTED")
  }
  throw lastError || failure("provider request failed after automatic retries", 502, "PROVIDER_RETRY_EXHAUSTED")
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

const executeResponsesApi = async ({ agent, model, secrets, systemPrompt, history, userPrompt, conversationId, onProgress }) => {
  const key = secret(secrets, ["api_key", "apikey", "openai_api_key", "xai_api_key", "token", "authorization"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409, "CREDENTIAL_REQUIRED")
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
  }, config.chatAgentTimeoutMs, { onProgress, operation: "responses-api" })
  const content = openAiOutput(body)
  if (!content) throw failure(`${agent.name} returned an empty response`, 502, "EMPTY_PROVIDER_RESPONSE")
  return {
    content,
    metadata: {
      providerResponseId: body.id || null,
      usage: body.usage || null
    }
  }
}

const executeAnthropic = async ({ agent, model, secrets, systemPrompt, history, userPrompt, onProgress }) => {
  const key = secret(secrets, ["api_key", "apikey", "anthropic_api_key", "token", "authorization"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409, "CREDENTIAL_REQUIRED")
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
  }, config.chatAgentTimeoutMs, { onProgress, operation: "anthropic-messages" })
  const content = (body.content || []).filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n").trim()
  if (!content) throw failure(`${agent.name} returned an empty response`, 502, "EMPTY_PROVIDER_RESPONSE")
  return { content, metadata: { providerResponseId: body.id || null, usage: body.usage || null } }
}

const executeGemini = async ({ agent, model, secrets, systemPrompt, history, userPrompt, onProgress }) => {
  const key = secret(secrets, ["api_key", "apikey", "gemini_api_key", "google_api_key", "token"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409, "CREDENTIAL_REQUIRED")
  const baseUrl = (agent.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "")
  const contents = [
    ...history.map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
    { role: "user", parts: [{ text: userPrompt }] }
  ]
  const body = await requestJson(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents })
  }, config.chatAgentTimeoutMs, { onProgress, operation: "gemini-generate-content" })
  const content = (body.candidates?.[0]?.content?.parts || []).map(part => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n").trim()
  if (!content) throw failure(`${agent.name} returned an empty response`, 502, "EMPTY_PROVIDER_RESPONSE")
  return { content, metadata: { finishReason: body.candidates?.[0]?.finishReason || null, usage: body.usageMetadata || null } }
}

const cursorPrompt = ({ systemPrompt, history, userPrompt }) => [systemPrompt, historyAsText(history), `User: ${userPrompt}`].filter(Boolean).join("\n\n")

const cursorHeaders = key => ({ Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, "Content-Type": "application/json" })

const pollCursorRun = async ({ baseUrl, key, agentId, runId, onProgress }) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < config.cursorTimeoutMs) {
    const run = await requestJson(`${baseUrl}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      headers: cursorHeaders(key)
    }, Math.min(config.chatAgentTimeoutMs, 60000), { maxAttempts: 2, onProgress, operation: "cursor-poll" })
    const status = String(run.status || run.state || "").toUpperCase()
    await safeProgress(onProgress, { phase: "polling", operation: "cursor-run", providerStatus: status || "RUNNING" })
    if (["FINISHED", "COMPLETED", "SUCCESS", "SUCCEEDED"].includes(status)) return run
    if (["ERROR", "FAILED", "CANCELLED", "CANCELED", "EXPIRED"].includes(status)) {
      throw failure(`Cursor run ended with status ${status}: ${String(run.error?.message || run.error || run.message || "execution failed").slice(0, 400)}`, 502, "CURSOR_RUN_FAILED")
    }
    await sleep(config.cursorPollIntervalMs)
  }
  throw failure("Cursor run did not finish within the configured execution window", 504, "CURSOR_EXECUTION_WINDOW_EXHAUSTED")
}

const executeCursor = async ({ agent, model, secrets, systemPrompt, history, userPrompt, state, saveState, localWorkspace, onProgress }) => {
  const key = secret(secrets, ["api_key", "apikey", "cursor_api_key", "token", "authorization"])
  if (!key) throw failure(`${agent.name} requires an API key`, 409, "CREDENTIAL_REQUIRED")
  const cursor = agent.settings?.cursor || {}
  const repositoryUrl = String(cursor.repositoryUrl || agent.settings?.repositoryUrl || "").trim()
  if (!repositoryUrl) throw failure("Cursor requires repositoryUrl in the agent configuration", 409, "CURSOR_REPOSITORY_REQUIRED")
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
    }, config.chatAgentTimeoutMs, { onProgress, operation: "cursor-create-agent" })
    externalAgentId = created.agent?.id || created.id
    runId = created.run?.id || created.runId
    if (!externalAgentId) throw failure("Cursor did not return an agent id", 502, "CURSOR_AGENT_ID_MISSING")
    await saveState({ externalThreadId: externalAgentId, externalRunId: runId || null, metadata: { repositoryUrl } })
  } else {
    const payload = { prompt: { text: promptText }, mode: conversationMode }
    const created = await requestJson(`${baseUrl}/agents/${encodeURIComponent(externalAgentId)}/runs`, {
      method: "POST",
      headers: cursorHeaders(key),
      body: JSON.stringify(payload)
    }, config.chatAgentTimeoutMs, { onProgress, operation: "cursor-create-run" })
    runId = created.run?.id || created.id || created.runId
    await saveState({ externalThreadId: externalAgentId, externalRunId: runId || null, metadata: { repositoryUrl } })
  }

  if (!runId) throw failure("Cursor did not return a run id", 502, "CURSOR_RUN_ID_MISSING")
  const run = await pollCursorRun({ baseUrl, key, agentId: externalAgentId, runId, onProgress })
  const content = String(run.result || run.output?.text || run.output || "").trim()
  if (!content) throw failure("Cursor finished without a textual result", 502, "EMPTY_PROVIDER_RESPONSE")
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
  if (!adapter) throw failure(`agent provider ${input.agent.provider || input.agent.name} is not executable by the web chat`, 409, "UNSUPPORTED_PROVIDER")
  if (!input.model) throw failure("a model must be selected", 409, "MODEL_REQUIRED")
  if (adapter === "openai-responses" || adapter === "xai-responses") return executeResponsesApi(input)
  if (adapter === "anthropic-messages") return executeAnthropic(input)
  if (adapter === "gemini-generate-content") return executeGemini(input)
  if (adapter === "cursor-cloud") return executeCursor(input)
  throw failure(`unsupported agent adapter ${adapter}`, 409, "UNSUPPORTED_ADAPTER")
}
