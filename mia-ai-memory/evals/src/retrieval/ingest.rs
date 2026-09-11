//! Replay LongMemEval haystack sessions through the real hook-ingest
//! surface (`POST /hook/batch`), at the same cadence the lifecycle hooks
//! produce in production: `session-start`, then per chat round a
//! `user-prompt-submit` (user turn) and a `stop` carrying the opt-in
//! assistant excerpt (assistant turn), then `session-end`.
//!
//! Fidelity notes, deliberately inherited from the production capture:
//!
//! - excerpts are bounded (~2 KB) at the privacy boundary, so evidence
//!   buried deeper in a single long turn is genuinely out of reach;
//! - each session's original date is prepended to turn text (production
//!   installs see wall-clock time; replayed histories must carry their
//!   own), mirroring what the official LongMemEval harness exposes to
//!   retrievers as session timestamps.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::json;

use super::dataset::Question;
use super::server::EVAL_AUTH_TOKEN;

/// Everything in one benchmark run lives in this workspace.
pub const EVAL_WORKSPACE: &str = "longmemeval";

/// Server-side cap on batch items per request.
const MAX_BATCH: usize = 256;

/// Client-side mirror of the capture excerpt cap; anything longer is
/// truncated by the server anyway, and the assistant marker requires the
/// client to do the capping.
const EXCERPT_MAX_BYTES: usize = 2_000;

/// Project name for one benchmark question (its private haystack).
pub fn project_for(q: &Question) -> String {
    format!("lme-{}", q.question_id)
}

/// The store hashes non-UUID session ids to UUIDv5(NAMESPACE_OID, raw)
/// (`resolve_native_session_id`); the scorer recomputes the same mapping
/// to attribute `sessions/<uuid>.md` page hits back to dataset sessions.
pub fn stored_session_uuid(raw: &str) -> uuid::Uuid {
    match uuid::Uuid::parse_str(raw) {
        Ok(u) => u,
        Err(_) => uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, raw.as_bytes()),
    }
}

/// Truncate on a char boundary so the marker stays valid UTF-8.
fn cap_excerpt(s: &str) -> &str {
    if s.len() <= EXCERPT_MAX_BYTES {
        return s;
    }
    let mut end = EXCERPT_MAX_BYTES;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[derive(serde::Serialize)]
struct BatchItem {
    url: String,
    body: serde_json::Value,
}

/// Build the full event replay for one question's haystack.
fn build_items(q: &Question) -> Vec<BatchItem> {
    let project = project_for(q);
    let cwd = format!("/lme/{project}");
    let mut items = Vec::new();
    let mut push = |event: &str, session_id: &str, extra: serde_json::Value| {
        let mut url = format!(
            "/hook?event={event}&agent=claude-code&workspace={EVAL_WORKSPACE}&project={project}&session_id={session_id}"
        );
        if event == "stop" {
            url.push_str("&capture_assistant=1");
        }
        let mut body = json!({
            "session_id": session_id,
            "cwd": cwd,
        });
        if let serde_json::Value::Object(extra) = extra {
            body.as_object_mut()
                .expect("body is an object")
                .extend(extra);
        }
        items.push(BatchItem { url, body });
    };

    for (idx, session) in q.haystack_sessions.iter().enumerate() {
        let sid = &q.haystack_session_ids[idx];
        let date = &q.haystack_dates[idx];
        push(
            "session-start",
            sid,
            json!({ "hook_event_name": "SessionStart", "source": "startup" }),
        );
        for turn in session {
            match turn.role.as_str() {
                "user" => push(
                    "user-prompt-submit",
                    sid,
                    json!({
                        "hook_event_name": "UserPromptSubmit",
                        "prompt": format!("[session date: {date}] {}", turn.content),
                    }),
                ),
                "assistant" => push(
                    "stop",
                    sid,
                    json!({
                        "hook_event_name": "Stop",
                        "_ai_memory_assistant": {
                            "version": 1,
                            "excerpt": format!("[session date: {date}] {}", cap_excerpt(&turn.content)),
                        },
                    }),
                ),
                other => {
                    tracing::warn!(role = other, "unknown role in dataset; skipping turn");
                }
            }
        }
        push(
            "session-end",
            sid,
            json!({ "hook_event_name": "SessionEnd", "reason": "exit" }),
        );
    }
    items
}

/// Replay one question's haystack. Retries items the server's per-source
/// rate limiting skipped, until everything is accepted — silently missing
/// haystack data would corrupt the benchmark.
pub async fn ingest_question(
    client: &reqwest::Client,
    base_url: &str,
    q: &Question,
) -> Result<usize> {
    let items = build_items(q);
    let total = items.len();
    let mut pending: Vec<&BatchItem> = items.iter().collect();
    let mut attempts = 0usize;
    while !pending.is_empty() {
        attempts += 1;
        if attempts > 60 {
            bail!(
                "question {}: {} hook items still unaccepted after {} passes",
                q.question_id,
                pending.len(),
                attempts - 1
            );
        }
        let mut next = Vec::new();
        for chunk in pending.chunks(MAX_BATCH) {
            let resp = client
                .post(format!("{base_url}/hook/batch"))
                .bearer_auth(EVAL_AUTH_TOKEN)
                .json(&chunk)
                .send()
                .await
                .context("posting hook batch")?
                .error_for_status()
                .context("hook batch rejected")?;
            let ack: serde_json::Value = resp.json().await?;
            let accepted: Vec<usize> = match ack.get("accepted_indices") {
                Some(serde_json::Value::Array(idx)) => idx
                    .iter()
                    .filter_map(|v| v.as_u64().map(|v| v as usize))
                    .collect(),
                _ => {
                    let prefix = ack.get("accepted").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    (0..prefix).collect()
                }
            };
            let accepted_set: std::collections::HashSet<usize> = accepted.into_iter().collect();
            for (i, item) in chunk.iter().enumerate() {
                if !accepted_set.contains(&i) {
                    next.push(*item);
                }
            }
        }
        if !next.is_empty() {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        pending = next;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retrieval::dataset::Turn;

    fn q() -> Question {
        serde_json::from_value(serde_json::json!({
            "question_id": "qX",
            "question_type": "single-session-user",
            "question": "?",
            "answer": "a",
            "question_date": "d",
            "haystack_dates": ["2023/05/20 (Sat) 02:21"],
            "haystack_session_ids": ["sharegpt_abc_0"],
            "haystack_sessions": [[
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi"}
            ]],
            "answer_session_ids": ["sharegpt_abc_0"]
        }))
        .unwrap()
    }

    #[test]
    fn replay_matches_the_production_hook_cadence() {
        let items = build_items(&q());
        let events: Vec<&str> = items
            .iter()
            .map(|i| {
                i.url
                    .split("event=")
                    .nth(1)
                    .unwrap()
                    .split('&')
                    .next()
                    .unwrap()
            })
            .collect();
        assert_eq!(
            events,
            ["session-start", "user-prompt-submit", "stop", "session-end"]
        );
        // stop carries the opt-in marker and the capture flag
        let stop = &items[2];
        assert!(stop.url.contains("capture_assistant=1"));
        assert_eq!(stop.body["_ai_memory_assistant"]["version"], 1);
        // every item scopes explicitly
        for item in &items {
            assert!(item.url.contains("workspace=longmemeval"));
            assert!(item.url.contains("project=lme-qX"));
        }
    }

    #[test]
    fn session_dates_are_visible_to_the_retriever() {
        let items = build_items(&q());
        let prompt = items[1].body["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("[session date: 2023/05/20"));
    }

    #[test]
    fn excerpts_are_capped_on_char_boundaries() {
        let long = format!("{}é", "x".repeat(EXCERPT_MAX_BYTES - 1));
        let capped = cap_excerpt(&long);
        assert!(capped.len() <= EXCERPT_MAX_BYTES);
        assert!(std::str::from_utf8(capped.as_bytes()).is_ok());
    }

    #[test]
    fn non_uuid_session_ids_map_to_the_stores_v5_hash() {
        // Mirrors resolve_native_session_id in the hooks router.
        let mapped = stored_session_uuid("sharegpt_abc_0");
        assert_eq!(
            mapped,
            uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, b"sharegpt_abc_0")
        );
        let real = uuid::Uuid::now_v7();
        assert_eq!(stored_session_uuid(&real.to_string()), real);
    }

    #[test]
    fn unknown_roles_are_skipped_not_mislabelled() {
        let mut question = q();
        question.haystack_sessions[0].push(Turn {
            role: "system".into(),
            content: "x".into(),
        });
        let items = build_items(&question);
        // still start, prompt, stop, end — the system turn produced nothing
        assert_eq!(items.len(), 4);
    }
}
