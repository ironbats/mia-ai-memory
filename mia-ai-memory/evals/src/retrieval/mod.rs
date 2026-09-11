//! LongMemEval retrieval benchmark, end to end through the real stack.
//!
//! Per question: replay its haystack sessions through `POST /hook/batch`
//! (production hook cadence), query with `memory_query` over MCP, and
//! score session-level hit@k / recall@k against the dataset's evidence
//! labels. See `docs/benchmarks/` for published baselines and
//! `evals/README.md` for how to run.

mod dataset;
mod ingest;
mod query;
mod report;
mod score;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;

use dataset::Question;
use ingest::{project_for, stored_session_uuid};
use server::EvalServer;

mod server;

#[derive(clap::Args, Debug)]
pub struct RetrievalArgs {
    /// Dataset file (LongMemEval-S JSON).
    #[arg(long, default_value = "evals/datasets/longmemeval_s.json")]
    dataset: PathBuf,

    /// Download the dataset first if the file is missing.
    #[arg(long)]
    fetch: bool,

    /// `ai-memory` server binary to benchmark. Build it first:
    /// `cargo build --release -p ai-memory-cli`.
    #[arg(long, default_value = "target/release/ai-memory")]
    server_bin: PathBuf,

    /// Score only the first N questions (deterministic prefix) — smoke
    /// runs and iteration. Omit for the full 500.
    #[arg(long)]
    sample: Option<usize>,

    /// Cutoffs for hit@k / recall@k.
    #[arg(long, value_delimiter = ',', default_values_t = vec![1, 3, 5, 10])]
    ks: Vec<usize>,

    /// Questions ingested+queried concurrently.
    #[arg(long, default_value_t = 8)]
    concurrency: usize,

    /// Output root; a timestamped run dir is created under it.
    #[arg(long, default_value = "evals/runs")]
    out: PathBuf,

    /// Keep the server's temp data dir for post-mortem inspection.
    #[arg(long)]
    keep_data_dir: bool,

    /// Embedding mode: `none` (zero-LLM, the default) or `local`
    /// (in-process all-MiniLM-L6-v2; the model is fetched once into
    /// `evals/models/`, checksum-pinned).
    #[arg(long, default_value = "none")]
    embeddings: String,
}

pub async fn run(args: RetrievalArgs) -> Result<()> {
    // Captured at launch: a long run must not stamp its report with a
    // commit that landed while it was in flight.
    let commit = report::commit_sha();
    if args.fetch && !args.dataset.exists() {
        dataset::fetch(&args.dataset).await?;
    }
    let mut questions = dataset::load(&args.dataset)?;
    let total_loaded = questions.len();
    if let Some(n) = args.sample {
        questions.truncate(n);
    }
    let abstention: Vec<Question> = questions
        .iter()
        .filter(|q| q.is_abstention())
        .cloned()
        .collect();
    questions.retain(|q| !q.is_abstention());
    tracing::info!(
        loaded = total_loaded,
        scored = questions.len(),
        abstention_excluded = abstention.len(),
        "dataset ready"
    );

    if !args.server_bin.exists() {
        bail!(
            "server binary {} not found — run `cargo build --release -p ai-memory-cli` first",
            args.server_bin.display()
        );
    }
    let (embeddings, mode, models_root) = match args.embeddings.as_str() {
        "none" => (server::EvalEmbeddings::None, "zero-llm", None),
        "local" => {
            let root = PathBuf::from("evals/models");
            if !ai_memory_llm::model_present(&root) {
                tracing::info!("fetching the local embedding model into evals/models (~87 MB)");
                ai_memory_llm::fetch_model(&root).await?;
            }
            (
                server::EvalEmbeddings::Local,
                "local-embeddings",
                Some(root),
            )
        }
        other => bail!("--embeddings must be `none` or `local`, got {other}"),
    };
    let server = EvalServer::launch(
        &args.server_bin,
        args.keep_data_dir,
        embeddings,
        models_root.as_deref(),
    )
    .await?;
    tracing::info!(url = server.base_url, data_dir = %server.data_dir_path.display(), "eval server up");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let max_k = args.ks.iter().copied().max().unwrap_or(10);
    let ks = Arc::new(args.ks.clone());
    let base_url = Arc::new(server.base_url.clone());
    let client = Arc::new(client);

    let semaphore = Arc::new(tokio::sync::Semaphore::new(args.concurrency.max(1)));
    let mut tasks = tokio::task::JoinSet::new();
    for q in questions.clone() {
        let permit = semaphore.clone().acquire_owned().await?;
        let (client, base_url, ks) = (client.clone(), base_url.clone(), ks.clone());
        tasks.spawn(async move {
            let _permit = permit;
            let events = ingest::ingest_question(&client, &base_url, &q)
                .await
                .with_context(|| format!("ingesting {}", q.question_id))?;
            let retrieved = query::memory_query(
                &client,
                &base_url,
                ingest::EVAL_WORKSPACE,
                &project_for(&q),
                &q.question,
                max_k,
            )
            .await
            .with_context(|| format!("querying {}", q.question_id))?;
            let evidence: HashSet<uuid::Uuid> = q
                .answer_session_ids
                .iter()
                .map(|s| stored_session_uuid(s))
                .collect();
            let score =
                score::score_question(&q.question_id, &q.question_type, &evidence, &retrieved, &ks);
            tracing::info!(
                question = q.question_id,
                events,
                retrieved = retrieved.len(),
                hit_at_max = score.hit_at.values().next_back().copied().unwrap_or(0.0),
                "scored"
            );
            anyhow::Ok(score)
        });
    }

    // Collect everything before judging: one bad question must not waste
    // the other 499, but a partial run must never masquerade as a
    // publishable number either — any failure aborts before reporting.
    let mut scores = Vec::new();
    let mut failures = Vec::new();
    while let Some(res) = tasks.join_next().await {
        match res.context("task panicked")? {
            Ok(score) => scores.push(score),
            Err(e) => failures.push(format!("{e:#}")),
        }
    }
    if !failures.is_empty() {
        for f in &failures {
            tracing::error!("{f}");
        }
        bail!(
            "{} of {} questions failed; no report written",
            failures.len(),
            failures.len() + scores.len()
        );
    }
    scores.sort_by(|a, b| a.question_id.cmp(&b.question_id));

    let slices = score::aggregate(&scores, &args.ks);
    let stamp: String = Timestamp::now()
        .to_string()
        .chars()
        .map(|c| if c == ':' || c == '.' { '-' } else { c })
        .collect();
    let run_dir = args.out.join(format!("{stamp}-retrieval"));
    std::fs::create_dir_all(&run_dir)?;

    let rep = report::Report {
        generated_at: Timestamp::now().to_string(),
        commit,
        hardware: report::hardware(),
        dataset: "longmemeval_s",
        dataset_sha256: dataset::LONGMEMEVAL_S_SHA256,
        mode,
        questions_scored: scores.len(),
        abstention_excluded: abstention.len(),
        ks: args.ks.clone(),
        slices,
        per_question: scores,
    };
    std::fs::write(
        run_dir.join("report.json"),
        serde_json::to_vec_pretty(&rep)?,
    )?;
    let md = report::to_markdown(&rep);
    std::fs::write(run_dir.join("report.md"), &md)?;
    println!("{md}");
    println!("run dir: {}", run_dir.display());
    Ok(())
}
