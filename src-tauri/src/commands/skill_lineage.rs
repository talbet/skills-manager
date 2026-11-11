//! Skill identity: renaming a library folder, and merging an unattributed copy
//! of a skill into the record that knows where the skill came from.
//!
//! The usual way into this module: a user switching to Skills Manager imports
//! the skills their agents already have. Those come in as `import` (or `local`)
//! records with no source, so they never get update checks. Installing the same
//! skill again from skills.sh or GitHub cannot reuse the folder (the content
//! differs, or the record is someone else's), so it lands as `<name>-2`.
//!
//! - [`find_lineage_duplicates_internal`] pairs each unattributed skill with an
//!   installed-from-source skill that looks like the same thing.
//! - [`merge_skill_lineage_internal`] keeps the unattributed record (its id,
//!   folder name, tags, presets and agent deployments) and gives it the other
//!   record's source and content, then removes the other record.
//! - [`rename_managed_skill_internal`] renames a library folder and moves its
//!   agent deployments with it, for when the user would rather keep the `-2`.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use crate::core::{
    audit_log::AuditDraft,
    central_repo, content_hash,
    error::{AppError, TargetConflictDetail},
    file_watcher, installer, scenario_service, skill_metadata,
    skill_store::{SkillRecord, SkillStore, SkillTargetRecord},
    sync_engine, sync_metadata,
};

use super::skills::{resync_copy_targets, staged_path_for};

/// Source types that carry no upstream: nothing to check for updates against.
const UNATTRIBUTED_SOURCE_TYPES: &[&str] = &["import", "local"];

fn is_unattributed(skill: &SkillRecord) -> bool {
    UNATTRIBUTED_SOURCE_TYPES.contains(&skill.source_type.as_str())
}

fn folder_name(skill: &SkillRecord) -> String {
    Path::new(&skill.central_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| skill.name.clone())
}

/// `My-Skill-2` → `my-skill`: the name an install would have used before
/// collision handling appended a counter.
fn base_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    match lower.rsplit_once('-') {
        Some((stem, counter))
            if !stem.is_empty()
                && !counter.is_empty()
                && counter.chars().all(|c| c.is_ascii_digit()) =>
        {
            stem.to_string()
        }
        _ => lower,
    }
}

/// The display name a reindex would give this directory, so a rename or merge
/// does not show one name until the next launch and another after it.
fn reindexed_name(dir: &Path) -> String {
    skill_metadata::parse_skill_md(dir)
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            dir.file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown-skill".to_string())
        })
}

// ── Detection ──

#[derive(Debug, Clone, Serialize)]
pub struct LineageSkillSummary {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub source_type: String,
    pub source_ref: Option<String>,
}

impl From<&SkillRecord> for LineageSkillSummary {
    fn from(skill: &SkillRecord) -> Self {
        Self {
            id: skill.id.clone(),
            name: skill.name.clone(),
            folder: folder_name(skill),
            source_type: skill.source_type.clone(),
            source_ref: skill.source_ref.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LineageDuplicate {
    /// The unattributed record. Merging keeps this one.
    pub keep: LineageSkillSummary,
    /// The record installed from a source. Merging removes it.
    pub source: LineageSkillSummary,
    /// From the recorded hashes, so it can lag behind edits made on disk since
    /// the last reindex. The merge itself re-hashes before deciding anything.
    pub content_identical: bool,
}

fn names_for_matching(skill: &SkillRecord) -> HashSet<String> {
    let mut names = HashSet::new();
    names.insert(base_name(&folder_name(skill)));
    names.insert(base_name(&skill.name));
    // `owner/repo/skill-id` — the id skills.sh lists the skill under.
    if skill.source_type == "skillssh" {
        if let Some((_, id)) = skill.source_ref.as_deref().and_then(|r| r.rsplit_once('/')) {
            names.insert(base_name(id));
        }
    }
    names.retain(|name| !name.is_empty());
    names
}

/// Pair every unattributed skill with each source-backed skill that looks like
/// the same skill: identical content, or the same name once a collision
/// counter is ignored.
pub fn find_lineage_duplicates_internal(
    store: &SkillStore,
) -> Result<Vec<LineageDuplicate>, AppError> {
    let skills = store.get_all_skills().map_err(AppError::db)?;
    let (unattributed, attributed): (Vec<&SkillRecord>, Vec<&SkillRecord>) =
        skills.iter().partition(|skill| is_unattributed(skill));

    let mut duplicates = Vec::new();
    for keep in &unattributed {
        let keep_names = names_for_matching(keep);
        for source in &attributed {
            let content_identical =
                keep.content_hash.is_some() && keep.content_hash == source.content_hash;
            let same_name = !keep_names.is_disjoint(&names_for_matching(source));
            if content_identical || same_name {
                duplicates.push(LineageDuplicate {
                    keep: LineageSkillSummary::from(*keep),
                    source: LineageSkillSummary::from(*source),
                    content_identical,
                });
            }
        }
    }
    duplicates.sort_by(|a, b| {
        a.keep
            .name
            .to_lowercase()
            .cmp(&b.keep.name.to_lowercase())
            .then_with(|| a.source.folder.cmp(&b.source.folder))
    });
    Ok(duplicates)
}

#[tauri::command]
pub async fn find_lineage_duplicates(
    store: State<'_, Arc<SkillStore>>,
) -> Result<Vec<LineageDuplicate>, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || find_lineage_duplicates_internal(&store)).await?
}

// ── Merge ──

#[derive(Debug, Clone, Serialize)]
pub struct MergeLineageResult {
    pub skill_id: String,
    pub name: String,
    pub source_type: String,
    pub content_changed: bool,
    /// Where the kept record's previous content was moved, when the source's
    /// content replaced it. `None` when the two were already identical.
    pub previous_content_path: Option<String>,
}

/// Move `dir` into the library's `kept-copies/merged/`, never overwriting
/// anything already there. A rename only: across volumes it fails, and the
/// caller must then leave the content where it is.
fn move_into_kept_copies(dir: &Path) -> std::io::Result<PathBuf> {
    let root = central_repo::base_dir().join("kept-copies").join("merged");
    std::fs::create_dir_all(&root)?;
    let name = dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let mut kept = root.join(&name);
    let mut n = 2;
    while std::fs::symlink_metadata(&kept).is_ok() {
        kept = root.join(format!("{name}-{n}"));
        n += 1;
    }
    file_watcher::mute_self_writes(dir);
    std::fs::rename(dir, &kept)?;
    Ok(kept)
}

/// Replace the contents of `keep_dir` with `source_dir`, moving the old
/// contents aside rather than deleting them: an imported skill may carry
/// edits that exist nowhere else. Returns where the old contents went.
fn replace_with_source_content(keep_dir: &Path, source_dir: &Path) -> Result<PathBuf, AppError> {
    let staged = staged_path_for(&keep_dir.to_string_lossy());
    let staged_name = keep_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    if let Err(err) = installer::install_skill_dir_to_destination(source_dir, &staged_name, &staged)
    {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(AppError::io(err));
    }

    let kept = match move_into_kept_copies(keep_dir) {
        Ok(kept) => kept,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&staged);
            return Err(AppError::io(format!(
                "Could not set aside the current copy of {}: {err}. Nothing was changed.",
                keep_dir.display()
            )));
        }
    };

    file_watcher::mute_self_writes(keep_dir);
    if let Err(err) = std::fs::rename(&staged, keep_dir) {
        // Put the original back; it is the only copy.
        let restored = std::fs::rename(&kept, keep_dir).is_ok();
        let _ = std::fs::remove_dir_all(&staged);
        return Err(AppError::io(if restored {
            format!(
                "Could not replace {}: {err}. Nothing was changed.",
                keep_dir.display()
            )
        } else {
            format!(
                "Could not replace {}: {err}. The previous copy is at {}.",
                keep_dir.display(),
                kept.display()
            )
        }));
    }
    Ok(kept)
}

/// Give `keep_id` (an unattributed record) the source lineage and content of
/// `source_id`, then remove `source_id`.
///
/// The kept record's id, folder, tags, preset memberships and deployments all
/// survive; the removed record's tags and presets are added to it. When the
/// contents differ, the source's version wins — that is the point of linking
/// to a source — and the previous content is moved to
/// `kept-copies/merged/` instead of being deleted.
pub fn merge_skill_lineage_internal(
    store: &SkillStore,
    keep_id: &str,
    source_id: &str,
) -> Result<MergeLineageResult, AppError> {
    if keep_id == source_id {
        return Err(AppError::invalid_input("Cannot merge a skill with itself"));
    }

    let result = sync_metadata::with_repo_lock("merge skill lineage", || {
        Ok(merge_skill_lineage_unlocked(store, keep_id, source_id))
    })
    .map_err(AppError::db)?;

    let draft = AuditDraft::new("merge");
    match &result {
        Ok(merged) => store.log_audit(
            draft
                .skill(merged.skill_id.clone(), merged.name.clone())
                .detail(format!("linked to {}", merged.source_type))
                .ok(),
        ),
        Err(e) => store.log_audit(draft.skill(keep_id.to_string(), "").fail(e.to_string())),
    }
    result
}

fn merge_skill_lineage_unlocked(
    store: &SkillStore,
    keep_id: &str,
    source_id: &str,
) -> Result<MergeLineageResult, AppError> {
    let keep = store
        .get_skill_by_id(keep_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill to keep was not found"))?;
    let source = store
        .get_skill_by_id(source_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill to link was not found"))?;

    if !is_unattributed(&keep) {
        return Err(AppError::invalid_input(format!(
            "\"{}\" already has a source ({}); only imported or local skills can be linked",
            keep.name, keep.source_type
        )));
    }
    if is_unattributed(&source) {
        return Err(AppError::invalid_input(format!(
            "\"{}\" has no source to link to",
            source.name
        )));
    }

    let keep_dir = PathBuf::from(&keep.central_path);
    let source_dir = PathBuf::from(&source.central_path);
    if !source_dir.is_dir() {
        return Err(AppError::not_found(format!(
            "The library folder of \"{}\" is missing",
            source.name
        )));
    }

    // Hash from disk: the recorded hashes are only as fresh as the last reindex.
    let source_hash = content_hash::hash_directory(&source_dir).map_err(AppError::io)?;
    let keep_hash = if keep_dir.is_dir() {
        Some(content_hash::hash_directory(&keep_dir).map_err(AppError::io)?)
    } else {
        None
    };
    let content_changed = keep_hash.as_deref() != Some(source_hash.as_str());

    let previous_content_path = if content_changed {
        if keep_dir.is_dir() {
            Some(replace_with_source_content(&keep_dir, &source_dir)?)
        } else {
            installer::install_skill_dir_to_destination(
                &source_dir,
                &folder_name(&keep),
                &keep_dir,
            )
            .map_err(AppError::io)?;
            None
        }
    } else {
        None
    };

    let new_hash = content_hash::hash_directory(&keep_dir).map_err(AppError::io)?;
    let name = reindexed_name(&keep_dir);
    let description = skill_metadata::parse_skill_md(&keep_dir).description;
    store
        .update_skill_after_reinstall(
            &keep.id,
            &name,
            description.as_deref(),
            &source.source_type,
            source.source_ref.as_deref(),
            source.source_ref_resolved.as_deref(),
            source.source_subpath.as_deref(),
            source.source_branch.as_deref(),
            source.source_revision.as_deref(),
            source.remote_revision.as_deref(),
            Some(&new_hash),
            &source.update_status,
        )
        .map_err(AppError::db)?;

    // Carry over what the user attached to the record that is going away.
    let tags_map = store.get_tags_map().map_err(AppError::db)?;
    let mut tags: Vec<String> = tags_map.get(&keep.id).cloned().unwrap_or_default();
    for tag in tags_map.get(&source.id).into_iter().flatten() {
        if !tags.contains(tag) {
            tags.push(tag.clone());
        }
    }
    store
        .set_tags_for_skill(&keep.id, &tags)
        .map_err(AppError::db)?;

    let keep_scenarios: HashSet<String> = store
        .get_scenarios_for_skill(&keep.id)
        .map_err(AppError::db)?
        .into_iter()
        .collect();
    let added_scenarios: Vec<String> = store
        .get_scenarios_for_skill(&source.id)
        .map_err(AppError::db)?
        .into_iter()
        .filter(|scenario| !keep_scenarios.contains(scenario))
        .collect();
    for scenario_id in &added_scenarios {
        store
            .add_skill_to_scenario(scenario_id, &keep.id)
            .map_err(AppError::db)?;
    }

    // Remove the source record and what it deployed. Its folder holds nothing
    // the kept record does not now have.
    for target in store
        .get_targets_for_skill(&source.id)
        .map_err(AppError::db)?
    {
        sync_engine::remove_recorded_target_or_warn(Path::new(&target.target_path), &target.mode);
    }
    file_watcher::mute_self_writes(&source_dir);
    if let Err(err) = std::fs::remove_dir_all(&source_dir) {
        log::warn!(
            "merge: could not remove the merged folder {}: {err}",
            source_dir.display()
        );
    }
    store.delete_skill(&source.id).map_err(AppError::db)?;

    sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db)?;

    // Deployments: copies need the new content; presets just joined may need
    // a deployment if one of them is active. Neither undoes the merge.
    if let Err(e) = resync_copy_targets(store, &keep.id) {
        log::warn!("merge: could not refresh copies of {}: {e}", keep.name);
    }
    if let Ok(Some(active)) = store.get_active_scenario_id() {
        if added_scenarios.contains(&active) {
            if let Err(e) =
                scenario_service::sync_skill_to_active_scenario(store, &active, &keep.id)
            {
                log::warn!(
                    "merge: could not deploy {} to the active preset: {e}",
                    keep.name
                );
            }
        }
    }

    Ok(MergeLineageResult {
        skill_id: keep.id,
        name,
        source_type: source.source_type,
        content_changed,
        previous_content_path: previous_content_path.map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub async fn merge_skill_lineage(
    keep_id: String,
    source_id: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<MergeLineageResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        merge_skill_lineage_internal(&store, &keep_id, &source_id)
    })
    .await?
}

// ── Rename ──

#[derive(Debug, Clone, Serialize)]
pub struct RenameSkillResult {
    pub skill_id: String,
    pub name: String,
    pub folder: String,
    pub central_path: String,
    /// Deployments that could not be moved. Their records were dropped, so the
    /// next sync deploys them under the new name.
    pub redeploy_failures: Vec<String>,
}

/// Paths differing only in letter case, which a case-insensitive file system
/// treats as the same entry (`foo` → `Foo` on macOS and Windows).
fn same_path_ignoring_case(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

fn validate_folder_name(requested: &str) -> Result<String, AppError> {
    let trimmed = requested.trim();
    let sanitized = skill_metadata::sanitize_skill_name(trimmed)
        .ok_or_else(|| AppError::invalid_input(format!("Invalid folder name: '{trimmed}'")))?;
    // Reject instead of silently storing something other than what was typed.
    if sanitized != trimmed {
        return Err(AppError::invalid_input(format!(
            "Invalid folder name: '{trimmed}'. Folder names cannot contain path separators or reserved characters"
        )));
    }
    if trimmed.starts_with('.') {
        return Err(AppError::invalid_input(
            "Folder names cannot start with '.'",
        ));
    }
    Ok(sanitized)
}

/// One deployment path and every tool recorded there. Tools can share a
/// directory (amp and replit both use `~/.config/agents/skills`), so the path,
/// not the row, is the unit that moves.
struct TargetMove {
    old: PathBuf,
    new: PathBuf,
    rows: Vec<SkillTargetRecord>,
}

fn plan_target_moves(targets: Vec<SkillTargetRecord>, new_folder: &str) -> Vec<TargetMove> {
    let mut moves: Vec<TargetMove> = Vec::new();
    let mut index: HashMap<PathBuf, usize> = HashMap::new();
    for row in targets {
        let old = PathBuf::from(&row.target_path);
        let Some(parent) = old.parent() else {
            continue;
        };
        let new = parent.join(new_folder);
        match index.get(&old) {
            Some(&i) => moves[i].rows.push(row),
            None => {
                index.insert(old.clone(), moves.len());
                moves.push(TargetMove {
                    old,
                    new,
                    rows: vec![row],
                });
            }
        }
    }
    moves
}

/// Move one deployment path to its new name. Returns the mode now deployed.
fn move_deployment(
    planned: &TargetMove,
    new_source: &Path,
) -> anyhow::Result<sync_engine::SyncMode> {
    let recorded_mode = planned.rows[0].mode.as_str();
    if recorded_mode == "copy"
        && sync_engine::matches_recorded_deployment(&planned.old, "copy").unwrap_or(false)
    {
        // A copy can carry edits made in the agent's directory; moving it
        // keeps them, where delete-and-recopy would not.
        file_watcher::mute_self_writes(&planned.old);
        file_watcher::mute_self_writes(&planned.new);
        std::fs::rename(&planned.old, &planned.new)?;
        return Ok(sync_engine::SyncMode::Copy);
    }

    // Only removes what still matches the record; anything the user put there
    // instead stays.
    sync_engine::remove_recorded_target(&planned.old, recorded_mode)?;
    let mode = if recorded_mode == "copy" {
        sync_engine::SyncMode::Copy
    } else {
        sync_engine::SyncMode::Symlink
    };
    sync_engine::sync_skill(
        new_source,
        &planned.new,
        mode,
        sync_engine::ReplacePolicy::NoClobber,
    )
}

/// Rename a skill's library folder, and move each agent deployment to the
/// new name with it.
///
/// Refuses before touching anything when the new name is taken in the library
/// or at any deployment path. Content is not modified: the display name still
/// comes from `SKILL.md`, so a source-backed skill does not drift from its
/// upstream by being renamed.
pub fn rename_managed_skill_internal(
    store: &SkillStore,
    skill_id: &str,
    new_folder: &str,
) -> Result<RenameSkillResult, AppError> {
    let new_folder = validate_folder_name(new_folder)?;
    let result = sync_metadata::with_repo_lock("rename skill", || {
        Ok(rename_managed_skill_unlocked(store, skill_id, &new_folder))
    })
    .map_err(AppError::db)?;

    let draft = AuditDraft::new("rename");
    match &result {
        Ok(renamed) => store.log_audit(
            draft
                .skill(renamed.skill_id.clone(), renamed.name.clone())
                .detail(format!("folder renamed to {}", renamed.folder))
                .ok(),
        ),
        Err(e) => store.log_audit(draft.skill(skill_id.to_string(), "").fail(e.to_string())),
    }
    result
}

fn rename_managed_skill_unlocked(
    store: &SkillStore,
    skill_id: &str,
    new_folder: &str,
) -> Result<RenameSkillResult, AppError> {
    let skill = store
        .get_skill_by_id(skill_id)
        .map_err(AppError::db)?
        .ok_or_else(|| AppError::not_found("Skill not found"))?;
    let old_dir = PathBuf::from(&skill.central_path);
    let parent = old_dir
        .parent()
        .ok_or_else(|| AppError::invalid_input("Skill has no library folder"))?
        .to_path_buf();
    let new_dir = parent.join(new_folder);

    if new_dir == old_dir {
        return Ok(RenameSkillResult {
            skill_id: skill.id,
            name: skill.name,
            folder: new_folder.to_string(),
            central_path: skill.central_path,
            redeploy_failures: Vec::new(),
        });
    }
    if !old_dir.is_dir() {
        return Err(AppError::not_found(format!(
            "The library folder {} is missing",
            old_dir.display()
        )));
    }

    // ── Preflight: nothing below may run unless all of it can. ──
    let case_only = same_path_ignoring_case(&old_dir, &new_dir);
    if !case_only && std::fs::symlink_metadata(&new_dir).is_ok() {
        return Err(AppError::invalid_input(format!(
            "A skill folder named \"{new_folder}\" already exists in the library"
        )));
    }
    let new_dir_str = new_dir.to_string_lossy().to_string();
    if let Some(other) = store
        .get_skill_by_central_path(&new_dir_str)
        .map_err(AppError::db)?
    {
        if other.id != skill.id {
            return Err(AppError::invalid_input(format!(
                "\"{}\" already uses the folder \"{new_folder}\"",
                other.name
            )));
        }
    }

    let targets = store
        .get_targets_for_skill(&skill.id)
        .map_err(AppError::db)?;
    let moves = plan_target_moves(targets, new_folder);
    let mut conflicts = Vec::new();
    for planned in &moves {
        if planned.new == planned.old || same_path_ignoring_case(&planned.old, &planned.new) {
            continue;
        }
        match sync_engine::classify_target(&planned.new, None) {
            Ok(sync_engine::TargetState::Absent) => {}
            Ok(_) => conflicts.push(TargetConflictDetail {
                path: planned.new.display().to_string(),
                reason: "already exists".to_string(),
            }),
            Err(e) => conflicts.push(TargetConflictDetail {
                path: planned.new.display().to_string(),
                reason: format!("cannot be inspected: {e}"),
            }),
        }
    }
    if !conflicts.is_empty() {
        return Err(AppError::target_conflict(
            format!(
                "Refusing to rename: {} agent folder(s) already have something named \"{new_folder}\". Nothing was changed.",
                conflicts.len()
            ),
            conflicts,
        ));
    }

    // ── Library folder, record and metadata, as one step. ──
    file_watcher::mute_self_writes(&old_dir);
    file_watcher::mute_self_writes(&new_dir);
    std::fs::rename(&old_dir, &new_dir).map_err(|e| {
        AppError::io(format!(
            "Could not rename {} to {}: {e}",
            old_dir.display(),
            new_dir.display()
        ))
    })?;

    let name = reindexed_name(&new_dir);
    let committed = store
        .update_skill_location(&skill.id, &name, &new_dir_str)
        .map_err(AppError::db)
        // The reindex at next launch rebuilds records from metadata; a record
        // the metadata does not match would be dropped there (#553).
        .and_then(|()| sync_metadata::write_all_from_db_unlocked(store).map_err(AppError::db));
    if let Err(e) = committed {
        let _ = store.update_skill_location(&skill.id, &skill.name, &skill.central_path);
        let _ = std::fs::rename(&new_dir, &old_dir);
        let _ = sync_metadata::write_all_from_db_unlocked(store);
        return Err(e);
    }

    // ── Deployments. The rename has happened; failures here are reported,
    // and a dropped record makes the next sync deploy under the new name. ──
    let mut redeploy_failures = Vec::new();
    for planned in &moves {
        for row in &planned.rows {
            let _ = store.delete_target(&skill.id, &row.tool);
        }
        match move_deployment(planned, &new_dir) {
            Ok(mode) => {
                let now = chrono::Utc::now().timestamp_millis();
                for row in &planned.rows {
                    let record = SkillTargetRecord {
                        id: uuid::Uuid::new_v4().to_string(),
                        target_path: planned.new.to_string_lossy().to_string(),
                        mode: mode.as_str().to_string(),
                        status: "ok".to_string(),
                        synced_at: Some(now),
                        last_error: None,
                        ..row.clone()
                    };
                    if let Err(e) = store.insert_target(&record) {
                        log::warn!("rename: could not record {}: {e}", planned.new.display());
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "rename: could not move {} to {}: {e}",
                    planned.old.display(),
                    planned.new.display()
                );
                redeploy_failures.push(format!("{}: {e}", planned.new.display()));
            }
        }
    }

    Ok(RenameSkillResult {
        skill_id: skill.id,
        name,
        folder: new_folder.to_string(),
        central_path: new_dir_str,
        redeploy_failures,
    })
}

#[tauri::command]
pub async fn rename_managed_skill(
    skill_id: String,
    new_folder: String,
    store: State<'_, Arc<SkillStore>>,
) -> Result<RenameSkillResult, AppError> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        rename_managed_skill_internal(&store, &skill_id, &new_folder)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::{tempdir, TempDir};

    struct TestRepo {
        _lock: std::sync::MutexGuard<'static, ()>,
        tmp: TempDir,
        store: SkillStore,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            central_repo::set_test_base_dir_override(None);
        }
    }

    fn test_repo() -> TestRepo {
        let lock = central_repo::test_base_dir_lock();
        let tmp = tempdir().unwrap();
        let base = tmp.path().join("repo");
        central_repo::set_test_base_dir_override(Some(base.clone()));
        fs::create_dir_all(central_repo::skills_dir()).unwrap();
        let store = SkillStore::new(&base.join("test.db")).unwrap();
        TestRepo {
            _lock: lock,
            tmp,
            store,
        }
    }

    fn add_skill(
        store: &SkillStore,
        id: &str,
        folder: &str,
        body: &str,
        source_type: &str,
        source_ref: Option<&str>,
    ) -> SkillRecord {
        let dir = central_repo::skills_dir().join(folder);
        fs::create_dir_all(&dir).unwrap();
        let front_name = base_name(folder);
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {front_name}\ndescription: d\n---\n{body}\n"),
        )
        .unwrap();
        let record = SkillRecord {
            id: id.to_string(),
            name: folder.to_string(),
            description: Some("d".to_string()),
            source_type: source_type.to_string(),
            source_ref: source_ref.map(str::to_string),
            source_ref_resolved: source_ref.map(|_| "https://github.com/o/r.git".to_string()),
            source_subpath: source_ref.map(|_| format!("skills/{front_name}")),
            source_branch: None,
            source_revision: source_ref.map(|_| "abc123".to_string()),
            remote_revision: source_ref.map(|_| "abc123".to_string()),
            central_path: dir.to_string_lossy().to_string(),
            content_hash: Some(content_hash::hash_directory(&dir).unwrap()),
            enabled: true,
            created_at: 1,
            updated_at: 1,
            status: "ok".to_string(),
            update_status: if source_ref.is_some() {
                "up_to_date".to_string()
            } else {
                "unknown".to_string()
            },
            last_checked_at: None,
            last_check_error: None,
        };
        store.insert_skill(&record).unwrap();
        record
    }

    fn deploy(
        store: &SkillStore,
        skill: &SkillRecord,
        tool: &str,
        agent_dir: &Path,
        copy: bool,
    ) -> PathBuf {
        fs::create_dir_all(agent_dir).unwrap();
        let target = agent_dir.join(folder_name(skill));
        let mode = if copy {
            sync_engine::SyncMode::Copy
        } else {
            sync_engine::SyncMode::Symlink
        };
        let actual = sync_engine::sync_skill(
            Path::new(&skill.central_path),
            &target,
            mode,
            sync_engine::ReplacePolicy::NoClobber,
        )
        .unwrap();
        store
            .insert_target(&SkillTargetRecord {
                id: uuid::Uuid::new_v4().to_string(),
                skill_id: skill.id.clone(),
                tool: tool.to_string(),
                target_path: target.to_string_lossy().to_string(),
                mode: actual.as_str().to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: skill.content_hash.clone(),
            })
            .unwrap();
        target
    }

    #[test]
    fn base_name_strips_only_a_numeric_counter() {
        assert_eq!(base_name("pdf-2"), "pdf");
        assert_eq!(base_name("PDF-12"), "pdf");
        assert_eq!(base_name("web-design"), "web-design");
        assert_eq!(base_name("v-2a"), "v-2a");
        assert_eq!(base_name("-2"), "-2");
    }

    #[test]
    fn finds_an_imported_skill_and_its_numbered_reinstall() {
        let repo = test_repo();
        add_skill(&repo.store, "imp", "pdf", "local", "import", None);
        add_skill(
            &repo.store,
            "ssh",
            "pdf-2",
            "remote",
            "skillssh",
            Some("o/r/pdf"),
        );
        add_skill(
            &repo.store,
            "other",
            "docx",
            "x",
            "git",
            Some("https://github.com/o/r"),
        );

        let found = find_lineage_duplicates_internal(&repo.store).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].keep.id, "imp");
        assert_eq!(found[0].source.id, "ssh");
        assert!(!found[0].content_identical);
    }

    #[test]
    fn identical_content_matches_whatever_the_names() {
        let repo = test_repo();
        let a = add_skill(&repo.store, "imp", "my-pdf-helper", "same", "import", None);
        let b = add_skill(
            &repo.store,
            "git",
            "pdf",
            "same",
            "git",
            Some("https://github.com/o/r"),
        );
        // Make the bytes identical, names included.
        fs::copy(
            Path::new(&b.central_path).join("SKILL.md"),
            Path::new(&a.central_path).join("SKILL.md"),
        )
        .unwrap();
        let hash = content_hash::hash_directory(Path::new(&a.central_path)).unwrap();
        repo.store
            .update_skill_after_reinstall(
                "imp",
                &a.name,
                None,
                "import",
                None,
                None,
                None,
                None,
                None,
                None,
                Some(&hash),
                "unknown",
            )
            .unwrap();

        let found = find_lineage_duplicates_internal(&repo.store).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].content_identical);
    }

    #[test]
    fn source_backed_skills_are_never_offered_as_the_kept_side() {
        let repo = test_repo();
        add_skill(
            &repo.store,
            "a",
            "pdf",
            "one",
            "git",
            Some("https://github.com/a/r"),
        );
        add_skill(
            &repo.store,
            "b",
            "pdf-2",
            "two",
            "skillssh",
            Some("o/r/pdf"),
        );
        assert!(find_lineage_duplicates_internal(&repo.store)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn merge_keeps_the_imported_record_and_takes_the_source_lineage() {
        let repo = test_repo();
        let keep = add_skill(&repo.store, "imp", "pdf", "my local edits", "import", None);
        let source = add_skill(
            &repo.store,
            "ssh",
            "pdf-2",
            "upstream",
            "skillssh",
            Some("o/r/pdf"),
        );
        repo.store
            .set_tags_for_skill("imp", &["docs".to_string()])
            .unwrap();
        repo.store
            .set_tags_for_skill("ssh", &["pdf".to_string()])
            .unwrap();
        let agent = repo.tmp.path().join("agent");
        let keep_link = deploy(&repo.store, &keep, "claude_code", &agent, false);
        let source_link = deploy(&repo.store, &source, "claude_code", &agent, false);

        // Start from a real metadata snapshot, as the app has, so the reindex
        // below has something to rebuild from.
        sync_metadata::write_all_from_db(&repo.store).unwrap();

        let merged = merge_skill_lineage_internal(&repo.store, "imp", "ssh").unwrap();
        assert!(merged.content_changed);

        let record = repo.store.get_skill_by_id("imp").unwrap().unwrap();
        assert_eq!(record.source_type, "skillssh");
        assert_eq!(record.source_ref.as_deref(), Some("o/r/pdf"));
        assert_eq!(record.source_subpath.as_deref(), Some("skills/pdf"));
        assert_eq!(record.source_revision.as_deref(), Some("abc123"));
        assert_eq!(record.central_path, keep.central_path);
        let body = fs::read_to_string(Path::new(&record.central_path).join("SKILL.md")).unwrap();
        assert!(body.contains("upstream"));

        // The previous content was moved aside, not deleted.
        let kept = PathBuf::from(merged.previous_content_path.unwrap());
        assert!(fs::read_to_string(kept.join("SKILL.md"))
            .unwrap()
            .contains("my local edits"));

        // The duplicate is gone: record, folder and its deployment.
        assert!(repo.store.get_skill_by_id("ssh").unwrap().is_none());
        assert!(!Path::new(&source.central_path).exists());
        assert!(fs::symlink_metadata(&source_link).is_err());
        // The kept deployment still resolves to the (new) content.
        assert!(fs::read_to_string(keep_link.join("SKILL.md"))
            .unwrap()
            .contains("upstream"));

        let mut tags = repo.store.get_tags_map().unwrap().remove("imp").unwrap();
        tags.sort();
        assert_eq!(tags, vec!["docs".to_string(), "pdf".to_string()]);

        // Survives the reindex that runs at every launch (#553).
        sync_metadata::reindex_from_metadata(&repo.store).unwrap();
        let record = repo.store.get_skill_by_id("imp").unwrap().unwrap();
        assert_eq!(record.source_type, "skillssh");
        assert_eq!(record.source_ref.as_deref(), Some("o/r/pdf"));
        assert!(repo.store.get_skill_by_id("ssh").unwrap().is_none());
    }

    #[test]
    fn merge_with_identical_content_moves_nothing_aside() {
        let repo = test_repo();
        let keep = add_skill(&repo.store, "imp", "pdf", "same", "import", None);
        add_skill(
            &repo.store,
            "ssh",
            "pdf-2",
            "same",
            "skillssh",
            Some("o/r/pdf"),
        );

        let merged = merge_skill_lineage_internal(&repo.store, "imp", "ssh").unwrap();
        assert!(!merged.content_changed);
        assert!(merged.previous_content_path.is_none());
        assert!(!central_repo::base_dir().join("kept-copies").exists());
        assert!(Path::new(&keep.central_path).is_dir());
    }

    #[test]
    fn merge_refuses_a_kept_side_that_already_has_a_source() {
        let repo = test_repo();
        let a = add_skill(
            &repo.store,
            "a",
            "pdf",
            "one",
            "git",
            Some("https://github.com/a/r"),
        );
        add_skill(
            &repo.store,
            "b",
            "pdf-2",
            "two",
            "skillssh",
            Some("o/r/pdf"),
        );

        let err = merge_skill_lineage_internal(&repo.store, "a", "b").unwrap_err();
        assert!(err.message.contains("already has a source"));
        // Untouched.
        assert!(repo.store.get_skill_by_id("b").unwrap().is_some());
        let record = repo.store.get_skill_by_id("a").unwrap().unwrap();
        assert_eq!(record.source_type, a.source_type);
    }

    #[test]
    fn rename_moves_the_folder_and_every_deployment() {
        let repo = test_repo();
        let skill = add_skill(
            &repo.store,
            "ssh",
            "pdf-2",
            "upstream",
            "skillssh",
            Some("o/r/pdf"),
        );
        repo.store
            .set_tags_for_skill("ssh", &["docs".to_string()])
            .unwrap();
        let link_agent = repo.tmp.path().join("claude");
        let copy_agent = repo.tmp.path().join("cursor");
        let old_link = deploy(&repo.store, &skill, "claude_code", &link_agent, false);
        let old_copy = deploy(&repo.store, &skill, "cursor", &copy_agent, true);
        // An edit made in the agent's copy must survive the move.
        fs::write(old_copy.join("notes.md"), "agent-side edit").unwrap();

        sync_metadata::write_all_from_db(&repo.store).unwrap();

        let renamed = rename_managed_skill_internal(&repo.store, "ssh", "pdf").unwrap();
        assert!(
            renamed.redeploy_failures.is_empty(),
            "{:?}",
            renamed.redeploy_failures
        );
        assert_eq!(renamed.name, "pdf");

        let new_dir = central_repo::skills_dir().join("pdf");
        assert!(new_dir.join("SKILL.md").is_file());
        assert!(!Path::new(&skill.central_path).exists());

        let record = repo.store.get_skill_by_id("ssh").unwrap().unwrap();
        assert_eq!(record.central_path, new_dir.to_string_lossy());
        assert_eq!(record.source_ref.as_deref(), Some("o/r/pdf"));

        assert!(fs::symlink_metadata(&old_link).is_err());
        assert!(fs::symlink_metadata(&old_copy).is_err());
        let new_link = link_agent.join("pdf");
        let new_copy = copy_agent.join("pdf");
        assert!(fs::symlink_metadata(&new_link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(new_link.join("SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(new_copy.join("notes.md")).unwrap(),
            "agent-side edit"
        );

        let targets = repo.store.get_targets_for_skill("ssh").unwrap();
        assert_eq!(targets.len(), 2);
        assert!(targets
            .iter()
            .all(|t| Path::new(&t.target_path).file_name().unwrap() == "pdf"));

        // Survives the reindex that runs at every launch (#553).
        sync_metadata::reindex_from_metadata(&repo.store).unwrap();
        let record = repo.store.get_skill_by_id("ssh").unwrap().unwrap();
        assert_eq!(record.central_path, new_dir.to_string_lossy());
        assert_eq!(record.source_type, "skillssh");
        assert_eq!(
            repo.store.get_tags_map().unwrap().remove("ssh").unwrap(),
            vec!["docs".to_string()]
        );
    }

    #[test]
    fn rename_moves_a_shared_agent_directory_once() {
        let repo = test_repo();
        let skill = add_skill(&repo.store, "s", "pdf-2", "x", "skillssh", Some("o/r/pdf"));
        let shared = repo.tmp.path().join("agents");
        let link = deploy(&repo.store, &skill, "amp", &shared, false);
        repo.store
            .insert_target(&SkillTargetRecord {
                id: "replit-row".to_string(),
                skill_id: "s".to_string(),
                tool: "replit".to_string(),
                target_path: link.to_string_lossy().to_string(),
                mode: "symlink".to_string(),
                status: "ok".to_string(),
                synced_at: Some(1),
                last_error: None,
                source_hash: None,
            })
            .unwrap();

        let renamed = rename_managed_skill_internal(&repo.store, "s", "pdf").unwrap();
        assert!(
            renamed.redeploy_failures.is_empty(),
            "{:?}",
            renamed.redeploy_failures
        );
        let targets = repo.store.get_targets_for_skill("s").unwrap();
        assert_eq!(targets.len(), 2);
        assert!(targets
            .iter()
            .all(|t| t.target_path == shared.join("pdf").to_string_lossy()));
        assert!(shared.join("pdf").join("SKILL.md").is_file());
    }

    #[test]
    fn rename_refuses_when_an_agent_folder_is_taken_and_changes_nothing() {
        let repo = test_repo();
        let skill = add_skill(&repo.store, "s", "pdf-2", "x", "skillssh", Some("o/r/pdf"));
        let agent = repo.tmp.path().join("claude");
        let link = deploy(&repo.store, &skill, "claude_code", &agent, false);
        // The user's own directory sits where the renamed deployment would go.
        fs::create_dir_all(agent.join("pdf")).unwrap();
        fs::write(agent.join("pdf").join("SKILL.md"), "mine").unwrap();

        let err = rename_managed_skill_internal(&repo.store, "s", "pdf").unwrap_err();
        assert_eq!(err.details.as_ref().map(|d| d.conflicts.len()), Some(1));

        assert!(Path::new(&skill.central_path).is_dir());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(agent.join("pdf").join("SKILL.md")).unwrap(),
            "mine"
        );
        let record = repo.store.get_skill_by_id("s").unwrap().unwrap();
        assert_eq!(record.central_path, skill.central_path);
    }

    #[test]
    fn rename_refuses_a_library_folder_that_exists() {
        let repo = test_repo();
        let skill = add_skill(&repo.store, "s", "pdf-2", "x", "skillssh", Some("o/r/pdf"));
        fs::create_dir_all(central_repo::skills_dir().join("pdf")).unwrap();

        let err = rename_managed_skill_internal(&repo.store, "s", "pdf").unwrap_err();
        assert!(err.message.contains("already exists"));
        assert!(Path::new(&skill.central_path).is_dir());
    }

    #[test]
    fn rename_rejects_names_that_are_not_a_single_folder() {
        let repo = test_repo();
        add_skill(&repo.store, "s", "pdf-2", "x", "skillssh", Some("o/r/pdf"));
        for bad in ["", "  ", "../pdf", "a/b", ".hidden", "pd:f"] {
            assert!(
                rename_managed_skill_internal(&repo.store, "s", bad).is_err(),
                "accepted {bad:?}"
            );
        }
    }
}
