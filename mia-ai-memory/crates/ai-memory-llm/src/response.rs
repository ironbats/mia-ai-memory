use serde::de::DeserializeOwned;

use crate::error::{LlmError, LlmResult};
use crate::text::truncate_with_ellipsis;

/// Generous cap for successful provider responses. Normal chat, structured
/// output, SSE transcripts, and embedding payloads are far smaller; this only
/// protects us from broken or hostile provider endpoints buffering forever.
pub(crate) const MAX_PROVIDER_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES: usize = 1024 * 1024;
const DISPLAY_ERROR_BYTES: usize = 1024;

pub(crate) async fn response_bytes_limited(
    mut resp: reqwest::Response,
    max_bytes: usize,
) -> LlmResult<Vec<u8>> {
    let status = resp.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(LlmError::from)? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(LlmError::Provider {
                status,
                body: format!("provider response exceeded {max_bytes} bytes"),
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) async fn response_text_limited(resp: reqwest::Response) -> LlmResult<String> {
    let bytes = response_bytes_limited(resp, MAX_PROVIDER_RESPONSE_BYTES).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) async fn response_json_limited<T: DeserializeOwned>(
    resp: reqwest::Response,
) -> LlmResult<T> {
    let bytes = response_bytes_limited(resp, MAX_PROVIDER_RESPONSE_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(LlmError::from)
}

pub(crate) async fn provider_error_body(resp: reqwest::Response) -> String {
    match response_bytes_limited(resp, MAX_PROVIDER_ERROR_BYTES).await {
        Ok(bytes) => {
            let body = String::from_utf8_lossy(&bytes);
            truncate_with_ellipsis(body.as_ref(), DISPLAY_ERROR_BYTES)
        }
        Err(LlmError::Provider { body, .. }) => body,
        Err(e) => format!("<failed to read provider error body: {e}>"),
    }
}
