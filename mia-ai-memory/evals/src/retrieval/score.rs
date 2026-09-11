//! Session-level retrieval scoring, matching how published LongMemEval
//! retrieval numbers are reported: for each question, did the evidence
//! sessions surface in the top k retrieved results?
//!
//! Two metrics per k:
//!
//! - `hit@k` — 1.0 when ANY evidence session appears in the top k
//!   (the "Recall@k" most memory systems publish);
//! - `recall@k` — the fraction of that question's evidence sessions
//!   found in the top k (stricter on multi-session questions).
//!
//! Abstention questions have no evidence sessions and are excluded
//! from both (reported separately as a count).

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;

use super::query::Retrieved;

/// Per-question outcome, ready for aggregation.
#[derive(Debug, Clone, Serialize)]
pub struct QuestionScore {
    pub question_id: String,
    pub question_type: String,
    /// hit@k and recall@k keyed by k.
    pub hit_at: BTreeMap<usize, f64>,
    pub recall_at: BTreeMap<usize, f64>,
    /// Deduped session attributions actually retrieved (for forensics).
    pub retrieved_sessions: usize,
}

/// Score one question's retrieval run.
///
/// `evidence` holds the stored (uuid-mapped) ids of the answer sessions;
/// `retrieved` is the ranked flattened result list. Duplicate session
/// attributions collapse to their best (first) rank — retrieving three
/// chunks of one session fills one slot, not three.
pub fn score_question(
    question_id: &str,
    question_type: &str,
    evidence: &HashSet<uuid::Uuid>,
    retrieved: &[Retrieved],
    ks: &[usize],
) -> QuestionScore {
    let mut seen = HashSet::new();
    let mut ranked_sessions = Vec::new();
    for r in retrieved {
        if let Some(sid) = r.session_uuid
            && seen.insert(sid)
        {
            ranked_sessions.push(sid);
        }
    }
    let mut hit_at = BTreeMap::new();
    let mut recall_at = BTreeMap::new();
    for &k in ks {
        let top: HashSet<&uuid::Uuid> = ranked_sessions.iter().take(k).collect();
        let found = evidence.iter().filter(|e| top.contains(e)).count();
        hit_at.insert(k, if found > 0 { 1.0 } else { 0.0 });
        recall_at.insert(
            k,
            if evidence.is_empty() {
                0.0
            } else {
                found as f64 / evidence.len() as f64
            },
        );
    }
    QuestionScore {
        question_id: question_id.to_string(),
        question_type: question_type.to_string(),
        hit_at,
        recall_at,
        retrieved_sessions: ranked_sessions.len(),
    }
}

/// Aggregated metrics for one slice (a category, or overall).
#[derive(Debug, Clone, Serialize)]
pub struct SliceMetrics {
    pub questions: usize,
    pub hit_at: BTreeMap<usize, f64>,
    pub recall_at: BTreeMap<usize, f64>,
}

/// Macro-average scores per category plus an `overall` slice.
pub fn aggregate(scores: &[QuestionScore], ks: &[usize]) -> BTreeMap<String, SliceMetrics> {
    let mut slices: BTreeMap<String, Vec<&QuestionScore>> = BTreeMap::new();
    for s in scores {
        slices.entry(s.question_type.clone()).or_default().push(s);
        slices.entry("overall".to_string()).or_default().push(s);
    }
    slices
        .into_iter()
        .map(|(name, group)| {
            let n = group.len() as f64;
            let mut hit_at = BTreeMap::new();
            let mut recall_at = BTreeMap::new();
            for &k in ks {
                hit_at.insert(k, group.iter().map(|s| s.hit_at[&k]).sum::<f64>() / n);
                recall_at.insert(k, group.iter().map(|s| s.recall_at[&k]).sum::<f64>() / n);
            }
            (
                name,
                SliceMetrics {
                    questions: group.len(),
                    hit_at,
                    recall_at,
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retrieved(ids: &[Option<uuid::Uuid>]) -> Vec<Retrieved> {
        ids.iter()
            .map(|session_uuid| Retrieved {
                session_uuid: *session_uuid,
            })
            .collect()
    }

    #[test]
    fn a_top_one_hit_scores_across_all_ks() {
        let e = uuid::Uuid::now_v7();
        let s = score_question(
            "q",
            "single-session-user",
            &HashSet::from([e]),
            &retrieved(&[Some(e)]),
            &[1, 5],
        );
        assert_eq!(s.hit_at[&1], 1.0);
        assert_eq!(s.hit_at[&5], 1.0);
        assert_eq!(s.recall_at[&1], 1.0);
    }

    #[test]
    fn evidence_below_the_cutoff_does_not_count() {
        let e = uuid::Uuid::now_v7();
        let others: Vec<Option<uuid::Uuid>> = (0..3).map(|_| Some(uuid::Uuid::now_v7())).collect();
        let mut all = others.clone();
        all.push(Some(e)); // rank 4 (0-based 3)
        let s = score_question(
            "q",
            "multi-session",
            &HashSet::from([e]),
            &retrieved(&all),
            &[1, 3, 5],
        );
        assert_eq!(s.hit_at[&1], 0.0);
        assert_eq!(s.hit_at[&3], 0.0);
        assert_eq!(s.hit_at[&5], 1.0);
    }

    #[test]
    fn duplicate_session_chunks_fill_one_slot_not_three() {
        let e = uuid::Uuid::now_v7();
        let noise = uuid::Uuid::now_v7();
        // three chunks of the same noise session ahead of the evidence
        let s = score_question(
            "q",
            "multi-session",
            &HashSet::from([e]),
            &retrieved(&[Some(noise), Some(noise), Some(noise), Some(e)]),
            &[2],
        );
        // dedup: noise occupies rank 0, evidence rank 1 → hit@2
        assert_eq!(s.hit_at[&2], 1.0);
    }

    #[test]
    fn partial_multi_session_recall_is_fractional() {
        let e1 = uuid::Uuid::now_v7();
        let e2 = uuid::Uuid::now_v7();
        let s = score_question(
            "q",
            "multi-session",
            &HashSet::from([e1, e2]),
            &retrieved(&[Some(e1)]),
            &[5],
        );
        assert_eq!(s.recall_at[&5], 0.5);
        assert_eq!(s.hit_at[&5], 1.0);
    }

    #[test]
    fn unattributed_pages_never_score() {
        let e = uuid::Uuid::now_v7();
        let s = score_question(
            "q",
            "single-session-user",
            &HashSet::from([e]),
            &retrieved(&[None, None]),
            &[5],
        );
        assert_eq!(s.hit_at[&5], 0.0);
        assert_eq!(s.retrieved_sessions, 0);
    }

    /// Control: a scorer that credited ANY retrieval would ace a shuffled
    /// result list; the real scorer must not.
    #[test]
    fn random_sessions_score_zero() {
        let e = uuid::Uuid::now_v7();
        let random: Vec<Option<uuid::Uuid>> = (0..10).map(|_| Some(uuid::Uuid::now_v7())).collect();
        let s = score_question(
            "q",
            "knowledge-update",
            &HashSet::from([e]),
            &retrieved(&random),
            &[1, 3, 5, 10],
        );
        for k in [1, 3, 5, 10] {
            assert_eq!(s.hit_at[&k], 0.0, "hit@{k}");
            assert_eq!(s.recall_at[&k], 0.0, "recall@{k}");
        }
    }

    #[test]
    fn aggregation_macro_averages_per_category_and_overall() {
        let e = uuid::Uuid::now_v7();
        let hit = score_question(
            "q1",
            "multi-session",
            &HashSet::from([e]),
            &retrieved(&[Some(e)]),
            &[1],
        );
        let miss = score_question(
            "q2",
            "multi-session",
            &HashSet::from([uuid::Uuid::now_v7()]),
            &retrieved(&[]),
            &[1],
        );
        let agg = aggregate(&[hit, miss], &[1]);
        assert_eq!(agg["multi-session"].hit_at[&1], 0.5);
        assert_eq!(agg["overall"].questions, 2);
    }
}
