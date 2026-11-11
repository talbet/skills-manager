import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  open: boolean;
  currentFolder: string;
  onClose: () => void;
  /** Rejects to keep the dialog open; the caller shows the error. */
  onRename: (newFolder: string) => Promise<void>;
}

// The characters a user is likely to type; the backend makes the full check
// (control characters included) and has the final say.
const INVALID_FOLDER = /[/\\:*?"<>|]/;

export function RenameSkillDialog({ open, currentFolder, onClose, onRename }: Props) {
  const { t } = useTranslation();
  const [folder, setFolder] = useState(currentFolder);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setFolder(currentFolder);
  }, [open, currentFolder]);

  if (!open) return null;

  const trimmed = folder.trim();
  const invalid =
    trimmed.length > 0 && (INVALID_FOLDER.test(trimmed) || trimmed.startsWith("."));
  const canSave = trimmed.length > 0 && !invalid && trimmed !== currentFolder;

  const handleRename = async () => {
    if (!canSave) return;
    setLoading(true);
    try {
      await onRename(trimmed);
      onClose();
    } catch {
      // The parent shows the error; stay open so the user can pick another name.
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full bg-background border border-border-subtle rounded-lg px-3 py-2 text-[13px] text-secondary focus:outline-none focus:border-border transition-all placeholder-faint";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 z-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 bg-surface border border-border rounded-xl w-full max-w-[420px] p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[13px] font-semibold text-primary">{t("mySkills.rename.title")}</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-secondary p-1 rounded-md transition-colors outline-none"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[13px] font-medium text-tertiary mb-1">
              {t("mySkills.rename.folderLabel")}
            </label>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className={inputClass}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
            />
            <p className="mt-1.5 text-[12px] leading-5 text-muted">
              {invalid ? t("mySkills.rename.invalid") : t("mySkills.rename.hint")}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-[13px] font-medium text-tertiary hover:text-secondary hover:bg-surface-hover transition-colors outline-none"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleRename}
              disabled={!canSave || loading}
              className="px-3 py-1.5 rounded-lg bg-accent-dark hover:bg-accent text-white text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-accent-border outline-none"
            >
              {loading ? t("common.loading") : t("mySkills.rename.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
