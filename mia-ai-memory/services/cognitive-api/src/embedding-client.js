import { config } from "./config.js"

export const createQueryEmbedding = async query => {
  if (!config.embeddingBaseUrl || !config.embeddingProvider || !config.embeddingModel || !config.embeddingDim) return null
  const headers = { "Content-Type": "application/json", Accept: "application/json" }
  if (config.embeddingApiKey) headers.Authorization = `Bearer ${config.embeddingApiKey}`
  const response = await fetch(`${config.embeddingBaseUrl}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: query, model: config.embeddingModel, dimensions: config.embeddingDim }),
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error(`embedding provider returned HTTP ${response.status}`)
  const body = await response.json()
  const vector = body?.data?.[0]?.embedding
  if (!Array.isArray(vector) || vector.length !== config.embeddingDim) throw new Error("embedding response dimension mismatch")
  return {
    vector,
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    dim: config.embeddingDim
  }
}
