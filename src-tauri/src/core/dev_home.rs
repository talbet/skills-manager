//! A stand-in home directory for development builds.
//!
//! A dev build otherwise reads and writes the same places the installed app
//! does: the library in `~/.skills-manager`, the repo config, and every agent's
//! skills directory. Branch code run from a worktree would migrate the real
//! database (which then refuses to open in an older build), sync into the real
//! `~/.claude/skills`, and push to the real backup remote.
//!
//! Setting [`ENV_VAR`] to an absolute path makes a debug build treat that
//! directory as the home directory for all of those lookups. Release builds
//! ignore it, so a stray variable can never relocate a user's library, and
//! tests ignore it so they stay hermetic. `scripts/tauri-dev.mjs` sets it by
//! default.
//!
//! Deliberately not covered: the OS keychain, the Downloads folder, git's own
//! config, and log redaction (which should keep hiding the real home path).

use std::path::PathBuf;

pub const ENV_VAR: &str = "SKILLS_MANAGER_DEV_HOME";

/// The sandbox home, when one is active.
pub fn sandbox() -> Option<PathBuf> {
    #[cfg(all(debug_assertions, not(test)))]
    {
        use std::sync::OnceLock;
        static SANDBOX: OnceLock<Option<PathBuf>> = OnceLock::new();
        SANDBOX
            .get_or_init(|| {
                let raw = std::env::var_os(ENV_VAR).filter(|raw| !raw.is_empty())?;
                let path = PathBuf::from(raw);
                // Falling back to the real home here would defeat the point:
                // whoever set the variable is relying on it.
                assert!(
                    path.is_absolute(),
                    "{ENV_VAR} must be an absolute path, got {}",
                    path.display()
                );
                Some(path)
            })
            .clone()
    }
    #[cfg(not(all(debug_assertions, not(test))))]
    {
        None
    }
}

/// The user's home directory, or the sandbox standing in for it.
pub fn home_dir() -> Option<PathBuf> {
    sandbox().or_else(dirs::home_dir)
}

/// The user's config directory, or `<sandbox>/.config` standing in for it.
pub fn config_dir() -> Option<PathBuf> {
    match sandbox() {
        Some(home) => Some(home.join(".config")),
        None => dirs::config_dir(),
    }
}
