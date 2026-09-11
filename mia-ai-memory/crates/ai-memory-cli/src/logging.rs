//! Structured tracing setup.
//!
//! `RUST_LOG` honoured first; otherwise we fall back to the configured
//! [`Config::log_level`]. The appender's own module is forced to `warn` to
//! avoid the feedback loop that filled 137 GB of disk for agentmemory #519.
//!
//! File logging degrades, commands don't (issue #158): sandboxes like
//! ai-jail mount `$HOME` read-only, and the log *directory* often already
//! exists from pre-sandbox use — so directory creation succeeds and only
//! the log-file create fails. The appender is therefore built through the
//! non-panicking builder with a fallback chain (`<data_dir>/logs` → the OS
//! temp dir → stderr-only), each miss naming the exact path that failed so
//! the operator knows what to `--rw-map`.
//!
//! [`Config::log_level`]: crate::config::Config::log_level

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::config::Config;

/// Try to build a daily-rolling appender in `dir`. `None` when the log file
/// cannot be created there (read-only filesystem, permissions, …) — the
/// builder API reports that as an error where `RollingFileAppender::new`
/// would panic (the exact failure in issue #158).
fn try_appender(dir: &Path) -> Option<RollingFileAppender> {
    if fs::create_dir_all(dir).is_err() {
        return None;
    }
    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("ai-memory.log")
        .build(dir)
        .ok()
}

/// Whether log-location degradation is reported on stderr.
///
/// `Loud` is for the long-running server, where an operator genuinely wants
/// to know persistent logs ended up somewhere else (issue #158). `Quiet` is
/// for one-shot client commands (`rename-project`, `status`, …): they run
/// for milliseconds, nobody reads their file logs, and the warning reads
/// like something went wrong with the command itself — a real user took the
/// sandbox hint as a claim about *their* environment when it was only the
/// Docker thin-client wrapper's read-only view (#188-era report).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DegradeWarnings {
    Loud,
    Quiet,
}

/// Resolve the file appender through the fallback chain, collecting a
/// human-readable notice for each degradation step (printed by `init` only
/// in [`DegradeWarnings::Loud`] mode). Returns `None` as the appender when
/// no location is writable — the caller then runs stderr-only.
fn resolve_file_appender(
    log_dir: &Path,
    temp_dir: &Path,
) -> (Option<(RollingFileAppender, PathBuf)>, Vec<String>) {
    let mut notices = Vec::new();
    if let Some(appender) = try_appender(log_dir) {
        return (Some((appender, log_dir.to_path_buf())), notices);
    }
    notices.push(format!(
        "ai-memory: file logging for this run goes to {} — the configured \
         log dir {} is not writable (read-only mount or missing \
         permissions). If you expected persistent logs there, make the data \
         dir writable; in a sandbox (e.g. ai-jail): --rw-map <data-dir>",
        temp_dir.display(),
        log_dir.display(),
    ));
    if let Some(appender) = try_appender(temp_dir) {
        return (Some((appender, temp_dir.to_path_buf())), notices);
    }
    notices.push(format!(
        "ai-memory: cannot write log files under {} either; continuing with \
         stderr-only logging",
        temp_dir.display(),
    ));
    (None, notices)
}

/// Initialise the global tracing subscriber.
///
/// Returns a guard whose drop flushes any pending log lines; `None` when no
/// writable log location exists and logging is stderr-only. Keep the guard
/// alive for the duration of `main()`.
///
/// # Errors
/// Currently infallible (kept fallible for future subscriber options); log
/// I/O problems degrade instead of erroring so a read-only filesystem can
/// never take down a command that would otherwise succeed.
pub fn init(config: &Config, warnings: DegradeWarnings) -> Result<Option<WorkerGuard>> {
    let log_dir = config.data_dir.join("logs");
    let (file, notices) = resolve_file_appender(&log_dir, &std::env::temp_dir());
    if warnings == DegradeWarnings::Loud {
        for notice in &notices {
            eprintln!("{notice}");
        }
    }

    let default_filter = format!("{},tracing_appender=warn", config.log_level);
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_writer(std::io::stderr);

    let registry = tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer);

    match file {
        Some((appender, _dir)) => {
            let (file_writer, guard) = tracing_appender::non_blocking(appender);
            let file_layer = tracing_subscriber::fmt::layer()
                .with_target(true)
                .with_ansi(false)
                .with_writer(file_writer);
            registry.with(file_layer).init();
            Ok(Some(guard))
        }
        None => {
            registry.init();
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Issue #158: the log directory EXISTS but the filesystem is read-only —
    // dir creation "succeeds", file creation fails. The old code panicked
    // here (RollingFileAppender::new); the chain must fall through to the
    // temp dir instead.
    #[cfg(unix)]
    #[test]
    fn readonly_log_dir_falls_back_to_temp_dir() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let log_dir = tmp.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::set_permissions(&log_dir, fs::Permissions::from_mode(0o555)).unwrap();
        let temp = tempfile::tempdir().unwrap();

        let (resolved, notices) = resolve_file_appender(&log_dir, temp.path());

        let (_appender, used) = resolved.expect("must degrade to the temp dir, not panic");
        assert_eq!(used, temp.path());
        assert_eq!(notices.len(), 1, "one degradation step, one notice");
        assert!(
            notices[0].contains(&log_dir.display().to_string()),
            "the notice names the unwritable dir: {}",
            notices[0]
        );
        // Restore permissions so the tempdir cleanup can delete it.
        fs::set_permissions(&log_dir, fs::Permissions::from_mode(0o755)).unwrap();
    }

    // Both locations unwritable: stderr-only, still no panic.
    #[cfg(unix)]
    #[test]
    fn fully_readonly_environment_degrades_to_stderr_only() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ro = |name: &str| {
            let dir = tmp.path().join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
            dir
        };
        let log_dir = ro("logs");
        let temp_dir = ro("temp");

        let (resolved, notices) = resolve_file_appender(&log_dir, &temp_dir);
        assert!(resolved.is_none());
        assert_eq!(notices.len(), 2, "both degradation steps produce notices");

        for dir in [log_dir, temp_dir] {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn writable_log_dir_is_used_directly() {
        let tmp = tempfile::tempdir().unwrap();
        let log_dir = tmp.path().join("logs");
        let temp = tempfile::tempdir().unwrap();

        let (resolved, notices) = resolve_file_appender(&log_dir, temp.path());
        let (_appender, used) = resolved.expect("writable dir must work");
        assert_eq!(used, log_dir);
        assert!(notices.is_empty(), "no degradation, no notices");
        assert!(log_dir.is_dir(), "the chain creates the directory itself");
    }
}
