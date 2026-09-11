//! Render benchmark results as JSON (machine) + markdown (human), with
//! enough provenance (dataset sha, commit, hardware, config) that a
//! published number can be audited later.

use std::collections::BTreeMap;

use serde::Serialize;

use super::score::{QuestionScore, SliceMetrics};

#[derive(Debug, Serialize)]
pub struct Report {
    pub generated_at: String,
    pub commit: String,
    pub hardware: String,
    pub dataset: &'static str,
    pub dataset_sha256: &'static str,
    pub mode: &'static str,
    pub questions_scored: usize,
    pub abstention_excluded: usize,
    pub ks: Vec<usize>,
    pub slices: BTreeMap<String, SliceMetrics>,
    pub per_question: Vec<QuestionScore>,
}

pub fn commit_sha() -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into())
}

pub fn hardware() -> String {
    let model = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("model name"))
                .map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string())
        })
        .unwrap_or_else(|| "unknown cpu".into());
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    format!("{model} ({threads} threads)")
}

pub fn to_markdown(r: &Report) -> String {
    let mut md = String::new();
    md.push_str(&format!(
        "# LongMemEval-S retrieval — {}\n\n\
         - commit: `{}`\n- dataset: `{}` (sha256 `{}…`)\n- mode: {}\n- hardware: {}\n\
         - questions scored: {} ({} abstention questions excluded)\n\n",
        r.generated_at,
        r.commit,
        r.dataset,
        &r.dataset_sha256[..16],
        r.mode,
        r.hardware,
        r.questions_scored,
        r.abstention_excluded,
    ));
    md.push_str("| slice | n |");
    for k in &r.ks {
        md.push_str(&format!(" hit@{k} |"));
    }
    for k in &r.ks {
        md.push_str(&format!(" recall@{k} |"));
    }
    md.push_str("\n|---|---|");
    for _ in r.ks.iter().chain(r.ks.iter()) {
        md.push_str("---|");
    }
    md.push('\n');
    for (name, m) in &r.slices {
        md.push_str(&format!("| {name} | {} |", m.questions));
        for k in &r.ks {
            md.push_str(&format!(" {:.3} |", m.hit_at[k]));
        }
        for k in &r.ks {
            md.push_str(&format!(" {:.3} |", m.recall_at[k]));
        }
        md.push('\n');
    }
    md.push_str(
        "\nNotes: hit@k = any evidence session in top k (the \"Recall@k\" most \
         systems publish); recall@k = fraction of evidence sessions found. \
         Session attribution: `sessions/<id>.md` pages and raw observation \
         hits; unattributable pages never score. Capture is production-shaped: \
         excerpts bounded at the 2 KB privacy boundary.\n",
    );
    md
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_carries_provenance_and_all_slices() {
        let mut slices = BTreeMap::new();
        slices.insert(
            "overall".to_string(),
            SliceMetrics {
                questions: 2,
                hit_at: BTreeMap::from([(5, 0.5)]),
                recall_at: BTreeMap::from([(5, 0.25)]),
            },
        );
        let r = Report {
            generated_at: "2026-09-01".into(),
            commit: "abc".into(),
            hardware: "cpu".into(),
            dataset: "longmemeval_s",
            dataset_sha256: crate::retrieval::dataset::LONGMEMEVAL_S_SHA256,
            mode: "zero-llm",
            questions_scored: 2,
            abstention_excluded: 1,
            ks: vec![5],
            slices,
            per_question: vec![],
        };
        let md = to_markdown(&r);
        assert!(md.contains("commit: `abc`"));
        assert!(md.contains("| overall | 2 | 0.500 | 0.250 |"));
        assert!(md.contains("abstention questions excluded"));
    }
}
