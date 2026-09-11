//! `ai-memory backup --to <tarball>` — POST to the server's
//! `/admin/backup` endpoint and save the returned gzip tarball.
//!
//! The server uses SQLite's online backup API so the live DB is never
//! raced. This client streams the response to the caller-supplied path.

use anyhow::{Context, Result};
use tracing::info;

use crate::cli::BackupArgs;
use crate::config::Config;
use crate::http_client::{ServerEndpoint, post_to_file};

/// Run the `backup` subcommand.
///
/// # Errors
/// Returns an error if the POST to `/admin/backup` fails, the server
/// returns a non-2xx status, or the output file cannot be written.
pub async fn run(config: &Config, args: BackupArgs) -> Result<()> {
    let endpoint = ServerEndpoint::from_config_resolving_auth(config).await;
    let dest = &args.to;
    if let Some(parent) = dest.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating parent dir for {}", dest.display()))?;
    }
    let size = post_to_file(&endpoint, "/admin/backup", dest)
        .await
        .context("requesting backup from server")?;

    info!(path = %dest.display(), bytes = size, "backup written");
    println!(
        "✓ wrote backup to {} ({})",
        dest.display(),
        human_bytes(size)
    );
    Ok(())
}

fn human_bytes(n: u64) -> String {
    const UNITS: &[&str] = &["B", "KiB", "MiB", "GiB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} {}", UNITS[0])
    } else {
        format!("{value:.2} {}", UNITS[unit])
    }
}
