//! Query the eval server through the real MCP surface — the same
//! Streamable-HTTP `tools/call memory_query` an agent uses. Explicit
//! `workspace` + `project` args scope each call to one question's
//! haystack (the documented pattern for static MCP clients).

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::json;

use super::server::EVAL_AUTH_TOKEN;

/// One retrieval hit after flattening pages + raw observations, in
/// rank order (index 0 = best).
#[derive(Debug, Clone)]
pub struct Retrieved {
    /// `sessions/<uuid>.md` page or raw observation → owning session
    /// uuid; other pages have no session provenance.
    pub session_uuid: Option<uuid::Uuid>,
}

#[derive(Debug, Deserialize)]
struct QueryResponse {
    #[serde(default)]
    hits: Vec<PageHitLite>,
    #[serde(default)]
    raw_hits: Vec<RawHitLite>,
}

#[derive(Debug, Deserialize)]
struct PageHitLite {
    path: String,
}

#[derive(Debug, Deserialize)]
struct RawHitLite {
    session_id: uuid::Uuid,
}

/// Call `memory_query` and flatten the response into ranked session
/// attributions: compiled-page hits first (they are the primary answer
/// surface), then raw observation hits, preserving each list's order.
pub async fn memory_query(
    client: &reqwest::Client,
    base_url: &str,
    workspace: &str,
    project: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<Retrieved>> {
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "memory_query",
            "arguments": {
                "query": query,
                "workspace": workspace,
                "project": project,
                "limit": limit,
            }
        }
    });
    let resp = client
        .post(format!("{base_url}/mcp"))
        .bearer_auth(EVAL_AUTH_TOKEN)
        .header("accept", "application/json, text/event-stream")
        .json(&request)
        .send()
        .await
        .context("posting MCP tools/call")?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await?;
    if !status.is_success() {
        bail!("MCP call failed ({status}): {body}");
    }

    let rpc: serde_json::Value = if content_type.starts_with("text/event-stream") {
        // Streamable HTTP may frame the response as SSE; the JSON-RPC
        // response is the last `data:` payload carrying our id.
        let mut last = None;
        for line in body.lines() {
            if let Some(data) = line.strip_prefix("data:")
                && let Ok(v) = serde_json::from_str::<serde_json::Value>(data.trim())
                && v.get("id").is_some()
            {
                last = Some(v);
            }
        }
        last.ok_or_else(|| anyhow::anyhow!("no JSON-RPC response in SSE stream: {body}"))?
    } else {
        serde_json::from_str(&body).with_context(|| format!("parsing MCP response: {body}"))?
    };

    if let Some(err) = rpc.get("error") {
        bail!("MCP error: {err}");
    }
    let result = rpc
        .get("result")
        .ok_or_else(|| anyhow::anyhow!("MCP response missing result: {rpc}"))?;
    if result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        bail!("memory_query tool error: {result}");
    }
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow::anyhow!("memory_query returned no text content: {result}"))?;
    let parsed: QueryResponse =
        serde_json::from_str(text).with_context(|| format!("parsing memory_query JSON: {text}"))?;
    Ok(flatten(parsed))
}

fn flatten(resp: QueryResponse) -> Vec<Retrieved> {
    let mut out = Vec::new();
    for hit in resp.hits {
        out.push(Retrieved {
            session_uuid: session_uuid_from_path(&hit.path),
        });
    }
    for hit in resp.raw_hits {
        out.push(Retrieved {
            session_uuid: Some(hit.session_id),
        });
    }
    out
}

/// `sessions/<uuid>.md` → the owning session; anything else → None.
fn session_uuid_from_path(path: &str) -> Option<uuid::Uuid> {
    let stem = path.strip_prefix("sessions/")?.strip_suffix(".md")?;
    uuid::Uuid::parse_str(stem).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_pages_attribute_and_other_pages_do_not() {
        let sid = uuid::Uuid::now_v7();
        assert_eq!(
            session_uuid_from_path(&format!("sessions/{sid}.md")),
            Some(sid)
        );
        assert_eq!(session_uuid_from_path("gotchas/build.md"), None);
        assert_eq!(session_uuid_from_path("sessions/not-a-uuid.md"), None);
    }

    #[test]
    fn pages_rank_before_raw_hits_and_order_is_preserved() {
        let a = uuid::Uuid::now_v7();
        let b = uuid::Uuid::now_v7();
        let resp = QueryResponse {
            hits: vec![PageHitLite {
                path: format!("sessions/{a}.md"),
            }],
            raw_hits: vec![RawHitLite { session_id: b }],
        };
        let flat = flatten(resp);
        assert_eq!(flat.len(), 2);
        assert_eq!(flat[0].session_uuid, Some(a));
        assert_eq!(flat[1].session_uuid, Some(b));
    }
}
