import { useState } from "react";
import { ArrowLeft, Link2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LineageDuplicate } from "../lib/tauri";
import { lineageDuplicateKey } from "../lib/skillLineage";

interface Props {
  open: boolean;
  duplicates: LineageDuplicate[];
  onClose: () => void;
  /** Rejects on failure; the caller shows the error. */
  onLink: (duplicate: LineageDuplicate) => Promise<void>;
  onDismiss: (duplicate: LineageDuplicate) => void;
}

export function LinkDuplicatesDialog({ open, duplicates, onClose, onLink, onDismiss }: Props) {
  const { t } = useTranslation();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  if (!open) return null;

  const handleLink = async (duplicate: LineageDuplicate) => {
    setBusyKey(lineageDuplicateKey(duplicate));
    try {
      await onLink(duplicate);
    } catch {
      // Shown by the caller; the row stays so the user can retry.
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 z-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-xl border border-border bg-surface p-5 shadow-2xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-primary">{t("mySkills.lineage.title")}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted outline-none transition-colors hover:text-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-[13px] leading-5 text-muted">{t("mySkills.lineage.intro")}</p>

        <div className="-mr-1 space-y-2 overflow-y-auto pr-1">
          {duplicates.length === 0 && (
            <p className="py-6 text-center text-[13px] text-muted">{t("mySkills.lineage.none")}</p>
          )}
          {duplicates.map((duplicate) => {
            const key = lineageDuplicateKey(duplicate);
            const busy = busyKey === key;
            return (
              <div key={key} className="rounded-lg border border-border-subtle bg-background px-3 py-2.5">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="truncate font-semibold text-primary" title={duplicate.keep.folder}>
                    {duplicate.keep.name}
                  </span>
                  <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-muted">
                    {t(`mySkills.lineage.kind.${duplicate.keep.source_type === "local" ? "local" : "import"}`)}
                  </span>
                  <ArrowLeft className="h-3.5 w-3.5 shrink-0 text-faint" />
                  <span className="min-w-0 truncate text-secondary" title={duplicate.source.source_ref ?? ""}>
                    {duplicate.source.source_ref ?? duplicate.source.folder}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-5 text-muted">
                  {duplicate.content_identical
                    ? t("mySkills.lineage.identical", { folder: duplicate.source.folder })
                    : t("mySkills.lineage.differs", { folder: duplicate.source.folder })}
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => onDismiss(duplicate)}
                    disabled={busy}
                    className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-tertiary outline-none transition-colors hover:bg-surface-hover hover:text-secondary disabled:opacity-50"
                  >
                    {t("mySkills.lineage.dismiss")}
                  </button>
                  <button
                    onClick={() => handleLink(duplicate)}
                    disabled={busyKey !== null}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-accent-border bg-accent-dark px-3 py-1.5 text-[13px] font-medium text-white outline-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {busy ? t("common.loading") : t("mySkills.lineage.link")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
