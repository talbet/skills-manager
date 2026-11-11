import { useCallback, useSyncExternalStore } from "react";

export type SkillViewMode = "grid" | "list";

/**
 * Skill list view preferences, kept under one key so adding a preference does
 * not add a second storage entry to keep in sync.
 *
 * The stored value used to be the bare string `"grid"` / `"list"`; that form is
 * still read, so an existing installation keeps its view mode.
 *
 * Several views can be mounted at once (the add-skills sheet sits on top of an
 * agent page), so the preference lives in one module-level store: a change in
 * one view shows up in the others instead of being overwritten by their stale
 * copies.
 */
interface ViewPreference {
  viewMode: SkillViewMode;
  groupBySource: boolean;
}

const STORAGE_KEY = "skills-manager.skillViewMode";

const DEFAULT_PREFERENCE: ViewPreference = { viewMode: "grid", groupBySource: false };

function readPreference(): ViewPreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "grid" || stored === "list") {
      return { viewMode: stored, groupBySource: false };
    }
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ViewPreference>;
      return {
        viewMode: parsed.viewMode === "list" ? "list" : "grid",
        groupBySource: parsed.groupBySource === true,
      };
    }
  } catch {
    // Keep the view usable when browser storage is unavailable or holds junk.
  }
  return DEFAULT_PREFERENCE;
}

let current: ViewPreference | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): ViewPreference {
  if (!current) current = readPreference();
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function update(patch: Partial<ViewPreference>) {
  current = { ...getSnapshot(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // The selection still works for the current session.
  }
  for (const listener of listeners) listener();
}

export function useSkillViewMode() {
  const preference = useSyncExternalStore(subscribe, getSnapshot);

  const setViewMode = useCallback((next: SkillViewMode) => update({ viewMode: next }), []);
  const setGroupBySource = useCallback((next: boolean) => update({ groupBySource: next }), []);

  return [preference.viewMode, setViewMode, preference.groupBySource, setGroupBySource] as const;
}
