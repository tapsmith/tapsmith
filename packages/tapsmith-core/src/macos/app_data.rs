//! The app under test's data on this Mac, found by its bundle ID: cleared
//! between tests, and backed up around a run so the user's own data for the
//! same app comes back afterwards.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// One app's data under one home directory.
pub struct AppData {
    home: PathBuf,
    bundle_id: String,
}

impl AppData {
    /// The bundle ID becomes part of paths that are deleted, so it must be a
    /// plain reverse-DNS name: letters, digits, `-` and single dots, never a
    /// path or `..`.
    pub fn new(home: &Path, bundle_id: &str) -> Result<Self> {
        let well_formed = !bundle_id.is_empty()
            && bundle_id.split('.').all(|part| {
                !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            });
        if !well_formed {
            bail!("{bundle_id:?} is not a bundle ID (expected a name like com.example.app)");
        }
        Ok(Self {
            home: home.to_path_buf(),
            bundle_id: bundle_id.to_string(),
        })
    }

    /// Where the app keeps its data, relative to the home directory. A
    /// sandboxed app keeps all of it in its container's `Data` (never the
    /// container itself: macOS protects that, and rebuilds `Data` on the next
    /// launch); any other app uses the folders named after its bundle ID.
    /// Keychain items and App Group containers are out of reach here.
    fn locations(&self) -> Vec<PathBuf> {
        let id = &self.bundle_id;
        [
            format!("Containers/{id}/Data"),
            format!("Preferences/{id}.plist"),
            format!("Application Support/{id}"),
            format!("Caches/{id}"),
            format!("HTTPStorages/{id}"),
            format!("HTTPStorages/{id}.binarycookies"),
            format!("WebKit/{id}"),
            format!("Saved Application State/{id}.savedState"),
        ]
        .into_iter()
        .map(|rel| Path::new("Library").join(rel))
        .collect()
    }

    /// Delete the app's data. The app must not be running: a running app can
    /// write its in-memory state back afterwards. Links are removed, never
    /// followed: a container's `Data` links to the user's own Desktop,
    /// Downloads and other folders.
    pub fn clear(&self) -> Result<()> {
        for rel in self.locations() {
            remove(&self.home.join(rel))?;
        }
        Ok(())
    }
}

/// Written last into a backup: a backup without it was interrupted.
const MANIFEST: &str = "manifest";

impl AppData {
    /// Clone every place the app keeps data into `backup`, mirroring their
    /// paths, then write the manifest listing them. APFS clones (`cp -c`) cost
    /// almost nothing, and copy links as links.
    pub fn back_up(&self, backup: &Path) -> Result<()> {
        remove(backup)?;
        std::fs::create_dir_all(backup)
            .with_context(|| format!("Failed to create {}", backup.display()))?;
        let mut saved = Vec::new();
        for rel in self.locations() {
            let src = self.home.join(&rel);
            if std::fs::symlink_metadata(&src).is_err() {
                continue;
            }
            clone(&src, &backup.join(&rel))?;
            saved.push(rel.to_string_lossy().into_owned());
        }
        let mut manifest = saved.join("\n");
        manifest.push('\n');
        std::fs::write(backup.join(MANIFEST), manifest)
            .with_context(|| format!("Failed to write the manifest in {}", backup.display()))
    }

    /// Put the app's data back as `backup` holds it: clear what the run left,
    /// clone the backed-up places back, then delete the backup.
    pub fn restore(&self, backup: &Path) -> Result<()> {
        let manifest = std::fs::read_to_string(backup.join(MANIFEST))
            .with_context(|| format!("{} is not a complete backup", backup.display()))?;
        self.clear()?;
        for rel in manifest.lines().filter(|l| !l.is_empty()) {
            clone(&backup.join(rel), &self.home.join(rel))?;
        }
        remove(backup)
    }
}

/// Where a run's backups are kept, one folder per bundle ID.
pub fn backup_root(home: &Path) -> PathBuf {
    home.join(".tapsmith").join("macos-app-data")
}

/// Restore every complete backup under `root` (a run that ended without
/// restoring: killed, or crashed) and drop the incomplete ones, whose apps
/// were never cleared. Returns the bundle IDs restored, sorted.
pub fn restore_leftovers(home: &Path, root: &Path) -> Result<Vec<String>> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("Failed to read {}", root.display())),
    };
    let mut restored = Vec::new();
    for entry in entries {
        let dir = entry?.path();
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Ok(app) = AppData::new(home, &name) else {
            continue; // Not one of ours: never delete what we cannot name.
        };
        if dir.join(MANIFEST).is_file() {
            app.restore(&dir)?;
            restored.push(name);
        } else {
            remove(&dir)?;
        }
    }
    restored.sort();
    Ok(restored)
}

// ─── A run's backups ───

/// This daemon has backed up an app: every backup under the root is this
/// run's, to restore when it ends.
static RUN_OWNS_BACKUPS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn home() -> Result<PathBuf> {
    dirs::home_dir().context("No home directory: cannot find the app's data")
}

/// Before the agent launches the app (which must not be running): restore
/// what a run that never finished left behind, once per daemon, then back
/// this app's data up unless this run already has. Returns the bundle IDs
/// restored from leftovers.
pub async fn prepare_run(bundle_id: &str) -> Result<Vec<String>> {
    static LEFTOVERS_RESTORED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    let home = home()?;
    let app = AppData::new(&home, bundle_id)?;
    let root = backup_root(&home);
    let mut restored = Vec::new();
    LEFTOVERS_RESTORED
        .get_or_try_init(|| async {
            let (home, root) = (home.clone(), root.clone());
            restored =
                tokio::task::spawn_blocking(move || restore_leftovers(&home, &root)).await??;
            anyhow::Ok(())
        })
        .await?;
    let backup = root.join(bundle_id);
    if !backup.join(MANIFEST).is_file() {
        tokio::task::spawn_blocking(move || app.back_up(&backup)).await??;
    }
    RUN_OWNS_BACKUPS.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(restored)
}

/// Clear the app's data (it must not be running). Refused unless this run
/// holds a backup of it: the user's data is never cleared unrecoverably.
pub async fn clear_backed_up(bundle_id: &str) -> Result<()> {
    let home = home()?;
    let app = AppData::new(&home, bundle_id)?;
    if !backup_root(&home).join(bundle_id).join(MANIFEST).is_file() {
        bail!("{bundle_id}'s data has no backup from this run, so it was not cleared");
    }
    tokio::task::spawn_blocking(move || app.clear()).await?
}

/// When the run ends (the app must not be running): restore every app this
/// run backed up. Returns their bundle IDs; none if this run backed up none.
pub async fn finish_run() -> Result<Vec<String>> {
    if !RUN_OWNS_BACKUPS.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return Ok(Vec::new());
    }
    let home = home()?;
    tokio::task::spawn_blocking(move || restore_leftovers(&home, &backup_root(&home))).await?
}

/// `cp -c -R`: an APFS clone where possible, links copied as links.
fn clone(src: &Path, dst: &Path) -> Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    let output = std::process::Command::new("cp")
        .args(["-c", "-R"])
        .arg(src)
        .arg(dst)
        .output()
        .context("Failed to run cp")?;
    if !output.status.success() {
        bail!(
            "Failed to copy {} to {}: {}",
            src.display(),
            dst.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// Remove a file, link or folder; nothing there is fine. `remove_dir_all`
/// removes links inside the folder without following them.
fn remove(path: &Path) -> Result<()> {
    let removed = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
    };
    removed.with_context(|| format!("Failed to remove {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_bundle_id_that_could_escape_its_folder() {
        for bad in [
            "",
            "..",
            ".",
            "a/b",
            "../x",
            "com..example",
            ".hidden",
            "a b",
        ] {
            assert!(AppData::new(Path::new("/h"), bad).is_err(), "{bad:?}");
        }
        assert!(AppData::new(Path::new("/h"), "dev.tapsmith.mactestapp").is_ok());
        assert!(AppData::new(Path::new("/h"), "com.example.My-App2").is_ok());
    }

    const ID: &str = "com.example.app";

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// A home holding the app's data in every place it can live, a link from
    /// its container into the user's Desktop (as macOS makes), and another
    /// app's data.
    fn populated_home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let lib = h.join("Library");
        write(&h.join("Desktop/notes.txt"), "the user's file");
        let container = lib.join("Containers").join(ID);
        write(
            &container.join(".com.apple.containermanagerd.metadata.plist"),
            "meta",
        );
        let data = container.join("Data");
        write(
            &data.join("Library/Preferences").join(format!("{ID}.plist")),
            "saved",
        );
        std::os::unix::fs::symlink("../../../../Desktop", data.join("Desktop")).unwrap();
        write(
            &lib.join("Preferences").join(format!("{ID}.plist")),
            "prefs",
        );
        write(
            &lib.join("Application Support").join(ID).join("db.sqlite"),
            "db",
        );
        write(&lib.join("Caches").join(ID).join("c"), "cache");
        write(&lib.join("HTTPStorages").join(ID).join("h"), "http");
        write(&lib.join("WebKit").join(ID).join("w"), "web");
        write(
            &lib.join("Saved Application State")
                .join(format!("{ID}.savedState"))
                .join("s"),
            "state",
        );
        write(
            &lib.join("Preferences/com.example.other.plist"),
            "another app",
        );
        write(
            &lib.join("Containers/com.example.other/Data/x"),
            "another app",
        );
        home
    }

    #[test]
    fn clear_removes_only_this_apps_data_and_never_follows_links() {
        let home = populated_home();
        let h = home.path();
        let lib = h.join("Library");

        AppData::new(h, ID).unwrap().clear().unwrap();

        let container = lib.join("Containers").join(ID);
        assert!(
            !container.join("Data").exists(),
            "the container's Data is cleared"
        );
        for gone in [
            format!("Preferences/{ID}.plist"),
            format!("Application Support/{ID}"),
            format!("Caches/{ID}"),
            format!("HTTPStorages/{ID}"),
            format!("WebKit/{ID}"),
            format!("Saved Application State/{ID}.savedState"),
        ] {
            assert!(!lib.join(&gone).exists(), "{gone} is cleared");
        }
        // The link into the user's Desktop went, never what it points at.
        assert_eq!(
            std::fs::read_to_string(h.join("Desktop/notes.txt")).unwrap(),
            "the user's file"
        );
        // macOS protects the container itself and rebuilds Data on launch.
        assert!(container
            .join(".com.apple.containermanagerd.metadata.plist")
            .exists());
        assert!(lib.join("Preferences/com.example.other.plist").exists());
        assert!(lib.join("Containers/com.example.other/Data/x").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn restore_puts_back_exactly_what_was_backed_up() {
        let home = populated_home();
        let h = home.path();
        let lib = h.join("Library");
        let backup = tempfile::tempdir().unwrap();
        let backup_dir = backup.path().join(ID);
        let app = AppData::new(h, ID).unwrap();

        app.back_up(&backup_dir).unwrap();
        // The run clears and the tests write their own data.
        app.clear().unwrap();
        write(
            &lib.join("Preferences").join(format!("{ID}.plist")),
            "written by a test",
        );
        app.restore(&backup_dir).unwrap();

        let data = lib.join("Containers").join(ID).join("Data");
        assert_eq!(
            std::fs::read_to_string(data.join("Library/Preferences").join(format!("{ID}.plist")))
                .unwrap(),
            "saved"
        );
        assert_eq!(
            std::fs::read_link(data.join("Desktop")).unwrap(),
            Path::new("../../../../Desktop")
        );
        assert_eq!(
            std::fs::read_to_string(lib.join("Preferences").join(format!("{ID}.plist"))).unwrap(),
            "prefs"
        );
        assert_eq!(
            std::fs::read_to_string(lib.join("Application Support").join(ID).join("db.sqlite"))
                .unwrap(),
            "db"
        );
        assert_eq!(
            std::fs::read_to_string(h.join("Desktop/notes.txt")).unwrap(),
            "the user's file"
        );
        assert!(!backup_dir.exists(), "a restored backup is deleted");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn restoring_an_app_that_had_no_data_leaves_none() {
        let home = tempfile::tempdir().unwrap();
        let backup = tempfile::tempdir().unwrap();
        let backup_dir = backup.path().join(ID);
        let app = AppData::new(home.path(), ID).unwrap();

        app.back_up(&backup_dir).unwrap();
        let written = home
            .path()
            .join("Library/Preferences")
            .join(format!("{ID}.plist"));
        write(&written, "written by a test");
        app.restore(&backup_dir).unwrap();

        assert!(!written.exists());
        assert!(!backup_dir.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn leftovers_from_a_killed_run_are_restored_and_half_backups_dropped() {
        let home = populated_home();
        let lib = home.path().join("Library");
        let root = tempfile::tempdir().unwrap();
        // A run that was killed after backing up and clearing this app.
        let app = AppData::new(home.path(), ID).unwrap();
        app.back_up(&root.path().join(ID)).unwrap();
        app.clear().unwrap();
        // A run killed while backing up another app: no manifest, and that
        // app's data was never touched.
        std::fs::create_dir_all(root.path().join("com.example.other/Library")).unwrap();

        let restored = restore_leftovers(home.path(), root.path()).unwrap();

        assert_eq!(restored, vec![ID.to_string()]);
        assert_eq!(
            std::fs::read_to_string(lib.join("Preferences").join(format!("{ID}.plist"))).unwrap(),
            "prefs"
        );
        assert!(lib.join("Preferences/com.example.other.plist").exists());
        assert!(
            std::fs::read_dir(root.path()).unwrap().next().is_none(),
            "no backups are left"
        );
    }

    #[test]
    fn clear_with_no_data_is_not_an_error() {
        let home = tempfile::tempdir().unwrap();
        AppData::new(home.path(), ID).unwrap().clear().unwrap();
    }
}
