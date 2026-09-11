//! Spawn and supervise a real `ai-memory serve` subprocess for the
//! benchmark. The whole point of the harness is to measure the shipped
//! stack, so nothing here reaches into crates directly: the server is
//! the same binary a user runs, configured for deterministic zero-LLM
//! operation (no consolidation LLM, no embedder, no reranker).

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

/// Fixed bearer for the eval server (ephemeral data dir, loopback bind).
pub const EVAL_AUTH_TOKEN: &str = "ai-memory-eval-token";

pub struct EvalServer {
    child: Child,
    pub base_url: String,
    /// Kept for the lifetime of the server unless --keep-data-dir moved it.
    _data_dir: Option<tempfile::TempDir>,
    pub data_dir_path: PathBuf,
}

/// Which embedding configuration the eval server runs with.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EvalEmbeddings {
    /// Deterministic zero-LLM mode: no embedder at all.
    None,
    /// In-process local embeddings (all-MiniLM-L6-v2). The model files
    /// must already sit in the given models root; the harness seeds the
    /// server's data dir from there so the server never fetches.
    Local,
}

impl EvalServer {
    /// Launch `server_bin` on a free loopback port with a fresh data dir.
    pub async fn launch(
        server_bin: &PathBuf,
        keep_data_dir: bool,
        embeddings: EvalEmbeddings,
        models_root: Option<&std::path::Path>,
    ) -> Result<Self> {
        let tmp = tempfile::Builder::new()
            .prefix("ai-memory-eval-")
            .tempdir()
            .context("creating eval data dir")?;
        let data_dir_path = tmp.path().to_path_buf();

        // Reserve a free port; the tiny close-to-bind window is fine for a
        // local benchmark run.
        let port = {
            let l = TcpListener::bind("127.0.0.1:0")?;
            l.local_addr()?.port()
        };
        let bind = format!("127.0.0.1:{port}");

        if embeddings == EvalEmbeddings::Local {
            let src = models_root
                .ok_or_else(|| anyhow::anyhow!("local embeddings need a models root"))?
                .join("all-MiniLM-L6-v2");
            let dest = data_dir_path.join("models/all-MiniLM-L6-v2");
            std::fs::create_dir_all(&dest)?;
            for entry in std::fs::read_dir(&src).context("reading model dir")? {
                let entry = entry?;
                std::fs::copy(entry.path(), dest.join(entry.file_name()))?;
            }
        }
        let mut cmd = Command::new(server_bin);
        cmd.args([
            "serve",
            "--transport",
            "http",
            "--bind",
            &bind,
            "--data-dir",
        ])
        .arg(&data_dir_path)
        .env("AI_MEMORY_AUTH_TOKEN", EVAL_AUTH_TOKEN)
        .env("AI_MEMORY_CAPTURE_ASSISTANT", "true")
        // No chat LLM and no reranker in either mode; the embedding env
        // selects the one nondefault stream under test.
        .env_remove("AI_MEMORY_LLM_PROVIDER")
        .env_remove("AI_MEMORY_RERANKER")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("LLM_API_KEY");
        match embeddings {
            EvalEmbeddings::None => {
                // Explicit: with 2.0's default-on local embeddings, an
                // UNSET provider would start a background model download
                // per spawned server. The baseline must be hermetic.
                cmd.env("AI_MEMORY_EMBEDDING_PROVIDER", "none");
            }
            EvalEmbeddings::Local => {
                cmd.env("AI_MEMORY_EMBEDDING_PROVIDER", "local");
            }
        }
        let child = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("spawning {} serve", server_bin.display()))?;

        let base_url = format!("http://{bind}");
        let (guard, data_dir_path) = if keep_data_dir {
            // Persist the tempdir so it survives the run for inspection.
            (None, tmp.keep())
        } else {
            (Some(tmp), data_dir_path)
        };
        let mut server = Self {
            child,
            base_url,
            _data_dir: guard,
            data_dir_path,
        };
        server.wait_ready().await?;
        Ok(server)
    }

    /// Poll until the HTTP surface answers (any status counts as up).
    async fn wait_ready(&mut self) -> Result<()> {
        let client = reqwest::Client::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(status) = self.child.try_wait()? {
                let mut err = String::new();
                if let Some(mut stderr) = self.child.stderr.take() {
                    use std::io::Read as _;
                    let _ = stderr.read_to_string(&mut err);
                }
                bail!("eval server exited during startup ({status}): {err}");
            }
            if client
                .get(format!("{}/", self.base_url))
                .timeout(Duration::from_secs(1))
                .send()
                .await
                .is_ok()
            {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!(
                    "eval server did not answer on {} within 120s",
                    self.base_url
                );
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

impl Drop for EvalServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
