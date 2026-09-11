//! On-demand end-to-end smoke for the retrieval harness (mirrors the
//! `writer_throughput` pattern: `#[ignore]`d, run deliberately).
//!
//! Requirements, both intentionally not provisioned by the test:
//! - `target/release/ai-memory` (`cargo build --release -p ai-memory-cli`)
//! - `evals/datasets/longmemeval_s.json` (run once with `--fetch`)
//!
//! ```bash
//! cargo test -p ai-memory-eval --test smoke -- --ignored
//! ```

use std::path::PathBuf;
use std::process::Command;

#[test]
#[ignore = "needs the release server binary and the downloaded dataset"]
fn the_harness_scores_a_tiny_sample_end_to_end() {
    let repo_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let server_bin = repo_root.join("target/release/ai-memory");
    assert!(
        server_bin.exists(),
        "build the server first: cargo build --release -p ai-memory-cli"
    );
    let dataset = repo_root.join("evals/datasets/longmemeval_s.json");
    assert!(
        dataset.exists(),
        "fetch the dataset first: cargo run -p ai-memory-eval -- retrieval --fetch --sample 1"
    );

    let out = tempfile::tempdir().unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_ai-memory-eval"))
        .current_dir(&repo_root)
        .args(["retrieval", "--sample", "2", "--concurrency", "2"])
        .arg("--server-bin")
        .arg(&server_bin)
        .arg("--out")
        .arg(out.path())
        .status()
        .unwrap();
    assert!(status.success(), "harness exited non-zero");

    // Exactly one run dir with a structurally complete report.
    let run_dir = std::fs::read_dir(out.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.is_dir())
        .expect("run dir created");
    let report: serde_json::Value =
        serde_json::from_slice(&std::fs::read(run_dir.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["questions_scored"], 2);
    assert_eq!(report["mode"], "zero-llm");
    assert!(report["slices"]["overall"]["hit_at"]["5"].is_number());
    // Provenance that makes a published number auditable.
    assert!(report["commit"].as_str().unwrap().len() >= 7);
    assert!(
        report["dataset_sha256"]
            .as_str()
            .unwrap()
            .starts_with("08d8dad4")
    );
    assert!(run_dir.join("report.md").exists());
}
