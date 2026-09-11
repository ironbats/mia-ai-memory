//! Client-local checkout links for project-first managed launches.
//!
//! Server project rows intentionally do not expose `repo_path`: that path
//! belongs to the server host and can disclose private filesystem layout. A
//! client records the checkout it successfully used, keyed by the normalized
//! server identity plus `(workspace, project)`, so two machines may map the
//! same remote scope to different local directories.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use fs2::FileExt as _;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::http_client::ServerEndpoint;

const REGISTRY_VERSION: u32 = 1;
const MAX_REGISTRY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINKS: usize = 10_000;
const REGISTRY_FILE: &str = "client-projects.json";
const REGISTRY_LOCK_FILE: &str = "client-projects.lock";

/// One server-scoped local checkout link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ProjectLink {
    /// Normalized server origin and mount path, without credentials.
    pub(super) server: String,
    /// Remote workspace name.
    pub(super) workspace: String,
    /// Remote project name.
    pub(super) project: String,
    /// Canonical absolute path on this client.
    pub(super) path: PathBuf,
    /// Last successful managed prepare that refreshed this link.
    pub(super) linked_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProjectRegistry {
    version: u32,
    links: Vec<ProjectLink>,
}

impl Default for ProjectRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            links: Vec::new(),
        }
    }
}

/// Return links belonging to the configured server.
pub(super) fn links_for_server(
    config: &Config,
    endpoint: &ServerEndpoint,
) -> Result<Vec<ProjectLink>> {
    let server = endpoint.identity();
    Ok(load_registry(&registry_path(config))?
        .links
        .into_iter()
        .filter(|link| link.server == server)
        .collect())
}

/// Record the checkout only after the server accepted a managed run prepare.
///
/// The path is canonicalized before persistence. A later picker rejects a
/// path whose canonical form has changed, which catches a removed checkout
/// replaced by a symlink before any harness is launched.
pub(super) fn record_prepared_checkout(
    config: &Config,
    endpoint: &ServerEndpoint,
    workspace: &str,
    project: &str,
    path: &Path,
) -> Result<()> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("canonicalizing checkout {}", path.display()))?;
    if !canonical.is_dir() {
        bail!("checkout is not a directory: {}", canonical.display());
    }
    let server = endpoint.identity();
    update_registry(config, |registry| {
        registry.links.retain(|link| {
            !(link.server == server && link.workspace == workspace && link.project == project)
        });
        registry.links.push(ProjectLink {
            server,
            workspace: workspace.to_owned(),
            project: project.to_owned(),
            path: canonical,
            linked_at: jiff::Timestamp::now().to_string(),
        });
        Ok(true)
    })
}

/// Move a local link after a successful server-side project rename or move.
///
/// If the destination already has a link, it wins. That is the safe behavior
/// for a copy-and-purge merge into an existing project: the destination's
/// established checkout must not be silently replaced by the source path.
pub(super) fn rekey_scope(
    config: &Config,
    endpoint: &ServerEndpoint,
    from_workspace: &str,
    from_project: &str,
    to_workspace: &str,
    to_project: &str,
) -> Result<()> {
    let server = endpoint.identity();
    update_registry(config, |registry| {
        let Some(source_index) = registry.links.iter().position(|link| {
            link.server == server
                && link.workspace == from_workspace
                && link.project == from_project
        }) else {
            return Ok(false);
        };
        let mut source = registry.links.remove(source_index);
        let destination_exists = registry.links.iter().any(|link| {
            link.server == server && link.workspace == to_workspace && link.project == to_project
        });
        if !destination_exists {
            source.workspace = to_workspace.to_owned();
            source.project = to_project.to_owned();
            registry.links.push(source);
        }
        Ok(true)
    })
}

fn registry_path(config: &Config) -> PathBuf {
    config.data_dir.join(REGISTRY_FILE)
}

fn lock_path(config: &Config) -> PathBuf {
    config.data_dir.join(REGISTRY_LOCK_FILE)
}

fn update_registry(
    config: &Config,
    mutate: impl FnOnce(&mut ProjectRegistry) -> Result<bool>,
) -> Result<()> {
    fs::create_dir_all(&config.data_dir).with_context(|| {
        format!(
            "creating client data directory {}",
            config.data_dir.display()
        )
    })?;
    let lock = open_private_lock(&lock_path(config))?;
    lock.lock_exclusive()
        .context("locking client project registry")?;

    let path = registry_path(config);
    let mut registry = load_registry(&path)?;
    if mutate(&mut registry)? {
        if registry.links.len() > MAX_LINKS {
            bail!("client project registry exceeds {MAX_LINKS} links");
        }
        let mut rendered =
            serde_json::to_vec_pretty(&registry).context("serializing client project registry")?;
        rendered.push(b'\n');
        refuse_symlink(&path)?;
        ai_memory_wiki::write_atomic(&path, &rendered)
            .with_context(|| format!("writing client project registry {}", path.display()))?;
        make_private(&path)?;
    }
    Ok(())
}

fn load_registry(path: &Path) -> Result<ProjectRegistry> {
    refuse_symlink(path)?;
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProjectRegistry::default());
        }
        Err(error) => return Err(error).with_context(|| format!("inspecting {}", path.display())),
    };
    if metadata.len() > MAX_REGISTRY_BYTES {
        bail!(
            "client project registry {} exceeds the {} byte limit",
            path.display(),
            MAX_REGISTRY_BYTES
        );
    }
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let registry: ProjectRegistry = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "parsing {}; refusing to overwrite malformed client state",
            path.display()
        )
    })?;
    if registry.version != REGISTRY_VERSION {
        bail!(
            "unsupported client project registry version {} in {} (expected {})",
            registry.version,
            path.display(),
            REGISTRY_VERSION
        );
    }
    if registry.links.len() > MAX_LINKS {
        bail!("client project registry exceeds {MAX_LINKS} links");
    }
    let mut keys = HashSet::with_capacity(registry.links.len());
    for link in &registry.links {
        if !keys.insert((&link.server, &link.workspace, &link.project)) {
            bail!(
                "duplicate client project registry key for {}/{}/{} in {}",
                link.server,
                link.workspace,
                link.project,
                path.display()
            );
        }
    }
    Ok(registry)
}

fn open_private_lock(path: &Path) -> Result<File> {
    refuse_symlink(path)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
        .open(path)
        .with_context(|| format!("opening client project registry lock {}", path.display()))
}

fn refuse_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!(
                "refusing client project registry symlink {}",
                path.display()
            )
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspecting {}", path.display())),
    }
}

#[cfg(unix)]
fn make_private(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("restricting permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn make_private(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_at(path: &Path) -> Config {
        Config {
            data_dir: path.to_path_buf(),
            ..Config::default()
        }
    }

    fn endpoint(url: &str) -> ServerEndpoint {
        ServerEndpoint::from_pair(Some(url.to_owned()), None)
    }

    #[test]
    fn links_are_isolated_by_server_and_scope() {
        let tmp = tempfile::TempDir::new().unwrap();
        let checkout = tmp.path().join("checkout");
        fs::create_dir(&checkout).unwrap();
        let config = config_at(&tmp.path().join("data"));
        let first = endpoint("http://memory-one:49374/root/");
        let second = endpoint("http://memory-two:49374");

        record_prepared_checkout(&config, &first, "default", "app", &checkout).unwrap();

        let links = links_for_server(&config, &first).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].path, checkout.canonicalize().unwrap());
        assert!(links_for_server(&config, &second).unwrap().is_empty());
    }

    #[test]
    fn recording_the_same_key_replaces_only_that_link() {
        let tmp = tempfile::TempDir::new().unwrap();
        let first_path = tmp.path().join("first");
        let second_path = tmp.path().join("second");
        let other_path = tmp.path().join("other");
        for path in [&first_path, &second_path, &other_path] {
            fs::create_dir(path).unwrap();
        }
        let config = config_at(&tmp.path().join("data"));
        let endpoint = endpoint("http://memory:49374");

        record_prepared_checkout(&config, &endpoint, "default", "app", &first_path).unwrap();
        record_prepared_checkout(&config, &endpoint, "default", "other", &other_path).unwrap();
        record_prepared_checkout(&config, &endpoint, "default", "app", &second_path).unwrap();

        let links = links_for_server(&config, &endpoint).unwrap();
        assert_eq!(links.len(), 2);
        assert!(links.iter().any(|link| {
            link.project == "app" && link.path == second_path.canonicalize().unwrap()
        }));
        assert!(links.iter().any(|link| link.project == "other"));
    }

    #[test]
    fn malformed_registry_is_not_overwritten() {
        let tmp = tempfile::TempDir::new().unwrap();
        let data = tmp.path().join("data");
        let checkout = tmp.path().join("checkout");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir(&checkout).unwrap();
        let path = data.join(REGISTRY_FILE);
        fs::write(&path, b"not json").unwrap();
        let config = config_at(&data);

        assert!(
            record_prepared_checkout(
                &config,
                &endpoint("http://memory:49374"),
                "default",
                "app",
                &checkout,
            )
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), b"not json");
    }

    #[test]
    fn duplicate_scope_keys_are_rejected_without_overwriting() {
        let tmp = tempfile::TempDir::new().unwrap();
        let data = tmp.path().join("data");
        let checkout = tmp.path().join("checkout");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir(&checkout).unwrap();
        let path = data.join(REGISTRY_FILE);
        let duplicate = br#"{
  "version": 1,
  "links": [
    {"server":"http://memory:49374","workspace":"default","project":"app","path":"/one","linked_at":"2026-01-01T00:00:00Z"},
    {"server":"http://memory:49374","workspace":"default","project":"app","path":"/two","linked_at":"2026-01-02T00:00:00Z"}
  ]
}
"#;
        fs::write(&path, duplicate).unwrap();
        let config = config_at(&data);

        assert!(links_for_server(&config, &endpoint("http://memory:49374")).is_err());
        assert!(
            record_prepared_checkout(
                &config,
                &endpoint("http://memory:49374"),
                "default",
                "app",
                &checkout,
            )
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), duplicate);
    }

    #[test]
    fn rekey_preserves_an_existing_destination_link() {
        let tmp = tempfile::TempDir::new().unwrap();
        let source = tmp.path().join("source");
        let destination = tmp.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        let config = config_at(&tmp.path().join("data"));
        let endpoint = endpoint("http://memory:49374");
        record_prepared_checkout(&config, &endpoint, "from", "app", &source).unwrap();
        record_prepared_checkout(&config, &endpoint, "to", "app", &destination).unwrap();

        rekey_scope(&config, &endpoint, "from", "app", "to", "app").unwrap();

        let links = links_for_server(&config, &endpoint).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].path, destination.canonicalize().unwrap());
    }

    #[test]
    fn rekey_preserves_the_source_link_timestamp() {
        let tmp = tempfile::TempDir::new().unwrap();
        let source = tmp.path().join("source");
        fs::create_dir(&source).unwrap();
        let config = config_at(&tmp.path().join("data"));
        let endpoint = endpoint("http://memory:49374");
        record_prepared_checkout(&config, &endpoint, "from", "app", &source).unwrap();
        let original_linked_at = "2025-01-02T03:04:05Z";
        update_registry(&config, |registry| {
            registry.links[0].linked_at = original_linked_at.to_owned();
            Ok(true)
        })
        .unwrap();

        rekey_scope(&config, &endpoint, "from", "app", "to", "renamed").unwrap();

        let links = links_for_server(&config, &endpoint).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].workspace, "to");
        assert_eq!(links[0].project, "renamed");
        assert_eq!(links[0].linked_at, original_linked_at);
    }
}
