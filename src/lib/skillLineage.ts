import { findLineageDuplicates, type LineageDuplicate } from "./tauri";

/** Identifies a suggested pair by both record ids, so a reinstall (new id) is suggested again. */
export const lineageDuplicateKey = (d: LineageDuplicate) => `${d.keep.id}:${d.source.id}`;

// Pairs the user said are not the same skill.
const DISMISSED_LINEAGE_KEY = "skills-manager.lineage-dismissed";

export function loadDismissedLineage(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_LINEAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveDismissedLineage(keys: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_LINEAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Not persisted; it stays hidden for this session.
  }
}

/**
 * Suggested links whose source-backed side was created after `knownSkillIds`
 * was taken: i.e. the install that just ran duplicated an imported skill.
 * Never throws; a failed lookup just means no suggestion.
 */
export async function newLineageDuplicates(knownSkillIds: Set<string>): Promise<LineageDuplicate[]> {
  try {
    const dismissed = loadDismissedLineage();
    const found = await findLineageDuplicates();
    return found.filter(
      (d) => !knownSkillIds.has(d.source.id) && !dismissed.has(lineageDuplicateKey(d))
    );
  } catch {
    return [];
  }
}
