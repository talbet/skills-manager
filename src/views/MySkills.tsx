import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  LayoutGrid,
  List,
  CheckCircle2,
  Github,
  HardDrive,
  Globe,
  Layers,
  RefreshCw,
  RotateCcw,
  Loader2,
  X,
  Plus,
  SquareCheck,
  Square,
  GripVertical,
  CircleSlash,
  Circle,
  FolderTree,
  Pencil,
  Link2,
  Share2,
  Tag,
  Trash2,
} from "lucide-react";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { useLocation, useNavigate } from "react-router-dom";
import { viewedPresetIdFrom } from "../lib/presetRoute";
import { getPresetIconOption } from "../lib/presetIcons";
import { MembershipPopover } from "../components/MembershipPopover";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "../utils";
import { useApp } from "../context/AppContext";
import { useSkillViewMode } from "../hooks/useSkillViewMode";
import { useMultiSelect } from "../hooks/useMultiSelect";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TagRenameDialog } from "../components/TagRenameDialog";
import { SkillDetailPanel } from "../components/SkillDetailPanel";
import { MultiSelectToolbar } from "../components/MultiSelectToolbar";
import { BatchTagDialog } from "../components/BatchTagDialog";
import { BatchSyncAgentDialog } from "../components/BatchSyncAgentDialog";
import { SyncDots } from "../components/SyncDots";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { CardActionMenu } from "../components/CardActionMenu";
import { RenameSkillDialog } from "../components/RenameSkillDialog";
import { LinkDuplicatesDialog } from "../components/LinkDuplicatesDialog";
import { lineageDuplicateKey, loadDismissedLineage, saveDismissedLineage } from "../lib/skillLineage";
import { StatusBanner } from "../components/StatusBanner";
import * as api from "../lib/tauri";
import { getTagActiveColor, getTagColor, pruneStaleTagFilters, UNTAGGED_FILTER } from "../lib/skillTags";
import type {
  ManagedSkill,
  ToolInfo,
  SkillToolToggle,
} from "../lib/tauri";
import { getErrorMessage } from "../lib/error";
import { normalizeSkillSearch, skillSearchMatches } from "../lib/skillSearch";
import {
  buildBundleIndex,
  buildSourceGroups,
  getSkillSourceInfo,
  groupIntoBundles,
  UNGROUPED_KEY,
  type SkillBundleSection,
} from "../lib/skillSource";
import { SkillAvatar } from "../components/SkillAvatar";
import { SkillGroupHeader } from "../components/SkillGroupHeader";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface SortableSkillItemProps {
  id: string;
  disabled: boolean;
  className?: string;
  /** Positions the handle against the card's left edge ("card" tops it on the heading; "row" centres it). */
  handlePlacement: "card" | "row";
  handleTitle?: string;
  children: (dragHandle: React.ReactNode) => React.ReactNode;
}

/**
 * A sortable card. Its grip hangs over the card's left edge and only appears
 * on hover or focus, so it takes no space from the heading when the user is
 * not reordering. The grip carries dnd-kit's attributes and listeners, which
 * makes it the one keyboard-sortable stop (Space to lift, arrows to move).
 */
function SortableSkillItem({
  id,
  disabled,
  className,
  handlePlacement,
  handleTitle,
  children,
}: SortableSkillItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  const handle = !disabled ? (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => e.stopPropagation()}
      title={handleTitle}
      aria-label={handleTitle}
      className={cn(
        "absolute -left-2.5 z-10 flex h-6 w-5 cursor-grab items-center justify-center rounded-md border border-border bg-surface text-faint shadow-sm outline-none transition-opacity hover:bg-surface-hover hover:text-muted focus-visible:opacity-100 active:cursor-grabbing",
        handlePlacement === "card" ? "top-2.5" : "top-1/2 -translate-y-1/2",
        isDragging ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  ) : null;

  return (
    <div ref={setNodeRef} style={style} className={cn("h-full", className)}>
      {children(handle)}
    </div>
  );
}

/** Busy key for the tag filter row's enable/disable-all buttons. */
const TAG_FILTER_TOGGLE_KEY = "__tag_filter__";

function getToolDisplayName(toolKey: string, tools: ToolInfo[]) {
  return tools.find((tool) => tool.key === toolKey)?.display_name || toolKey;
}

function centralDirName(skill: ManagedSkill) {
  return skill.central_path.split(/[\\/]/).filter(Boolean).pop() || skill.name;
}

/**
 * One row of the list: either a bundle header or a skill. Keeping them in one
 * array lets the grouped and ungrouped views share the same render path.
 */
type SkillListRow =
  | { kind: "group"; section: SkillBundleSection<ManagedSkill>; expanded: boolean; showHeader: boolean }
  | { kind: "skill"; skill: ManagedSkill };

function folderOf(skill: ManagedSkill): string {
  return skill.central_path.split(/[\\/]/).filter(Boolean).pop() ?? skill.name;
}

export function MySkills() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    presets,
    tools,
    managedSkills: skills,
    refreshPresets,
    refreshManagedSkills,
    refreshTools,
    detailSkillId,
    openSkillDetailById,
    closeSkillDetail,
    projects,
    refreshProjects,
  } = useApp();
  const [viewMode, setViewMode, groupBySource, setGroupBySource] = useSkillViewMode();
  // Grouping is a view preference, so it persists; which groups are folded is
  // session state, because a group the user folded once is not a statement
  // about the next launch. Groups start open.
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [togglingGroupKey, setTogglingGroupKey] = useState<string | null>(null);
  const [sourceSelection, setSourceSelection] = useState<Set<string>>(new Set());
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [filterMode, setFilterMode] = useState<"all" | "enabled" | "available">("all");
  // Which channel (`source_type`) a skill came through — git, skills.sh, a
  // site, a local install, an import. Distinct from the Source grouping below.
  const [channelFilters, setChannelFilters] = useState<Set<string>>(new Set());
  const [tagFilters, setTagFilters] = useState<Set<string>>(new Set());
  const [allTags, setAllTags] = useState<string[]>([]);
  // Tag management from the filter bar (#233): right-click a tag pill to
  // rename (dialog) or delete (confirm). Left-click stays "filter only".
  const [tagMenu, setTagMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  const [tagToRename, setTagToRename] = useState<string | null>(null);
  const [tagToDelete, setTagToDelete] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const refreshAfterDeleteRef = useRef<number | null>(null);
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const [batchTagDialogOpen, setBatchTagDialogOpen] = useState(false);
  const [batchSyncDialogOpen, setBatchSyncDialogOpen] = useState(false);
  const [batchToggling, setBatchToggling] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingSkillId, setCheckingSkillId] = useState<string | null>(null);
  const [updatingSkillId, setUpdatingSkillId] = useState<string | null>(null);
  const [batchUpdating, setBatchUpdating] = useState(false);
  const [toolToggles, setToolToggles] = useState<SkillToolToggle[] | null>(null);
  const [togglingToolKey, setTogglingToolKey] = useState<string | null>(null);
  const [togglingTarget, setTogglingTarget] = useState<{ skillId: string; tool: string } | null>(null);
  const [menuSkillId, setMenuSkillId] = useState<string | null>(null);
  const [skillToDelete, setSkillToDelete] = useState<ManagedSkill | null>(null);
  const [skillToRename, setSkillToRename] = useState<ManagedSkill | null>(null);
  const [lineageDuplicates, setLineageDuplicates] = useState<api.LineageDuplicate[]>([]);
  const [dismissedLineage, setDismissedLineage] = useState<Set<string>>(loadDismissedLineage);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  const [presetSkillOrder, setPresetSkillOrder] = useState<string[]>([]);

  // `/my-skills` is the whole Library; `?preset=<id>` scopes it to one preset.
  const viewedPresetId = viewedPresetIdFrom(location.pathname, location.search);
  const viewedPreset = useMemo(
    () => presets.find((preset) => preset.id === viewedPresetId) ?? null,
    [presets, viewedPresetId]
  );

  // Fetch sort order whenever active preset changes
  useEffect(() => {
    if (!viewedPreset) {
      setPresetSkillOrder([]);
      return;
    }
    api.getPresetSkillOrder(viewedPreset.id).then(setPresetSkillOrder).catch(() => {});
  }, [viewedPreset, skills]);

  // Skills with an unresolved sync conflict get a "needs attention" badge
  // that jumps to the Backup page (merge-engine design §4 UI).
  const [conflictIds, setConflictIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    api.gitBackupPendingConflicts()
      .then((rows) => setConflictIds(new Set(rows.map((row) => row.skill_id))))
      .catch(() => setConflictIds(new Set()));
  }, [skills]);

  const refreshAllTags = async () => {
    try {
      const tags = await api.getAllTags();
      setAllTags(tags);
    } catch {
      // not critical
    }
  };

  useEffect(() => {
    refreshAllTags();
  }, [skills]);

  // Prune tag filters whose pill disappeared (e.g. its last skill was deleted),
  // otherwise a stale filter silently hides everything. An empty skill list
  // says nothing about which tags are valid, so wait for one before pruning.
  // A tag still carried by a loaded skill counts as available even when it is
  // missing from `allTags`: that list is refetched asynchronously and lags
  // `skills`, and in that window a rename would otherwise drop the filter that
  // `replaceTagInFilters` just moved onto the new name.
  useEffect(() => {
    if (skills.length === 0) return;
    const hasUntagged = skills.some((skill) => skill.tags.length === 0);
    const available = [...allTags, ...skills.flatMap((skill) => skill.tags)];
    setTagFilters((prev) => pruneStaleTagFilters(prev, available, hasUntagged));
  }, [allTags, skills]);

  // Close the tag context menu on Escape (click-outside is handled by its backdrop).
  useEffect(() => {
    if (!tagMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tagMenu]);

  const toggleFilter = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  // A filter can outlive the control that set it (the tag row hides itself once
  // no tag is left), so the empty state carries the way out. `filterMode` is
  // reset too — its control never hides, but a button labelled "clear filters"
  // that leaves one of them on is a lie.
  const hasActiveFilters =
    search.trim() !== "" ||
    channelFilters.size > 0 ||
    tagFilters.size > 0 ||
    sourceSelection.size > 0 ||
    filterMode !== "all";
  const clearFilters = () => {
    setSearch("");
    setChannelFilters(new Set());
    setTagFilters(new Set());
    setSourceSelection(new Set());
    setFilterMode("all");
  };

  const skillDisplayNames = useMemo(() => {
    const nameCounts = new Map<string, number>();
    for (const skill of skills) {
      nameCounts.set(skill.name, (nameCounts.get(skill.name) || 0) + 1);
    }

    const displayNames = new Map<string, string>();
    for (const skill of skills) {
      const dirName = centralDirName(skill);
      displayNames.set(
        skill.id,
        (nameCounts.get(skill.name) || 0) > 1 && dirName !== skill.name
          ? dirName
          : skill.name
      );
    }
    return displayNames;
  }, [skills]);

  const { filtered, sourceCandidates } = useMemo(() => {
    const query = normalizeSkillSearch(search);
    const result = skills.filter((skill) => {
      const displayName = skillDisplayNames.get(skill.id) || skill.name;
      const matchesSearch = skillSearchMatches(query, [
        skill.name,
        displayName,
        centralDirName(skill),
        skill.description,
      ]);
      if (!matchesSearch) return false;

      if (channelFilters.size > 0 && !channelFilters.has(skill.source_type)) return false;

      if (tagFilters.size > 0) {
        const wantUntagged = tagFilters.has(UNTAGGED_FILTER);
        const matchUntagged = wantUntagged && skill.tags.length === 0;
        const matchTag = skill.tags.some((t) => tagFilters.has(t));
        if (!matchUntagged && !matchTag) return false;
      }

      if (!viewedPreset) return true;

      const enabledInPreset = skill.preset_ids.includes(viewedPreset.id);
      if (filterMode === "enabled") return enabledInPreset;
      if (filterMode === "available") return !enabledInPreset;
      return true;
    });

    // Always sort enabled skills first; within enabled group, use custom sort order
    if (viewedPreset) {
      result.sort((a, b) => {
        const aEnabled = a.preset_ids.includes(viewedPreset.id) ? 0 : 1;
        const bEnabled = b.preset_ids.includes(viewedPreset.id) ? 0 : 1;
        if (aEnabled !== bEnabled) return aEnabled - bEnabled;
        // Within same group, use preset sort order
        const aOrder = presetSkillOrder.indexOf(a.id);
        const bOrder = presetSkillOrder.indexOf(b.id);
        if (aOrder !== -1 && bOrder !== -1) return aOrder - bOrder;
        if (aOrder !== -1) return -1;
        if (bOrder !== -1) return 1;
        return a.name.localeCompare(b.name);
      });
    }

    // Candidates, and the grouping to reuse below, come from the result
    // *before* the source selection is applied. Otherwise picking a source
    // would remove the others from the menu the user needs in order to switch
    // sources.
    const groups = buildSourceGroups(result);
    const candidates = groups.map(({ key, label, count }) => ({ key, label, count }));

    if (sourceSelection.size === 0) {
      return { filtered: result, sourceCandidates: candidates };
    }

    return {
      filtered: result.filter((skill) => sourceSelection.has(getSkillSourceInfo(skill).key)),
      sourceCandidates: candidates,
    };
  }, [skills, skillDisplayNames, search, channelFilters, tagFilters, sourceSelection, filterMode, viewedPreset, presetSkillOrder]);

  // Bundles come from the whole library, so filtering never moves a skill out
  // of its bundle; only the skills on screen are listed under each heading.
  const bundleIndex = useMemo(() => buildBundleIndex(skills), [skills]);

  // A group stays open while the user is searching: a query that matched
  // something inside a folded group would otherwise look like no match at all.
  const searching = search.trim() !== "";
  const sourceRows = useMemo<SkillListRow[]>(() => {
    if (!groupBySource) {
      return filtered.map((skill) => ({ kind: "skill", skill }) as SkillListRow);
    }
    const sections = groupIntoBundles(filtered, (skill) => getSkillSourceInfo(skill).key, bundleIndex);
    // With no bundle on screen, an "Ungrouped" heading over everything says nothing.
    const showHeader = sections.some((section) => section.bundle !== null);
    const rows: SkillListRow[] = [];
    for (const section of sections) {
      const expanded = !showHeader || searching || (groupOpen[section.key] ?? true);
      rows.push({ kind: "group", section, expanded, showHeader });
      if (expanded) {
        for (const skill of section.items) rows.push({ kind: "skill", skill });
      }
    }
    return rows;
  }, [filtered, groupBySource, bundleIndex, groupOpen, searching]);

  const {
    isMultiSelect, setIsMultiSelect,
    selectedIds,
    toggleSelect,
    isAllSelected,
    anyDisabled,
    handleSelectAll,
    exitMultiSelect,
  } = useMultiSelect({
    items: skills,
    // Collapsing a group is a display choice, so the selection still covers the
    // whole filtered list: select-all and bulk delete must not be bounded by
    // which groups happen to be open.
    filtered,
    getKey: (s) => s.id,
    isItemActive: (s) => viewedPreset ? s.preset_ids.includes(viewedPreset.id) : true,
    filterSignal: JSON.stringify([
      search,
      [...channelFilters].sort(),
      [...tagFilters].sort(),
      [...sourceSelection].sort(),
      filterMode,
      viewedPreset?.id ?? null,
    ]),
    escapeEnabled: !batchTagDialogOpen && !batchSyncDialogOpen && !batchDeleteConfirm,
  });

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === detailSkillId) || null,
    [detailSkillId, skills]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !viewedPreset) return;

      // Only reorder enabled skills (they are always at the front)
      const enabledSkills = filtered.filter((s) => s.preset_ids.includes(viewedPreset.id));
      const oldIndex = enabledSkills.findIndex((s) => s.id === active.id);
      const newIndex = enabledSkills.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...enabledSkills];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      // Optimistic update
      setPresetSkillOrder(reordered.map((s) => s.id));

      try {
        await api.reorderPresetSkills(viewedPreset.id, reordered.map((s) => s.id));
      } catch {
        // Revert on failure
        await api.getPresetSkillOrder(viewedPreset.id).then(setPresetSkillOrder).catch(() => {});
      }
    },
    [filtered, viewedPreset]
  );

  // Grouped order is source order, not the preset's order, so dragging would
  // move a skill to a position the user cannot see.
  const canDrag = !!viewedPreset && !groupBySource;

  useEffect(() => {
    let cancelled = false;
    const loadToggles = async () => {
      if (!selectedSkill || !viewedPreset) {
        setToolToggles(null);
        return;
      }
      if (!selectedSkill.preset_ids.includes(viewedPreset.id)) {
        setToolToggles(null);
        return;
      }
      try {
        const toggles = await api.getSkillToolToggles(selectedSkill.id, viewedPreset.id);
        if (!cancelled) setToolToggles(toggles);
      } catch {
        if (!cancelled) setToolToggles(null);
      }
    };
    loadToggles();
    return () => {
      cancelled = true;
    };
  }, [selectedSkill, viewedPreset]);

  const handleToggleSkillTool = async (toolKey: string, enabled: boolean) => {
    if (!selectedSkill || !viewedPreset) return;
    setTogglingToolKey(toolKey);
    try {
      await api.setSkillToolToggle(selectedSkill.id, viewedPreset.id, toolKey, enabled);
      const displayName = getToolDisplayName(toolKey, tools);
      toast.success(
        enabled
          ? t("mySkills.agentToggleEnabled", { agent: displayName })
          : t("mySkills.agentToggleDisabled", { agent: displayName })
      );
      const [, toggles] = await Promise.all([
        refreshManagedSkills(),
        api.getSkillToolToggles(selectedSkill.id, viewedPreset.id),
      ]);
      setToolToggles(toggles);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      await refreshManagedSkills();
    } finally {
      setTogglingToolKey(null);
    }
  };

  const handleToggleSkillTarget = useCallback(
    async (skill: ManagedSkill, toolKey: string, enabled: boolean) => {
      if (togglingTarget) return;
      setTogglingTarget({ skillId: skill.id, tool: toolKey });
      const displayName = getToolDisplayName(toolKey, tools);
      try {
        if (enabled) {
          await api.syncSkillToTool(skill.id, toolKey);
          toast.success(t("mySkills.targetInstalled", { name: skill.name, agent: displayName }));
        } else {
          await api.unsyncSkillFromTool(skill.id, toolKey);
          toast.success(t("mySkills.targetUninstalled", { name: skill.name, agent: displayName }));
        }
        await refreshManagedSkills();
      } catch (error: unknown) {
        toast.error(getErrorMessage(error, t("common.error")));
        await refreshManagedSkills();
      } finally {
        setTogglingTarget(null);
      }
    },
    [togglingTarget, tools, t, refreshManagedSkills]
  );

  const scheduleRefreshAfterDelete = useCallback(() => {
    if (refreshAfterDeleteRef.current !== null) {
      window.clearTimeout(refreshAfterDeleteRef.current);
    }
    refreshAfterDeleteRef.current = window.setTimeout(() => {
      refreshAfterDeleteRef.current = null;
      void Promise.all([refreshManagedSkills(), refreshPresets()]);
    }, 300);
  }, [refreshManagedSkills, refreshPresets]);

  useEffect(() => {
    return () => {
      if (refreshAfterDeleteRef.current !== null) {
        window.clearTimeout(refreshAfterDeleteRef.current);
      }
    };
  }, []);

  const handleDeleteSkill = useCallback(
    (skill: ManagedSkill) => {
      setDeletingIds((prev) => {
        if (prev.has(skill.id)) return prev;
        const next = new Set(prev);
        next.add(skill.id);
        return next;
      });
      void (async () => {
        try {
          await api.deleteManagedSkill(skill.id);
          if (selectedSkill?.id === skill.id) closeSkillDetail();
          toast.success(`${skill.name} ${t("mySkills.deleted")}`);
        } catch (error: unknown) {
          toast.error(getErrorMessage(error, t("common.error")));
        } finally {
          setDeletingIds((prev) => {
            if (!prev.has(skill.id)) return prev;
            const next = new Set(prev);
            next.delete(skill.id);
            return next;
          });
          scheduleRefreshAfterDelete();
        }
      })();
    },
    [selectedSkill, closeSkillDetail, t, scheduleRefreshAfterDelete]
  );

  // Imported skills that a source-backed install duplicated. Recomputed from
  // the database whenever the library changes; it is a cheap query.
  useEffect(() => {
    let cancelled = false;
    api
      .findLineageDuplicates()
      .then((found) => {
        if (!cancelled) setLineageDuplicates(found);
      })
      .catch(() => {
        if (!cancelled) setLineageDuplicates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [skills]);

  const visibleLineageDuplicates = useMemo(
    () => lineageDuplicates.filter((d) => !dismissedLineage.has(lineageDuplicateKey(d))),
    [lineageDuplicates, dismissedLineage]
  );

  useEffect(() => {
    if (linkDialogOpen && visibleLineageDuplicates.length === 0) setLinkDialogOpen(false);
  }, [linkDialogOpen, visibleLineageDuplicates.length]);

  // The install page links here when an install duplicated an imported skill.
  const openLineageRequested =
    (location.state as { openLineage?: boolean } | null)?.openLineage === true;
  useEffect(() => {
    if (openLineageRequested && visibleLineageDuplicates.length > 0) {
      setLinkDialogOpen(true);
      // Keep `?preset=`: it is what scopes the Library view.
      navigate(
        { pathname: location.pathname, search: location.search },
        { replace: true, state: null }
      );
    }
  }, [
    openLineageRequested,
    visibleLineageDuplicates.length,
    navigate,
    location.pathname,
    location.search,
  ]);

  const handleDismissLineage = (duplicate: api.LineageDuplicate) => {
    setDismissedLineage((prev) => {
      const next = new Set(prev);
      next.add(lineageDuplicateKey(duplicate));
      saveDismissedLineage(next);
      return next;
    });
  };

  const handleLinkLineage = async (duplicate: api.LineageDuplicate) => {
    try {
      const result = await api.mergeSkillLineage(duplicate.keep.id, duplicate.source.id);
      if (selectedSkill?.id === duplicate.source.id) closeSkillDetail();
      if (result.previous_content_path) {
        toast.success(t("mySkills.lineage.linkedReplaced", { name: result.name }), {
          description: result.previous_content_path,
        });
      } else {
        toast.success(t("mySkills.lineage.linked", { name: result.name }));
      }
      await Promise.all([refreshManagedSkills(), refreshPresets()]);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      throw error;
    }
  };

  const handleRenameSkill = async (newFolder: string) => {
    const skill = skillToRename;
    if (!skill) return;
    try {
      const result = await api.renameManagedSkill(skill.id, newFolder);
      if (result.redeploy_failures.length > 0) {
        toast.warning(t("mySkills.rename.partial", { count: result.redeploy_failures.length }), {
          description: result.redeploy_failures.join("\n"),
        });
      } else {
        toast.success(t("mySkills.rename.done", { folder: result.folder }));
      }
      await refreshManagedSkills();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      throw error;
    }
  };

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds);
    try {
      const result = await api.deleteManagedSkills(ids);
      if (selectedSkill && ids.includes(selectedSkill.id) && !result.failed.includes(selectedSkill.id)) {
        closeSkillDetail();
      }
      if (result.deleted > 0) {
        toast.success(t("mySkills.batchDeleted", { count: result.deleted }));
      }
      if (result.failed.length > 0) {
        toast.error(t("mySkills.batchDeleteFailed", { count: result.failed.length }));
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      exitMultiSelect();
      setBatchDeleteConfirm(false);
      await Promise.all([refreshManagedSkills(), refreshPresets()]);
    }
  };

  const handleBatchEditTags = async (adds: string[], removes: string[]) => {
    const selectedSkillsList = skills.filter((s) => selectedIds.has(s.id));
    let updated = 0;
    let failed = 0;
    for (const skill of selectedSkillsList) {
      const removeSet = new Set(removes);
      const remaining = skill.tags.filter((tag) => !removeSet.has(tag));
      const merged = [...remaining];
      for (const tag of adds) {
        if (!merged.includes(tag)) merged.push(tag);
      }
      const changed =
        merged.length !== skill.tags.length ||
        merged.some((tag, i) => tag !== skill.tags[i]);
      if (!changed) continue;
      try {
        await api.setSkillTags(skill.id, merged);
        updated++;
      } catch {
        failed++;
      }
    }
    if (updated > 0) {
      toast.success(t("mySkills.batchTagsUpdated", { count: updated }));
    }
    if (failed > 0) {
      toast.error(t("mySkills.batchTagsFailed", { count: failed }));
    }
    await refreshManagedSkills();
    await refreshAllTags();
  };

  const handleBatchTogglePreset = async () => {
    if (!viewedPreset || batchToggling) return;
    const enabling = anyDisabled;
    let count = 0;
    let failed = 0;
    setBatchToggling(true);
    try {
      for (const skill of togglableSelectedSkills) {
        try {
          if (enabling) {
            await api.addSkillToPreset(skill.id, viewedPreset.id);
          } else {
            await api.removeSkillFromPreset(skill.id, viewedPreset.id);
          }
          count++;
        } catch {
          failed++;
          // continue with remaining
        }
      }
      if (count > 0) {
        toast.success(enabling
          ? t("mySkills.batchEnabled", { count })
          : t("mySkills.batchDisabled", { count }));
      }
      if (failed > 0) {
        toast.error(t("mySkills.batchToggleFailed", { count: failed }));
      }
      await Promise.all([refreshManagedSkills(), refreshPresets()]);
    } finally {
      setBatchToggling(false);
    }
  };

  const handleBatchSyncAgents = async (agentKeys: string[]) => {
    const selectedSkillsList = skills.filter((s) => selectedIds.has(s.id));
    let synced = 0;
    let failed = 0;
    for (const skill of selectedSkillsList) {
      for (const agentKey of agentKeys) {
        if (skill.targets.some((target) => target.tool === agentKey)) continue;
        try {
          await api.syncSkillToTool(skill.id, agentKey);
          synced++;
        } catch {
          failed++;
        }
      }
    }
    if (synced > 0) {
      toast.success(t("mySkills.batchSynced", { count: synced }));
    }
    if (failed > 0) {
      toast.error(t("mySkills.batchSyncFailed", { count: failed }));
    }
    await Promise.all([refreshManagedSkills(), refreshTools()]);
  };

  const handleBatchRefresh = async () => {
    const refreshableSkills = skills.filter((skill) => selectedIds.has(skill.id) && canRefresh(skill));
    if (refreshableSkills.length === 0) return;

    setBatchUpdating(true);
    try {
      const result = await api.batchUpdateSkills(refreshableSkills.map((skill) => skill.id));
      if (result.refreshed > 0) {
        toast.success(t("mySkills.batchUpdated", { count: result.refreshed }));
      }
      if (result.unchanged > 0) {
        toast.info(t("mySkills.batchAlreadyUpToDate", { count: result.unchanged }));
      }
      if (result.held_back.length > 0) {
        toast.warning(
          t("mySkills.batchHeldBack", {
            count: result.held_back.length,
            names: result.held_back.slice(0, 3).join("、"),
          })
        );
      }
      if (result.failed.length > 0) {
        toast.error(t("mySkills.batchUpdateFailed", { count: result.failed.length }));
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      await refreshManagedSkills();
      setBatchUpdating(false);
    }
  };

  /** The update the user has been asked to confirm, and what it would remove. */
  const [pendingRemoval, setPendingRemoval] = useState<{
    skill: ManagedSkill;
    removals: api.PendingRemoval[];
    approval: string | null;
    /** Set when the pending replacement is a relink, so confirming re-uses the
     *  directory the user already chose instead of asking for it again. */
    relinkSource?: string;
  } | null>(null);

  const handleUpdateAvailableSkills = async () => {
    const updatableSkills = skills.filter(
      (skill) => skill.update_status === "update_available" && canRefresh(skill)
    );
    if (updatableSkills.length === 0) return;

    setBatchUpdating(true);
    try {
      const result = await api.batchUpdateSkills(updatableSkills.map((skill) => skill.id));
      if (result.refreshed > 0) {
        toast.success(t("mySkills.batchUpdated", { count: result.refreshed }));
      }
      if (result.unchanged > 0) {
        toast.info(t("mySkills.batchAlreadyUpToDate", { count: result.unchanged }));
      }
      if (result.held_back.length > 0) {
        toast.warning(
          t("mySkills.batchHeldBack", {
            count: result.held_back.length,
            names: result.held_back.slice(0, 3).join("、"),
          })
        );
      }
      if (result.failed.length > 0) {
        toast.error(t("mySkills.batchUpdateFailed", { count: result.failed.length }));
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      await refreshManagedSkills();
      setBatchUpdating(false);
    }
  };

  const handleTogglePreset = async (skill: ManagedSkill) => {
    if (!viewedPreset) return;
    const enabledInPreset = skill.preset_ids.includes(viewedPreset.id);
    if (enabledInPreset) {
      await api.removeSkillFromPreset(skill.id, viewedPreset.id);
      toast.success(`${skill.name} ${t("mySkills.disabledInPreset")}`);
    } else {
      await api.addSkillToPreset(skill.id, viewedPreset.id);
      toast.success(`${skill.name} ${t("mySkills.enabledInPreset")}`);
    }
    await Promise.all([refreshManagedSkills(), refreshPresets()]);
  };

  /**
   * Turns a whole bundle on or off in the viewed preset: on enables the skills
   * that are still off, off disables the ones that are on, including skills
   * a filter hides.
   */
  const handleToggleGroupInPreset = (groupKey: string, groupSkills: ManagedSkill[]) => {
    if (!viewedPreset) return;
    const enabling = groupSkills.some((skill) => !skill.preset_ids.includes(viewedPreset.id));
    return handleSetSkillsInPreset(groupKey, groupSkills, enabling);
  };

  /**
   * Adds every given skill to the viewed preset, or removes every one, skipping
   * those already in the wanted state. `busyKey` marks which control is working.
   */
  const handleSetSkillsInPreset = async (busyKey: string, candidates: ManagedSkill[], enabling: boolean) => {
    if (!viewedPreset || togglingGroupKey) return;
    const targets = candidates.filter(
      (skill) => skill.preset_ids.includes(viewedPreset.id) !== enabling
    );
    if (targets.length === 0) return;
    let count = 0;
    let failed = 0;
    setTogglingGroupKey(busyKey);
    try {
      for (const skill of targets) {
        try {
          if (enabling) await api.addSkillToPreset(skill.id, viewedPreset.id);
          else await api.removeSkillFromPreset(skill.id, viewedPreset.id);
          count++;
        } catch {
          failed++;
        }
      }
      if (count > 0) {
        toast.success(enabling
          ? t("mySkills.batchEnabled", { count })
          : t("mySkills.batchDisabled", { count }));
      }
      if (failed > 0) {
        toast.error(t("mySkills.batchToggleFailed", { count: failed }));
      }
      await Promise.all([refreshManagedSkills(), refreshPresets()]);
    } finally {
      setTogglingGroupKey(null);
    }
  };

  const handleCheckAllUpdates = async () => {
    setCheckingAll(true);
    try {
      await api.checkAllSkillUpdates(true);
      toast.success(t("mySkills.updateActions.checkedAll"));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      await refreshManagedSkills();
      setCheckingAll(false);
    }
  };

  const handleCheckUpdate = async (skill: ManagedSkill) => {
    setCheckingSkillId(skill.id);
    try {
      await api.checkSkillUpdate(skill.id, true);
      await refreshManagedSkills();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      await refreshManagedSkills();
    } finally {
      setCheckingSkillId(null);
    }
  };

  const handleRefreshSkill = async (skill: ManagedSkill, approvedRemovals?: string) => {
    setUpdatingSkillId(skill.id);
    try {
      if (skill.source_type === "local" || skill.source_type === "import") {
        const result = await api.reimportLocalSkill(skill.id, approvedRemovals);
        if (result.pending_removals.length > 0) {
          setPendingRemoval({
            skill,
            removals: result.pending_removals,
            approval: result.removal_approval,
          });
          return;
        }
        toast.success(t("mySkills.updateActions.reimported"));
      } else {
        const result = await api.updateSkill(skill.id, approvedRemovals);
        // Nothing was changed: the update would have taken away files the new
        // version does not have. Show them and let the user decide (#256).
        if (result.pending_removals.length > 0) {
          setPendingRemoval({
            skill,
            removals: result.pending_removals,
            approval: result.removal_approval,
          });
          return;
        }
        if (result.content_changed) {
          toast.success(t("mySkills.updateActions.updated"));
        } else {
          toast.info(t("mySkills.updateActions.alreadyUpToDate"));
        }
      }
      await refreshManagedSkills();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      await refreshManagedSkills();
    } finally {
      setUpdatingSkillId(null);
    }
  };

  const handleRelinkSource = async (
    skill: ManagedSkill,
    presetSource?: string,
    approvedRemovals?: string,
  ) => {
    const selected =
      presetSource ?? (await dialogOpen({ directory: true, multiple: false }));
    if (!selected || Array.isArray(selected)) return;

    setUpdatingSkillId(skill.id);
    try {
      const result = await api.relinkLocalSkillSource(
        skill.id,
        selected,
        approvedRemovals,
      );
      if (result.pending_removals.length > 0) {
        setPendingRemoval({
          skill,
          removals: result.pending_removals,
          approval: result.removal_approval,
          relinkSource: selected,
        });
        return;
      }
      toast.success(t("mySkills.updateActions.relinked"));
      await refreshManagedSkills();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      await refreshManagedSkills();
    } finally {
      setUpdatingSkillId(null);
    }
  };

  const handleDetachSource = async (skill: ManagedSkill) => {
    setUpdatingSkillId(skill.id);
    try {
      await api.detachLocalSkillSource(skill.id);
      toast.success(t("mySkills.updateActions.detachedSource"));
      await refreshManagedSkills();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      await refreshManagedSkills();
    } finally {
      setUpdatingSkillId(null);
    }
  };

  // Tag and preset edits from the membership popovers run one at a time, in
  // order: a tag write sends the whole set, so two quick toggles must not race.
  // The library refreshes once, when the popover closes.
  const membershipWritesRef = useRef<Promise<void>>(Promise.resolve());
  const membershipDirtyRef = useRef({ tags: false, presets: false });

  const queueMembershipWrite = (kind: "tags" | "presets", write: () => Promise<unknown>) => {
    membershipDirtyRef.current[kind] = true;
    membershipWritesRef.current = membershipWritesRef.current
      .then(write)
      .then(
        () => undefined,
        (error: unknown) => {
          toast.error(getErrorMessage(error, t("common.error")));
        }
      );
  };

  const handleMembershipPopoverOpenChange = (skillId: string, open: boolean) => {
    setMenuSkillId((current) => (open ? skillId : current === skillId ? null : current));
    if (open) return;
    const dirty = membershipDirtyRef.current;
    if (!dirty.tags && !dirty.presets) return;
    const withPresets = dirty.presets;
    membershipDirtyRef.current = { tags: false, presets: false };
    const written = pendingTags[skillId];
    membershipWritesRef.current = membershipWritesRef.current.then(async () => {
      await Promise.all([refreshManagedSkills(), withPresets ? refreshPresets() : Promise.resolve()]);
      // Keep a set a later edit replaced; that edit's own refresh clears it.
      setPendingTags((prev) => {
        if (!(skillId in prev) || prev[skillId] !== written) return prev;
        const rest = { ...prev };
        delete rest[skillId];
        return rest;
      });
    });
  };

  // The newest tag set per skill until the refresh after it lands, so a popover
  // reopened in between starts from what was written, not from stale props.
  const [pendingTags, setPendingTags] = useState<Record<string, string[]>>({});

  const handleSkillTagsChange = (skill: ManagedSkill, next: string[]) => {
    setPendingTags((prev) => ({ ...prev, [skill.id]: next }));
    queueMembershipWrite("tags", () => api.setSkillTags(skill.id, next));
  };

  const handleSkillPresetChange = (skill: ManagedSkill, presetId: string, checked: boolean) =>
    queueMembershipWrite("presets", () =>
      checked ? api.addSkillToPreset(skill.id, presetId) : api.removeSkillFromPreset(skill.id, presetId)
    );

  // Replace `oldTag` with `newTag` in the active filter set so the current
  // filtering survives a rename/delete.
  const replaceTagInFilters = (oldTag: string, newTag?: string) =>
    setTagFilters((prev) => {
      if (!prev.has(oldTag)) return prev;
      const next = new Set(prev);
      next.delete(oldTag);
      if (newTag) next.add(newTag);
      return next;
    });

  // Throws on failure so the rename dialog stays open (it only closes after a
  // resolved onRename), matching how RenamePresetDialog behaves.
  const handleRenameTag = async (newName: string) => {
    const oldName = tagToRename;
    if (oldName === null) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    try {
      await api.renameTag(oldName, trimmed);
      replaceTagInFilters(oldName, trimmed);
      toast.success(t("mySkills.tags.tagRenamed"));
      await refreshManagedSkills();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
      throw error;
    }
  };

  const handleDeleteTag = async () => {
    const tag = tagToDelete;
    if (tag === null) return;
    try {
      await api.deleteTag(tag);
      replaceTagInFilters(tag);
      toast.success(t("mySkills.tags.tagDeleted"));
      await refreshManagedSkills();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("common.error")));
    }
  };

  const sourceIcon = (type: string) => {
    switch (type) {
      case "git":
      case "skillssh":
        return <Github className="h-3 w-3" />;
      case "local":
      case "import":
        return <HardDrive className="h-3 w-3" />;
      default:
        return <Globe className="h-3 w-3" />;
    }
  };

  const canRefresh = (skill: ManagedSkill) =>
    skill.source_type === "git" ||
    skill.source_type === "skillssh" ||
    ((skill.source_type === "local" || skill.source_type === "import") && !!skill.source_ref);

  const anyRefreshableSelected = useMemo(
    () => skills.some((skill) => selectedIds.has(skill.id) && canRefresh(skill)),
    [skills, selectedIds]
  );
  const availableUpdateCount = useMemo(
    () => skills.filter((skill) => skill.update_status === "update_available" && canRefresh(skill)).length,
    [skills]
  );
  const refreshableSelectedCount = useMemo(
    () => skills.filter((skill) => selectedIds.has(skill.id) && canRefresh(skill)).length,
    [skills, selectedIds]
  );
  /**
   * Only the selected skills the toggle would actually change — a mixed selection
   * enables the ones that are off, so the button must not count the rest.
   */
  const togglableSelectedSkills = useMemo(() => {
    if (!viewedPreset) return [];
    const enabling = anyDisabled;
    return skills.filter((skill) => {
      if (!selectedIds.has(skill.id)) return false;
      return skill.preset_ids.includes(viewedPreset.id) !== enabling;
    });
  }, [skills, selectedIds, viewedPreset, anyDisabled]);

  const sourceTypeLabel = (skill: ManagedSkill) =>
    skill.source_type === "skillssh" ? "skills.sh" : skill.source_type;

  const refreshLabel = (skill: ManagedSkill) =>
    skill.source_type === "local" || skill.source_type === "import"
      ? t("mySkills.updateActions.reimport")
      : t("mySkills.updateActions.update");

  const tagItems = useMemo(() => allTags.map((tag) => ({ id: tag, label: tag })), [allTags]);
  const presetItems = useMemo(
    () =>
      presets.map((preset) => {
        const option = getPresetIconOption(preset);
        const Icon = option.icon;
        return {
          id: preset.id,
          label: preset.name,
          icon: <Icon className={cn("h-3.5 w-3.5 shrink-0", option.colorClass)} />,
        };
      }),
    [presets]
  );

  /** The multi-select checkbox, in the slot the drag grip uses outside selection. */
  const renderSelectionMark = (skillId: string, placement: "card" | "row") => {
    const selected = selectedIds.has(skillId);
    return (
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-2.5 z-10 flex h-5 w-5 items-center justify-center rounded-md border bg-surface shadow-sm",
          placement === "card" ? "top-3" : "top-1/2 -translate-y-1/2",
          selected ? "border-accent/40" : "border-border"
        )}
      >
        {selected
          ? <SquareCheck className="h-3.5 w-3.5 text-accent" />
          : <Square className="h-3.5 w-3.5 text-faint" />}
      </span>
    );
  };

  /**
   * The tag editor trigger. A skill with no tags shows a dashed "+ Tag" slot,
   * so the first tag is as discoverable as the rest; a tagged skill shows its
   * pills and a quiet "+" that opens the same editor.
   */
  const renderTagsControl = (skill: ManagedSkill, variant: "card" | "row") => {
    const pills = variant === "row" ? skill.tags.slice(0, 2) : skill.tags;
    const overflow = skill.tags.length - pills.length;
    return (
      <MembershipPopover
        items={tagItems}
        selected={pendingTags[skill.id] ?? skill.tags}
        onChange={(next) => handleSkillTagsChange(skill, next)}
        onOpenChange={(open) => handleMembershipPopoverOpenChange(skill.id, open)}
        allowCreate
        disabled={isMultiSelect}
        label={t("mySkills.tags.manage")}
        searchPlaceholder={t("mySkills.tags.searchOrCreate")}
        emptyLabel={t("mySkills.tags.noMatch")}
        createLabel={(name) => t("mySkills.tags.create", { name })}
        triggerClassName={cn(
          "group/tags inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 rounded-full text-left",
          variant === "row" && "flex-nowrap"
        )}
      >
        {pills.map((tag) => (
          <span
            key={tag}
            className={cn(
              "inline-flex max-w-[120px] items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium",
              getTagColor(tag, allTags)
            )}
          >
            {tag}
          </span>
        ))}
        {overflow > 0 && (
          <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[11px] font-medium text-muted">
            +{overflow}
          </span>
        )}
        {skill.tags.length === 0 ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] font-medium text-muted transition-colors group-hover/tags:border-accent-border group-hover/tags:text-secondary",
              variant === "row" && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            )}
          >
            <Plus className="h-2.5 w-2.5" />
            {t("mySkills.tags.addFirst")}
          </span>
        ) : variant === "card" ? (
          <span className="inline-flex h-[18px] items-center rounded-full px-1 text-faint transition-colors group-hover:text-muted group-hover/tags:text-secondary">
            <Plus className="h-3 w-3" />
          </span>
        ) : null}
      </MembershipPopover>
    );
  };

  /** Which presets a skill belongs to, editable in place. */
  const renderPresetsControl = (skill: ManagedSkill, variant: "card" | "row") => {
    const memberPresets = presets.filter((preset) => skill.preset_ids.includes(preset.id));
    // The viewed preset leads, so the chip answers "is it in this one?" first.
    const lead =
      memberPresets.find((preset) => preset.id === viewedPreset?.id) ?? memberPresets[0] ?? null;
    const leadIcon = lead ? getPresetIconOption(lead) : null;
    const LeadIcon = leadIcon?.icon;
    if (presets.length === 0) return null;
    return (
      <MembershipPopover
        items={presetItems}
        selected={skill.preset_ids}
        onChange={(_next, presetId, checked) => handleSkillPresetChange(skill, presetId, checked)}
        onOpenChange={(open) => handleMembershipPopoverOpenChange(skill.id, open)}
        disabled={isMultiSelect}
        label={
          memberPresets.length > 0
            ? t("mySkills.presets.manageWith", { presets: memberPresets.map((p) => p.name).join(", ") })
            : t("mySkills.presets.manage")
        }
        searchPlaceholder={t("mySkills.presets.search")}
        emptyLabel={t("mySkills.presets.none")}
        triggerClassName="group/presets inline-flex min-w-0 shrink items-center gap-1 rounded-full"
      >
        {lead && LeadIcon ? (
          <>
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 font-medium text-secondary transition-colors group-hover/presets:bg-surface-active",
                variant === "row" ? "max-w-[140px] text-[12px]" : "max-w-[160px] text-[12px]"
              )}
            >
              <LeadIcon className={cn("h-3 w-3 shrink-0", leadIcon.colorClass)} />
              <span className="truncate">{lead.name}</span>
            </span>
            {memberPresets.length > 1 && (
              <span className="shrink-0 rounded-full bg-surface-hover px-1.5 py-0.5 text-[11px] font-medium text-muted">
                +{memberPresets.length - 1}
              </span>
            )}
          </>
        ) : (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] font-medium text-muted transition-colors group-hover/presets:border-accent-border group-hover/presets:text-secondary",
              variant === "row" && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            )}
          >
            <Plus className="h-2.5 w-2.5" />
            {t("mySkills.presets.add")}
          </span>
        )}
      </MembershipPopover>
    );
  };

  const statusBadge = (skill: ManagedSkill) => {
    if (skill.update_status === "update_available") {
      return {
        label: "Update",
        className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      };
    }
    if (skill.update_status === "source_missing") {
      return {
        label: t("mySkills.updateStatus.sourceMissing"),
        className: "bg-red-500/10 text-red-600 dark:text-red-300",
      };
    }
    if (skill.update_status === "error") {
      return {
        label: t("mySkills.updateStatus.error"),
        className: "bg-red-500/10 text-red-600 dark:text-red-300",
      };
    }
    return null;
  };

  return (
    <div className="app-page">
      <div className="app-page-header pr-2 pb-1">
        {viewedPreset ? (
          <>
            <h1 className="app-page-title flex items-center gap-2">
              {(() => {
                const option = getPresetIconOption(viewedPreset);
                const Icon = option.icon;
                return <Icon className={cn("h-4 w-4 shrink-0", option.colorClass)} aria-hidden="true" />;
              })()}
              <span className="truncate">{viewedPreset.name}</span>
              <span className="app-badge">{viewedPreset.skill_count}</span>
            </h1>
            <p className="app-page-subtitle">
              {t("mySkills.presetSubtitle", { count: viewedPreset.skill_count, total: skills.length })}
            </p>
          </>
        ) : (
          <h1 className="app-page-title flex items-center gap-2">
            {t("mySkills.title")}
            <span className="app-badge">
              {skills.length}
            </span>
          </h1>
        )}
      </div>

      {visibleLineageDuplicates.length > 0 && (
        <div className="mb-3">
          <StatusBanner
            compact
            title={t("mySkills.lineage.bannerTitle", { count: visibleLineageDuplicates.length })}
            description={t("mySkills.lineage.bannerDescription")}
            actionLabel={t("mySkills.lineage.review")}
            onAction={() => setLinkDialogOpen(true)}
            actionIcon={<Link2 className="h-3.5 w-3.5" />}
          />
        </div>
      )}

      <div className="app-toolbar">
        <div className="flex flex-1 items-center gap-3">
          <div className="relative w-full min-w-[200px] max-w-[280px]">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("mySkills.searchPlaceholder")}
              className="app-input w-full pl-9 font-medium"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          {viewedPreset && (
          <div className="app-segmented app-toolbar-segmented shrink-0">
            {(["all", "enabled", "available"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                className={cn(
                  "app-segmented-button",
                  filterMode === mode && "app-segmented-button-active"
                )}
              >
                {t(`mySkills.filters.${mode}`)}
              </button>
            ))}
          </div>
          )}

        </div>

        {/* Keep all library actions in one toolbar so they wrap together. */}
        <div className="flex items-center gap-3">
          <div className="app-segmented app-toolbar-segmented shrink-0">
            <button
              onClick={handleCheckAllUpdates}
              disabled={checkingAll}
              className="mr-2 inline-flex items-center gap-1 rounded-md px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-secondary disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", checkingAll && "animate-spin")} />
              {t("mySkills.updateActions.checkAll")}
            </button>
            <button
              onClick={handleUpdateAvailableSkills}
              disabled={batchUpdating || availableUpdateCount === 0}
              className="mr-2 inline-flex items-center gap-1 rounded-md px-3 py-2 text-[13px] font-medium text-accent-light transition-colors hover:bg-accent-bg disabled:opacity-50"
            >
              <RotateCcw className={cn("h-3.5 w-3.5", batchUpdating && "animate-spin")} />
              {t("mySkills.updateActions.updateAvailable", { count: availableUpdateCount })}
            </button>
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 self-center bg-border-subtle" />
            <button
              onClick={() => setViewMode("grid")}
              aria-pressed={viewMode === "grid"}
              aria-label={t("mySkills.viewGrid")}
              title={t("mySkills.viewGrid")}
              className={cn(
                "rounded-md p-2 transition-colors outline-none",
                viewMode === "grid" ? "bg-surface-active text-secondary" : "text-muted hover:text-tertiary"
              )}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list"}
              aria-label={t("mySkills.viewList")}
              title={t("mySkills.viewList")}
              className={cn(
                "rounded-md p-2 transition-colors outline-none",
                viewMode === "list" ? "bg-surface-active text-secondary" : "text-muted hover:text-tertiary"
              )}
            >
              <List className="h-4 w-4" />
            </button>
            <button
              onClick={() => setGroupBySource(!groupBySource)}
              aria-pressed={groupBySource}
              className={cn(
                "rounded-md p-2 transition-colors outline-none",
                groupBySource ? "bg-surface-active text-secondary" : "text-muted hover:text-tertiary"
              )}
              title={t("mySkills.groupBySource")}
              aria-label={t("mySkills.groupBySource")}
            >
              <FolderTree className="h-4 w-4" />
            </button>

            {/* Selection can stay active in either view. */}
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 self-center bg-border-subtle" />
            <button
              type="button"
              aria-pressed={isMultiSelect}
              onClick={() => isMultiSelect ? exitMultiSelect() : setIsMultiSelect(true)}
              className={cn(
                "app-segmented-button inline-flex items-center gap-1.5 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-border",
                isMultiSelect && "app-segmented-button-active hover:bg-surface-active hover:text-secondary"
              )}
            >
              <SquareCheck className="h-4 w-4" />
              {isMultiSelect ? t("mySkills.cancelSelect") : t("mySkills.selectMode")}
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 px-1 -mt-2 -mb-3">
        {(["local", "import", "git", "skillssh"] as const).map((channel) => (
          <button
            key={channel}
            onClick={() => setChannelFilters(toggleFilter(channelFilters, channel))}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors",
              channelFilters.has(channel)
                ? "bg-accent text-white dark:bg-accent dark:text-white"
                : "bg-surface-hover text-muted hover:text-secondary"
            )}
          >
            {t(`mySkills.sourceFilter.${channel}`)}
          </button>
        ))}
        {/* Sources are picked from a menu, not rendered as pills: a library can
            hold dozens of repos and directories. */}
        <div className="relative">
          <button
            onClick={() => setSourceMenuOpen((open) => !open)}
            aria-expanded={sourceMenuOpen}
            disabled={sourceCandidates.length === 0}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors disabled:opacity-40",
              sourceSelection.size > 0
                ? "bg-accent text-white dark:bg-accent dark:text-white"
                : "bg-surface-hover text-muted hover:text-secondary"
            )}
          >
            <FolderTree className="h-3 w-3" />
            {t("mySkills.sourcePicker.label")}
            {sourceSelection.size > 0 && ` (${sourceSelection.size})`}
          </button>
          {sourceMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setSourceMenuOpen(false)} />
              {/* overscroll-contain stops a wheel that reaches the end of the
                  list from scrolling the page underneath it. */}
              <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-64 overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface py-1 shadow-2xl">
                {sourceSelection.size > 0 && (
                  <button
                    onClick={() => setSourceSelection(new Set())}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted hover:bg-surface-hover hover:text-secondary"
                  >
                    <X className="h-3 w-3" />
                    {t("mySkills.sourcePicker.clear")}
                  </button>
                )}
                {sourceCandidates.map((candidate) => {
                  const label = candidate.label || t("mySkills.sourcePicker.unknownSource");
                  const checked = sourceSelection.has(candidate.key);
                  return (
                    <button
                      key={candidate.key}
                      onClick={() =>
                        setSourceSelection((prev) => toggleFilter(prev, candidate.key))
                      }
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-secondary hover:bg-surface-hover"
                      title={label}
                    >
                      {checked ? (
                        <SquareCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : (
                        <Square className="h-3.5 w-3.5 shrink-0 text-faint" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <span className="shrink-0 text-[11px] text-faint">{candidate.count}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        {allTags.length > 0 && (
          <>
            <span className="mx-0.5 h-3 w-px bg-border-subtle" />
            {skills.some((s) => s.tags.length === 0) && (() => {
              const isActive = tagFilters.has(UNTAGGED_FILTER);
              return (
                <button
                  onClick={() => setTagFilters(toggleFilter(tagFilters, UNTAGGED_FILTER))}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors",
                    isActive
                      ? "bg-surface-active text-primary"
                      : "border border-dashed border-border text-muted hover:text-secondary"
                  )}
                  title={t("mySkills.tags.untagged")}
                >
                  <CircleSlash className="h-3 w-3" />
                  {t("mySkills.tags.untagged")}
                </button>
              );
            })()}
            {allTags.map((tag) => {
              const isActive = tagFilters.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => setTagFilters(toggleFilter(tagFilters, tag))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTagMenu({
                      tag,
                      x: Math.min(e.clientX, window.innerWidth - 160),
                      y: Math.min(e.clientY, window.innerHeight - 90),
                    });
                  }}
                  title={t("mySkills.tags.manageHint")}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors",
                    isActive ? getTagActiveColor(tag, allTags) : getTagColor(tag, allTags)
                  )}
                >
                  {tag}
                </button>
              );
            })}
          </>
        )}
        {/* With a tag picked in a preset, the shown skills can be switched in one go. */}
        {viewedPreset && tagFilters.size > 0 && !isMultiSelect && (() => {
          const toEnable = filtered.filter((skill) => !skill.preset_ids.includes(viewedPreset.id));
          const toDisable = filtered.filter((skill) => skill.preset_ids.includes(viewedPreset.id));
          const busy = togglingGroupKey !== null;
          const buttonClass =
            "inline-flex items-center gap-1 rounded-full bg-surface-hover px-2.5 py-0.5 text-[12px] font-medium text-secondary transition-colors hover:bg-surface-active disabled:opacity-40 disabled:hover:bg-surface-hover";
          return (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                disabled={busy || toEnable.length === 0}
                onClick={() => handleSetSkillsInPreset(TAG_FILTER_TOGGLE_KEY, toEnable, true)}
                title={t("mySkills.tagFilterEnableAllHint", { count: toEnable.length, preset: viewedPreset.name })}
                className={buttonClass}
              >
                {togglingGroupKey === TAG_FILTER_TOGGLE_KEY
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <CheckCircle2 className="h-3 w-3" />}
                {t("mySkills.tagFilterEnableAll", { count: toEnable.length })}
              </button>
              <button
                type="button"
                disabled={busy || toDisable.length === 0}
                onClick={() => handleSetSkillsInPreset(TAG_FILTER_TOGGLE_KEY, toDisable, false)}
                title={t("mySkills.tagFilterDisableAllHint", { count: toDisable.length, preset: viewedPreset.name })}
                className={buttonClass}
              >
                <Circle className="h-3 w-3" />
                {t("mySkills.tagFilterDisableAll", { count: toDisable.length })}
              </button>
            </div>
          );
        })()}
      </div>

      {isMultiSelect && (
        <MultiSelectToolbar
          selectedCount={selectedIds.size}
          isAllSelected={isAllSelected}
          actions={[
            ...(viewedPreset && togglableSelectedSkills.length > 0
              ? [{
                  key: "toggle",
                  tone: "primary" as const,
                  label: anyDisabled
                    ? t("mySkills.batchEnable", { count: togglableSelectedSkills.length })
                    : t("mySkills.batchDisable", { count: togglableSelectedSkills.length }),
                  icon: anyDisabled
                    ? <CheckCircle2 className="h-3.5 w-3.5" />
                    : <Circle className="h-3.5 w-3.5" />,
                  busy: batchToggling,
                  onSelect: handleBatchTogglePreset,
                }]
              : []),
            {
              key: "sync",
              label: t("mySkills.batchSyncAgents", { count: selectedIds.size }),
              icon: <Share2 className="h-3.5 w-3.5" />,
              onSelect: () => setBatchSyncDialogOpen(true),
            },
            {
              key: "tags",
              label: t("mySkills.batchEditTags", { count: selectedIds.size }),
              icon: <Tag className="h-3.5 w-3.5" />,
              onSelect: () => setBatchTagDialogOpen(true),
            },
          ]}
          overflowActions={[
            ...(anyRefreshableSelected
              ? [{
                  key: "update",
                  label: t("mySkills.batchUpdate", { count: refreshableSelectedCount }),
                  icon: <RotateCcw className="h-3.5 w-3.5" />,
                  busy: batchUpdating,
                  onSelect: handleBatchRefresh,
                }]
              : []),
            {
              key: "delete",
              tone: "danger" as const,
              label: t("mySkills.deleteSelected", { count: selectedIds.size }),
              icon: <Trash2 className="h-3.5 w-3.5" />,
              onSelect: () => setBatchDeleteConfirm(true),
            },
          ]}
          labels={{
            hint: t("mySkills.selectHint"),
            selected: t("mySkills.selectedCount", { count: selectedIds.size }),
            selectAll: t("mySkills.selectAll"),
            deselectAll: t("mySkills.deselectAll"),
            cancel: t("common.cancel"),
            more: t("mySkills.moreActions"),
          }}
          onSelectAll={handleSelectAll}
          onCancel={exitMultiSelect}
        />
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
          <Layers className="mb-4 h-12 w-12 text-faint" />
          <h3 className="mb-1.5 text-[14px] font-semibold text-tertiary">{t("mySkills.noSkills")}</h3>
          <p className="text-[13px] text-muted">
            {skills.length === 0 ? t("mySkills.addFirst") : t("mySkills.noMatch")}
          </p>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="app-button-secondary mt-4">
              {t("mySkills.clearFilters")}
            </button>
          )}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={filtered.map((s) => s.id)}
            strategy={viewMode === "grid" ? rectSortingStrategy : verticalListSortingStrategy}
          >
          <div
            className={cn(
              "pb-8",
              viewMode === "grid"
                ? "grid grid-cols-2 gap-3 lg:grid-cols-3"
                : "flex flex-col gap-0.5"
            )}
          >
          {sourceRows.map((row) => {
            if (row.kind === "group") {
              if (!row.showHeader) return null;
              const { section } = row;
              const label = section.bundle
                ? section.bundle.label || t("mySkills.sourcePicker.unknownSource")
                : t("mySkills.ungrouped");
              // The toggle covers the whole bundle, filtered or not: a
              // bundle's skills rely on one another.
              const members = section.bundle?.skills ?? section.items;
              const allEnabled = !!viewedPreset
                && members.every((skill) => skill.preset_ids.includes(viewedPreset.id));
              return (
                <SkillGroupHeader
                  key={`group-${section.key}`}
                  bundle={section.bundle}
                  label={label}
                  count={section.items.length}
                  expanded={row.expanded}
                  onToggleExpanded={() =>
                    setGroupOpen((prev) => ({ ...prev, [section.key]: !row.expanded }))
                  }
                  className={viewMode === "grid" ? "col-span-full" : undefined}
                  control={
                    viewedPreset && section.key !== UNGROUPED_KEY && !isMultiSelect ? (
                      <ToggleSwitch
                        checked={allEnabled}
                        loading={togglingGroupKey === section.key}
                        disabled={togglingGroupKey !== null}
                        onChange={() => handleToggleGroupInPreset(section.key, members)}
                        title={
                          allEnabled
                            ? t("mySkills.groupDisableAll", { preset: viewedPreset.name })
                            : t("mySkills.groupEnableAll", { preset: viewedPreset.name })
                        }
                      />
                    ) : null
                  }
                />
              );
            }

            const skill = row.skill;
            const enabledInPreset = viewedPreset
              ? skill.preset_ids.includes(viewedPreset.id)
              : false;
            const badge = statusBadge(skill);
            const hasUpdate =
              skill.update_status === "update_available" && canRefresh(skill);
            // The header pill is hidden in multi-select, so the body badge has to
            // take over — otherwise the update state vanishes entirely.
            const showUpdatePill = hasUpdate && !isMultiSelect;
            const isMissingLocalSource =
              skill.update_status === "source_missing"
              && (skill.source_type === "local" || skill.source_type === "import");
            const displayName = skillDisplayNames.get(skill.id) || skill.name;

            if (viewMode === "grid") {
              return (
                <SortableSkillItem
                  key={skill.id}
                  id={skill.id}
                  disabled={!canDrag || !enabledInPreset}
                  className={menuSkillId === skill.id ? "relative z-30" : undefined}
                  handlePlacement="card"
                  handleTitle={t("mySkills.dragToReorder")}
                >
                {(dragHandle) => (
                <div
                  className={cn(
                    "app-panel group relative flex h-full cursor-pointer flex-col shadow-card transition-[box-shadow,border-color] hover:border-border hover:shadow-card-hover",
                    isMultiSelect && selectedIds.has(skill.id) && "ring-1 ring-accent border-accent/40"
                  )}
                  onClick={() =>
                    isMultiSelect ? toggleSelect(skill.id) : openSkillDetailById(skill.id)
                  }
                >
                  {deletingIds.has(skill.id) && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-surface/70 backdrop-blur-[1px]">
                      <Loader2 className="h-5 w-5 animate-spin text-muted" />
                    </div>
                  )}
                  {isMultiSelect ? renderSelectionMark(skill.id, "card") : dragHandle}

                  <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-1.5">
                    <SkillAvatar url={getSkillSourceInfo(skill).avatarUrl} />
                    <h3
                      className="flex-1 truncate text-[14px] font-semibold text-primary group-hover:text-accent-light"
                      title={displayName}
                    >
                      {displayName}
                    </h3>
                    {showUpdatePill && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRefreshSkill(skill); }}
                        disabled={updatingSkillId === skill.id}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-600 outline-none transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
                        title={refreshLabel(skill)}
                      >
                        <RotateCcw className={cn("h-2.5 w-2.5", updatingSkillId === skill.id && "animate-spin")} />
                        {t("mySkills.updateActions.update")}
                      </button>
                    )}
                    {!isMultiSelect && (
                      <>
                        <CardActionMenu
                          label={t("mySkills.moreActions")}
                          onOpenChange={(open) => setMenuSkillId(open ? skill.id : null)}
                          className={cn(
                            "transition-opacity",
                            menuSkillId === skill.id
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100"
                          )}
                          actions={[
                            {
                              key: "check",
                              label: t("mySkills.updateActions.check"),
                              icon: <RefreshCw className={cn("h-3.5 w-3.5", checkingSkillId === skill.id && "animate-spin")} />,
                              disabled: checkingSkillId === skill.id,
                              onSelect: () => handleCheckUpdate(skill),
                            },
                            ...(canRefresh(skill)
                              ? [{
                                  key: "refresh",
                                  label: refreshLabel(skill),
                                  icon: <RotateCcw className={cn("h-3.5 w-3.5", updatingSkillId === skill.id && "animate-spin")} />,
                                  disabled: updatingSkillId === skill.id,
                                  onSelect: () => handleRefreshSkill(skill),
                                }]
                              : []),
                            {
                              key: "rename",
                              label: t("mySkills.rename.action"),
                              icon: <Pencil className="h-3.5 w-3.5" />,
                              onSelect: () => setSkillToRename(skill),
                            },
                            {
                              key: "delete",
                              label: t("common.delete"),
                              icon: <Trash2 className="h-3.5 w-3.5" />,
                              danger: true,
                              onSelect: () => setSkillToDelete(skill),
                            },
                          ]}
                        />
                        {viewedPreset && (
                          <ToggleSwitch
                            checked={enabledInPreset}
                            onChange={() => handleTogglePreset(skill)}
                            title={t(enabledInPreset ? "mySkills.disableInPreset" : "mySkills.enableInPreset", { preset: viewedPreset.name })}
                          />
                        )}
                      </>
                    )}
                  </div>

                  <div className="px-3.5 pb-3">
                    <p className="text-[13px] leading-[18px] text-muted truncate">
                      {skill.description || "—"}
                    </p>
                    {((badge && !showUpdatePill) || conflictIds.has(skill.id)) && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {conflictIds.has(skill.id) && (
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate("/backup"); }}
                            className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[13px] font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
                            title={t("mySkills.needsAttentionHint")}
                          >
                            {t("mySkills.needsAttention")}
                          </button>
                        )}
                        {badge && !showUpdatePill && (
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[13px] font-medium",
                              badge.className
                            )}
                          >
                            {badge.label}
                          </span>
                        )}
                        {isMissingLocalSource && (
                          <>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRelinkSource(skill); }}
                              disabled={updatingSkillId === skill.id}
                              className="rounded-full border border-border-subtle px-2 py-0.5 text-[12px] font-medium text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
                            >
                              {t("mySkills.updateActions.relink")}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDetachSource(skill); }}
                              disabled={updatingSkillId === skill.id}
                              className="rounded-full border border-border-subtle px-2 py-0.5 text-[12px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-secondary disabled:opacity-50"
                            >
                              {t("mySkills.updateActions.detachSource")}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex">
                      {renderTagsControl(skill, "card")}
                    </div>
                  </div>

                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-border-faint px-3.5 py-2.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted">
                        {sourceIcon(skill.source_type)}
                        {sourceTypeLabel(skill)}
                      </span>
                      {renderPresetsControl(skill, "card")}
                    </div>
                    <SyncDots
                      className="shrink-0"
                      skill={skill}
                      tools={tools}
                      limit={6}
                      onToggle={
                        isMultiSelect
                          ? undefined
                          : (tool, enabled) => handleToggleSkillTarget(skill, tool, enabled)
                      }
                      pendingKey={togglingTarget?.skillId === skill.id ? togglingTarget.tool : null}
                    />
                  </div>
                </div>
                )}
                </SortableSkillItem>
              );
            }

            return (
              <SortableSkillItem
                key={skill.id}
                id={skill.id}
                disabled={!canDrag || !enabledInPreset}
                className={menuSkillId === skill.id ? "relative z-30" : undefined}
                handlePlacement="row"
                handleTitle={t("mySkills.dragToReorder")}
              >
              {(dragHandle) => (
              <div
                className={cn(
                  "app-panel group relative flex cursor-pointer items-center gap-3.5 rounded-xl border-transparent px-3.5 py-3 transition-colors hover:border-border hover:bg-surface-hover",
                  isMultiSelect && selectedIds.has(skill.id) && "ring-1 ring-accent border-accent/40"
                )}
                onClick={() =>
                  isMultiSelect ? toggleSelect(skill.id) : openSkillDetailById(skill.id)
                }
              >
                {deletingIds.has(skill.id) && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-surface/70 backdrop-blur-[1px]">
                    <Loader2 className="h-5 w-5 animate-spin text-muted" />
                  </div>
                )}
                {isMultiSelect ? renderSelectionMark(skill.id, "row") : dragHandle}

                <h3
                  className="flex w-[180px] shrink-0 items-center gap-2 text-[14px] font-semibold text-secondary group-hover:text-primary"
                  title={displayName}
                >
                  <SkillAvatar url={getSkillSourceInfo(skill).avatarUrl} />
                  <span className="truncate">{displayName}</span>
                </h3>

                <p className="min-w-0 flex-1 truncate text-[13px] text-muted">
                  {skill.description || "—"}
                </p>

                <div className="flex w-[176px] shrink-0 items-center">
                  {renderTagsControl(skill, "row")}
                </div>

                <div className="flex shrink-0 items-center gap-2.5">
                  {conflictIds.has(skill.id) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate("/backup"); }}
                      className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[12px] font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
                      title={t("mySkills.needsAttentionHint")}
                    >
                      {t("mySkills.needsAttention")}
                    </button>
                  )}
                  {hasUpdate && !isMultiSelect ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRefreshSkill(skill); }}
                      disabled={updatingSkillId === skill.id}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-600 outline-none transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
                      title={refreshLabel(skill)}
                    >
                      <RotateCcw className={cn("h-2.5 w-2.5", updatingSkillId === skill.id && "animate-spin")} />
                      {t("mySkills.updateActions.update")}
                    </button>
                  ) : badge && (
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[12px] font-medium",
                        badge.className
                      )}
                    >
                      {badge.label}
                    </span>
                  )}
                  <SyncDots
                    skill={skill}
                    tools={tools}
                    limit={6}
                    size="sm"
                    onToggle={
                      isMultiSelect
                        ? undefined
                        : (tool, enabled) => handleToggleSkillTarget(skill, tool, enabled)
                    }
                    pendingKey={togglingTarget?.skillId === skill.id ? togglingTarget.tool : null}
                  />
                  <span className="inline-flex w-[76px] items-center gap-1 text-[13px] text-muted">
                    {sourceIcon(skill.source_type)}
                    <span className="truncate">{sourceTypeLabel(skill)}</span>
                  </span>
                  <span className="flex w-[148px] items-center">
                    {renderPresetsControl(skill, "row")}
                  </span>
                </div>

                {isMissingLocalSource && !isMultiSelect && (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRelinkSource(skill); }}
                      disabled={updatingSkillId === skill.id}
                      className="rounded-md px-2 py-0.5 text-[13px] font-medium text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
                    >
                      {t("mySkills.updateActions.relink")}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDetachSource(skill); }}
                      disabled={updatingSkillId === skill.id}
                      className="rounded-md px-2 py-0.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-secondary disabled:opacity-50"
                    >
                      {t("mySkills.updateActions.detachSource")}
                    </button>
                  </div>
                )}

                {!isMultiSelect && (
                  <div className="flex shrink-0 items-center gap-2">
                    <CardActionMenu
                      label={t("mySkills.moreActions")}
                      onOpenChange={(open) => setMenuSkillId(open ? skill.id : null)}
                      className={cn(
                        "transition-opacity",
                        menuSkillId === skill.id
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100"
                      )}
                      actions={[
                        {
                          key: "check",
                          label: t("mySkills.updateActions.check"),
                          icon: <RefreshCw className={cn("h-3.5 w-3.5", checkingSkillId === skill.id && "animate-spin")} />,
                          disabled: checkingSkillId === skill.id,
                          onSelect: () => handleCheckUpdate(skill),
                        },
                        ...(canRefresh(skill)
                          ? [{
                              key: "refresh",
                              label: refreshLabel(skill),
                              icon: <RotateCcw className={cn("h-3.5 w-3.5", updatingSkillId === skill.id && "animate-spin")} />,
                              disabled: updatingSkillId === skill.id,
                              onSelect: () => handleRefreshSkill(skill),
                            }]
                          : []),
                        {
                          key: "rename",
                          label: t("mySkills.rename.action"),
                          icon: <Pencil className="h-3.5 w-3.5" />,
                          onSelect: () => setSkillToRename(skill),
                        },
                        {
                          key: "delete",
                          label: t("common.delete"),
                          icon: <Trash2 className="h-3.5 w-3.5" />,
                          danger: true,
                          onSelect: () => setSkillToDelete(skill),
                        },
                      ]}
                    />
                    {viewedPreset && (
                      <ToggleSwitch
                        checked={enabledInPreset}
                        onChange={() => handleTogglePreset(skill)}
                        title={t(enabledInPreset ? "mySkills.disableInPreset" : "mySkills.enableInPreset", { preset: viewedPreset.name })}
                      />
                    )}
                  </div>
                )}
              </div>
              )}
              </SortableSkillItem>
            );
          })}
        </div>
          </SortableContext>
        </DndContext>
      )}

      <SkillDetailPanel
        key={selectedSkill?.id ?? "skill-detail-empty"}
        skill={selectedSkill}
        onClose={closeSkillDetail}
        tools={tools}
        toolToggles={toolToggles}
        togglingTool={togglingToolKey}
        onToggleTool={handleToggleSkillTool}
        projects={projects}
        onProjectsChanged={refreshProjects}
        membership={
          selectedSkill ? (
            <>
              {renderTagsControl(selectedSkill, "card")}
              {renderPresetsControl(selectedSkill, "card")}
            </>
          ) : null
        }
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        tone="warning"
        title={t("mySkills.updateActions.removalTitle")}
        message={t("mySkills.updateActions.removalMessage", {
          name: pendingRemoval?.skill.name ?? "",
          count: pendingRemoval?.removals.length ?? 0,
        })}
        // Every path, never a truncated sample: recognising one's own file is
        // the whole point, and it might be the twenty-first.
        details={pendingRemoval?.removals.map((r) =>
          r.location === "library" ? r.path : `${r.location}: ${r.path}`
        )}
        confirmLabel={t("mySkills.updateActions.removalConfirm")}
        onClose={() => setPendingRemoval(null)}
        onConfirm={async () => {
          const target = pendingRemoval?.skill;
          const approval = pendingRemoval?.approval ?? undefined;
          const relinkSource = pendingRemoval?.relinkSource;
          setPendingRemoval(null);
          if (!target) return;
          if (relinkSource) {
            await handleRelinkSource(target, relinkSource, approval);
          } else {
            await handleRefreshSkill(target, approval);
          }
        }}
      />
      <ConfirmDialog
        open={batchDeleteConfirm}
        message={t("mySkills.batchDeleteConfirm", { count: selectedIds.size })}
        onClose={() => setBatchDeleteConfirm(false)}
        onConfirm={handleBatchDelete}
      />
      <ConfirmDialog
        open={skillToDelete !== null}
        title={t("mySkills.delete")}
        message={t("mySkills.deleteConfirm", { name: skillToDelete?.name || "" })}
        onClose={() => setSkillToDelete(null)}
        onConfirm={async () => {
          if (skillToDelete) handleDeleteSkill(skillToDelete);
        }}
      />
      <ConfirmDialog
        open={tagToDelete !== null}
        title={t("mySkills.tags.deleteTag")}
        message={t("mySkills.tags.deleteConfirm", { tag: tagToDelete || "" })}
        onClose={() => setTagToDelete(null)}
        onConfirm={handleDeleteTag}
      />
      <RenameSkillDialog
        open={skillToRename !== null}
        currentFolder={skillToRename ? folderOf(skillToRename) : ""}
        onClose={() => setSkillToRename(null)}
        onRename={handleRenameSkill}
      />
      <LinkDuplicatesDialog
        open={linkDialogOpen}
        duplicates={visibleLineageDuplicates}
        onClose={() => setLinkDialogOpen(false)}
        onLink={handleLinkLineage}
        onDismiss={handleDismissLineage}
      />
      <TagRenameDialog
        open={tagToRename !== null}
        currentName={tagToRename || ""}
        onClose={() => setTagToRename(null)}
        onRename={handleRenameTag}
      />
      {tagMenu && (
        <>
          {/* Backdrop closes on left- or right-click outside the menu. Explicit
              z-index (z-40/z-50) to avoid the macOS WKWebView stacking bug. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setTagMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTagMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-[140px] overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-2xl"
            style={{ top: tagMenu.y, left: tagMenu.x }}
          >
            <button
              onClick={() => {
                setTagToRename(tagMenu.tag);
                setTagMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-secondary hover:bg-surface-hover"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t("mySkills.tags.renameTag")}
            </button>
            <button
              onClick={() => {
                setTagToDelete(tagMenu.tag);
                setTagMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red-600 dark:text-red-400 hover:bg-surface-hover"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("mySkills.tags.deleteTag")}
            </button>
          </div>
        </>
      )}
      <BatchTagDialog
        open={batchTagDialogOpen}
        skills={skills.filter((s) => selectedIds.has(s.id))}
        allTags={allTags}
        onClose={() => setBatchTagDialogOpen(false)}
        onApply={handleBatchEditTags}
      />

      <BatchSyncAgentDialog
        open={batchSyncDialogOpen}
        skills={skills.filter((s) => selectedIds.has(s.id))}
        tools={tools}
        onClose={() => setBatchSyncDialogOpen(false)}
        onApply={handleBatchSyncAgents}
      />
    </div>
  );
}
