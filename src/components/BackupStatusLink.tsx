import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpCircle, CheckCircle2, GitBranch, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../utils";
import * as api from "../lib/tauri";
import type { GitBackupStatus } from "../lib/tauri";

type BackupMode =
  | "loading"
  | "uninitialized"
  | "needs_remote"
  | "needs_fix"
  | "up_to_date"
  | "pending_changes";

function backupMode(status: GitBackupStatus | null, savedRemote: string): BackupMode {
  if (!status) return "loading";
  if (!status.is_repo) return "uninitialized";
  if (!status.remote_url && !savedRemote) return "needs_remote";
  if (status.upstream_health === "unrelated_histories" || status.upstream_health === "detached") {
    return "needs_fix";
  }
  // First-push case: remote is set but upstream tracking is not yet established.
  // Treat as a normal pending sync — the push path will set upstream automatically.
  if (status.upstream_health === "no_upstream") return "pending_changes";
  if (status.has_changes || status.ahead > 0 || status.behind > 0) return "pending_changes";
  return "up_to_date";
}

/**
 * The backup state in one line, linking to the Backup page. Lives on the
 * Dashboard rather than the Library toolbar: backup is optional, so it should
 * not sit beside the controls everyone uses.
 */
export function BackupStatusLink({ refreshKey, className }: { refreshKey?: unknown; className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<GitBackupStatus | null>(null);
  const [savedRemote, setSavedRemote] = useState("");

  const refresh = useCallback(async (fetchRemote: boolean) => {
    try {
      if (fetchRemote) await api.gitBackupFetch().catch(() => {});
      setStatus(await api.gitBackupStatus());
    } catch {
      // not critical
    }
  }, []);

  useEffect(() => {
    // The saved setting is the single source of truth. Do not backfill from
    // `.git/config` — that made a cleared URL reappear after disconnect (#260).
    api.getSettings("git_backup_remote_url")
      .then((value) => setSavedRemote(value?.trim() || ""))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleFocus = () => { void refresh(true); };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  // Local-only refresh (no `git fetch`) when the library changes, so it cannot
  // drive the file-watcher → refresh → fetch feedback loop.
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(false); }, 400);
    return () => window.clearTimeout(timer);
  }, [refreshKey, refresh]);

  const mode = backupMode(status, savedRemote);
  const meta = {
    loading: { icon: Loader2, label: t("backup.status.loading"), tone: "text-muted", spin: true },
    uninitialized: { icon: GitBranch, label: t("backup.status.notConnected"), tone: "text-muted", spin: false },
    needs_remote: { icon: GitBranch, label: t("backup.status.notConnected"), tone: "text-muted", spin: false },
    needs_fix: { icon: Wrench, label: t("backup.status.needsFix"), tone: "text-red-500", spin: false },
    pending_changes: { icon: ArrowUpCircle, label: t("backup.status.pending"), tone: "text-amber-600 dark:text-amber-400", spin: false },
    up_to_date: { icon: CheckCircle2, label: t("backup.status.synced"), tone: "text-muted", spin: false },
  }[mode];
  const Icon = meta.icon;

  return (
    <button
      type="button"
      onClick={() => navigate("/backup")}
      title={t("sidebar.backup")}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-surface-hover hover:text-secondary",
        meta.tone,
        className
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", meta.spin && "animate-spin")} />
      {t("dashboard.backupStatus", { status: meta.label })}
    </button>
  );
}
