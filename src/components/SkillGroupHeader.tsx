import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, FolderTree, Globe, HardDrive, Layers } from "lucide-react";
import { cn } from "../utils";
import type { SkillSourceGroup } from "../lib/skillSource";
import { SkillAvatar } from "./SkillAvatar";

interface Props {
  /** The library bundle, or null for the ungrouped section. */
  bundle: SkillSourceGroup | null;
  label: string;
  count: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** A group-wide control (switch or checkbox) shown at the end of the row. */
  control?: ReactNode;
  className?: string;
}

function KindIcon({ bundle }: { bundle: SkillSourceGroup | null }) {
  const className = "h-3.5 w-3.5 shrink-0 text-faint";
  if (!bundle) return <Layers className={className} />;
  if (bundle.kind === "site") return <Globe className={className} />;
  if (bundle.kind === "path") return <HardDrive className={className} />;
  return <FolderTree className={className} />;
}

/** Foldable heading that separates one bundle (or the ungrouped rest) from the next. */
export function SkillGroupHeader({
  bundle,
  label,
  count,
  expanded,
  onToggleExpanded,
  control,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border-subtle pt-3 pb-1.5 first:pt-0",
        className
      )}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] font-semibold text-muted outline-none transition-colors hover:text-secondary focus-visible:ring-2 focus-visible:ring-accent"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <SkillAvatar url={bundle?.avatarUrl ?? null} fallback={<KindIcon bundle={bundle} />} />
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[11px] font-medium text-faint">{count}</span>
      </button>
      {control}
    </div>
  );
}
