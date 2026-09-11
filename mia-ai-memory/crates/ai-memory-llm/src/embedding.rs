//! Embedding provider abstraction.
//!
//! Embedding implementations ship in M9:
//!
//! * [`OpenAiEmbedder`] — production: hits OpenAI's `/v1/embeddings`.
//! * [`VoyageEmbedder`] — production: hits Voyage's `/v1/embeddings`.
//! * [`GoogleEmbedder`](crate::google::GoogleEmbedder) — Gemini `embedContent`.
//! * [`SyntheticEmbedder`] — test-only: deterministic bag-of-words
//!   embedding so integration tests can demonstrate semantic
//!   retrieval without an API key.
//!
//! * [`LocalEmbedder`](crate::local::LocalEmbedder) — in-process
//!   pure-Rust BERT (`all-MiniLM-L6-v2`), no key and no server; see
//!   `docs/local-embeddings.md`.

use std::time::Duration;

use async_trait::async_trait;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::error::{LlmError, LlmResult};
use crate::openai::normalize_openai_base;
use crate::response::{provider_error_body, response_json_limited, response_text_limited};
use crate::text::{truncate_for_embedding, truncate_with_ellipsis};

/// Conservative per-request input cap for OpenAI-compatible embedding APIs
/// (8192 token server limit; we stay well below with head truncation).
const OPENAI_EMBED_MAX_TOKENS: usize = 5000;

/// Provider-agnostic embedding API.
///
/// Implementations must be `Send + Sync` (the MCP server / hook
/// router stash an `Arc<dyn Embedder>` and use it from any tokio
/// task).
#[async_trait]
pub trait Embedder: Send + Sync {
    /// Short identifier (e.g. `openai`, `voyage`, `synthetic`).
    fn provider(&self) -> &'static str;

    /// Model identifier (e.g. `text-embedding-3-small`).
    fn model(&self) -> &str;

    /// Vector dimensionality.
    fn dim(&self) -> u32;

    /// Embed one text. Returns a unit-normalised vector — callers can
    /// dot-product directly to get cosine similarity.
    async fn embed(&self, text: &str) -> LlmResult<Vec<f32>>;

    /// Embed wiki page / document body (hybrid index writes).
    async fn embed_document(&self, text: &str) -> LlmResult<Vec<f32>> {
        self.embed(text).await
    }

    /// Embed a search query (hybrid retrieval).
    async fn embed_query(&self, text: &str) -> LlmResult<Vec<f32>> {
        self.embed(text).await
    }
}

/// OpenAI Embeddings API (`text-embedding-3-small` by default, 1536 dim).
pub struct OpenAiEmbedder {
    client: reqwest::Client,
    api_key: SecretString,
    base_url: String,
    model: String,
    dim: u32,
}

impl OpenAiEmbedder {
    /// Construct an embedder.
    ///
    /// # Errors
    /// Propagates any `reqwest::Error` thrown while building the HTTP
    /// client.
    pub fn new(api_key: SecretString, model: impl Into<String>, dim: u32) -> LlmResult<Self> {
        // 120s tolerates a cold-load of the embedding model on Ollama
        // (small model, but still up to ~30s on first request after
        // unload). Subsequent requests with OLLAMA_KEEP_ALIVE warm are
        // sub-second. When the embedder still fails, memory_query
        // degrades gracefully to FTS5 + entity + graph (see server.rs).
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        Ok(Self {
            client,
            api_key,
            base_url: "https://api.openai.com".into(),
            model: model.into(),
            dim,
        })
    }

    /// Override the base URL (for tests against a wiremock).
    #[must_use]
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }
}

#[derive(Debug, Serialize)]
struct OpenAiEmbeddingRequest<'a> {
    input: &'a str,
    model: &'a str,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingResponse {
    data: Vec<OpenAiEmbeddingDatum>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingDatum {
    embedding: Vec<f32>,
}

/// Parse OpenAI-compatible embedding responses, including OpenRouter error bodies.
fn parse_openai_embedding_values(body: &str, status: u16) -> LlmResult<Vec<f32>> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| LlmError::Provider {
        status,
        body: truncate_with_ellipsis(&format!("openai embeddings json: {e}; body={body}"), 1024),
    })?;
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .or_else(|| err.as_str())
            .unwrap_or("unknown");
        return Err(LlmError::Provider {
            status,
            body: truncate_with_ellipsis(msg, 1024),
        });
    }
    if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
        let first = data.first().ok_or_else(|| LlmError::Provider {
            status,
            body: truncate_with_ellipsis(
                &format!("openai embeddings data[] empty; body={body}"),
                512,
            ),
        })?;
        let emb = first
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| LlmError::Provider {
                status,
                body: truncate_with_ellipsis(
                    &format!("missing embedding array in data[0]; body={body}"),
                    512,
                ),
            })?;
        let mut out = Vec::with_capacity(emb.len());
        for n in emb {
            let f = n.as_f64().ok_or_else(|| LlmError::Provider {
                status,
                body: truncate_with_ellipsis(
                    &format!("non-numeric embedding value in data[0]; body={body}"),
                    512,
                ),
            })?;
            out.push(f as f32);
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }
    // Strict OpenAI shape fallback.
    let parsed: OpenAiEmbeddingResponse =
        serde_json::from_value(v).map_err(|e| LlmError::Provider {
            status,
            body: truncate_with_ellipsis(
                &format!("openai embeddings shape: {e}; body={body}"),
                1024,
            ),
        })?;
    let first = parsed.data.into_iter().next().ok_or_else(|| {
        LlmError::UnexpectedShape(format!(
            "openai response had no data[0]; body={}",
            truncate_with_ellipsis(body, 512)
        ))
    })?;
    Ok(first.embedding)
}

/// Shared OpenAI-shape embedding request: head-truncate, POST
/// `/embeddings` (bearer auth only when a key is present — local
/// engines such as Ollama and LM Studio run keyless), retry 429 with
/// backoff, parse, dim-check, unit-normalise.
async fn openai_style_embed(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&SecretString>,
    model: &str,
    dim: u32,
    text: &str,
) -> LlmResult<Vec<f32>> {
    let input = truncate_for_embedding(text, OPENAI_EMBED_MAX_TOKENS);
    let url = normalize_openai_base(base_url, "embeddings");
    debug!(
        url,
        model,
        input_chars = input.len(),
        "POST openai/embeddings"
    );
    let req = OpenAiEmbeddingRequest {
        input: &input,
        model,
    };
    let mut attempt = 0u32;
    loop {
        let mut builder = client.post(&url);
        if let Some(key) = api_key {
            builder = builder.bearer_auth(key.expose_secret());
        }
        let resp = builder.json(&req).send().await?;
        let status = resp.status();
        if status.as_u16() == 429 && attempt < 5 {
            attempt += 1;
            let delay = Duration::from_secs(2u64.saturating_pow(attempt));
            debug!(attempt, ?delay, "openai embeddings rate-limited; retrying");
            tokio::time::sleep(delay).await;
            continue;
        }
        // Client errors (e.g. input > 8192 tokens) are not retried.
        if status.as_u16() == 400 {
            let body = provider_error_body(resp).await;
            return Err(LlmError::Provider {
                status: status.as_u16(),
                body,
            });
        }
        if !status.is_success() {
            let body = provider_error_body(resp).await;
            return Err(LlmError::Provider {
                status: status.as_u16(),
                body,
            });
        }
        let body = response_text_limited(resp).await?;
        let values = parse_openai_embedding_values(&body, status.as_u16())?;
        if values.len() as u32 != dim {
            return Err(LlmError::UnexpectedShape(format!(
                "expected dim {}, got {}",
                dim,
                values.len()
            )));
        }
        return Ok(normalise(values));
    }
}

#[async_trait]
impl Embedder for OpenAiEmbedder {
    fn provider(&self) -> &'static str {
        "openai"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn dim(&self) -> u32 {
        self.dim
    }

    async fn embed(&self, text: &str) -> LlmResult<Vec<f32>> {
        openai_style_embed(
            &self.client,
            &self.base_url,
            Some(&self.api_key),
            &self.model,
            self.dim,
            text,
        )
        .await
    }
}

/// OpenAI-compatible embeddings endpoint (Ollama / LM Studio / vLLM /
/// OpenRouter). Same wire shape as [`OpenAiEmbedder`], but the base
/// URL is required, the API key is optional (local engines run
/// keyless), and vectors are stored under the distinct provider label
/// `openai-compat` so the `{provider, model, dim}` refuse-on-mismatch
/// check treats them as their own family.
pub struct OpenAiCompatEmbedder {
    client: reqwest::Client,
    api_key: Option<SecretString>,
    base_url: String,
    model: String,
    dim: u32,
}

impl OpenAiCompatEmbedder {
    /// Construct a compat embedder against `base_url`.
    ///
    /// # Errors
    /// Propagates any `reqwest::Error` thrown while building the HTTP
    /// client.
    pub fn new(
        base_url: impl Into<String>,
        api_key: Option<SecretString>,
        model: impl Into<String>,
        dim: u32,
    ) -> LlmResult<Self> {
        // Same cold-load tolerance as OpenAiEmbedder: first request
        // after an Ollama model unload can take ~30s.
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        Ok(Self {
            client,
            api_key,
            base_url: base_url.into(),
            model: model.into(),
            dim,
        })
    }
}

#[async_trait]
impl Embedder for OpenAiCompatEmbedder {
    fn provider(&self) -> &'static str {
        "openai-compat"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn dim(&self) -> u32 {
        self.dim
    }

    async fn embed(&self, text: &str) -> LlmResult<Vec<f32>> {
        openai_style_embed(
            &self.client,
            &self.base_url,
            self.api_key.as_ref(),
            &self.model,
            self.dim,
            text,
        )
        .await
    }
}

/// Voyage Embeddings API.
pub struct VoyageEmbedder {
    client: reqwest::Client,
    api_key: SecretString,
    base_url: String,
    model: String,
    dim: u32,
}

impl VoyageEmbedder {
    /// Construct a Voyage embedder.
    ///
    /// # Errors
    /// Propagates the HTTP client construction error.
    pub fn new(api_key: SecretString, model: impl Into<String>, dim: u32) -> LlmResult<Self> {
        // 120s tolerates a cold-load of the embedding model on Ollama
        // (small model, but still up to ~30s on first request after
        // unload). Subsequent requests with OLLAMA_KEEP_ALIVE warm are
        // sub-second. When the embedder still fails, memory_query
        // degrades gracefully to FTS5 + entity + graph (see server.rs).
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        Ok(Self {
            client,
            api_key,
            base_url: "https://api.voyageai.com".into(),
            model: model.into(),
            dim,
        })
    }

    /// Override the base URL.
    #[must_use]
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }
}

#[derive(Debug, Serialize)]
struct VoyageRequest<'a> {
    input: [&'a str; 1],
    model: &'a str,
}

#[derive(Debug, Deserialize)]
struct VoyageResponse {
    data: Vec<VoyageDatum>,
}

#[derive(Debug, Deserialize)]
struct VoyageDatum {
    embedding: Vec<f32>,
}

#[async_trait]
impl Embedder for VoyageEmbedder {
    fn provider(&self) -> &'static str {
        "voyage"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn dim(&self) -> u32 {
        self.dim
    }

    async fn embed(&self, text: &str) -> LlmResult<Vec<f32>> {
        let url = normalize_openai_base(&self.base_url, "embeddings");
        let req = VoyageRequest {
            input: [text],
            model: &self.model,
        };
        let resp = self
            .client
            .post(&url)
            .bearer_auth(self.api_key.expose_secret())
            .json(&req)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = provider_error_body(resp).await;
            return Err(LlmError::Provider {
                status: status.as_u16(),
                body,
            });
        }
        let parsed: VoyageResponse = response_json_limited(resp).await?;
        let first =
            parsed.data.into_iter().next().ok_or_else(|| {
                LlmError::UnexpectedShape("voyage response had no data[0]".into())
            })?;
        if first.embedding.len() as u32 != self.dim {
            return Err(LlmError::UnexpectedShape(format!(
                "expected dim {}, got {}",
                self.dim,
                first.embedding.len()
            )));
        }
        Ok(normalise(first.embedding))
    }
}

/// Deterministic synthetic embedder for tests.
///
/// Each whitespace-separated word in the text adds 1.0 to one
/// dimension chosen by the word's hash. Vectors are unit-normalised.
/// Similar text → similar vectors, which is enough to demonstrate
/// hybrid retrieval beats either ranker alone.
pub struct SyntheticEmbedder {
    dim: u32,
}

impl SyntheticEmbedder {
    /// Construct with the given dimensionality.
    #[must_use]
    pub const fn new(dim: u32) -> Self {
        Self { dim }
    }
}

#[async_trait]
impl Embedder for SyntheticEmbedder {
    fn provider(&self) -> &'static str {
        "synthetic"
    }

    fn model(&self) -> &str {
        "bag-of-words-v1"
    }

    fn dim(&self) -> u32 {
        self.dim
    }

    async fn embed(&self, text: &str) -> LlmResult<Vec<f32>> {
        let mut v = vec![0.0_f32; self.dim as usize];
        for word in text.split(|c: char| !c.is_alphanumeric()) {
            if word.is_empty() {
                continue;
            }
            let lower = word.to_ascii_lowercase();
            let h = fnv1a(&lower) as usize;
            let idx = h % v.len();
            v[idx] += 1.0;
        }
        Ok(normalise(v))
    }
}

/// Unit-normalise so dot-product equals cosine similarity.
pub(crate) fn normalise(mut v: Vec<f32>) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in s.as_bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// Cosine similarity between two same-dim unit vectors. (= dot product
/// after normalisation.)
#[must_use]
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn synthetic_embedder_produces_unit_vectors() {
        let e = SyntheticEmbedder::new(64);
        let v = e.embed("hello world hello").await.unwrap();
        assert_eq!(v.len(), 64);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "expected unit norm, got {norm}");
    }

    #[tokio::test]
    async fn synthetic_similar_text_has_higher_cosine() {
        let e = SyntheticEmbedder::new(256);
        let a = e
            .embed("retention sweep evicts stale episodic pages")
            .await
            .unwrap();
        let close = e
            .embed("the sweep evicts stale episodic pages")
            .await
            .unwrap();
        let far = e
            .embed("docker compose volumes and bind mounts")
            .await
            .unwrap();
        let s_close = cosine(&a, &close);
        let s_far = cosine(&a, &far);
        assert!(
            s_close > s_far,
            "similar text should cosine higher than unrelated: close={s_close} far={s_far}"
        );
    }

    #[tokio::test]
    async fn synthetic_is_deterministic() {
        let e = SyntheticEmbedder::new(64);
        let a = e.embed("compile not retrieve").await.unwrap();
        let b = e.embed("compile not retrieve").await.unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn parse_openai_embedding_accepts_data_array() {
        let body = r#"{"data":[{"embedding":[0.1,0.2,0.3]}]}"#;
        let v = parse_openai_embedding_values(body, 200).unwrap();
        assert_eq!(v.len(), 3);
    }

    #[test]
    fn parse_openai_embedding_accepts_openrouter_error() {
        let body = r#"{"error":{"message":"Provider returned error","code":502}}"#;
        let err = parse_openai_embedding_values(body, 502).unwrap_err();
        assert!(matches!(err, LlmError::Provider { status: 502, .. }));
    }

    #[test]
    fn parse_openai_embedding_rejects_non_numeric_values() {
        let body = r#"{"data":[{"embedding":[0.1,"oops",0.3]}]}"#;
        let err = parse_openai_embedding_values(body, 200).unwrap_err();
        assert!(matches!(err, LlmError::Provider { status: 200, .. }));
    }
}
