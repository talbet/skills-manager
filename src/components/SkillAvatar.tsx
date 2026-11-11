import { useState, type ReactNode } from "react";
import { cn } from "../utils";

interface Props {
  url: string | null;
  /** Shown when there is no avatar, or it failed to load. */
  fallback?: ReactNode;
  className?: string;
}

/**
 * A skill publisher's avatar (the GitHub owner of a repo or skills.sh skill).
 * Falls back quietly when offline or when the source has no avatar.
 */
export function SkillAvatar({ url, fallback = null, className }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) return <>{fallback}</>;
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      onError={() => setFailedUrl(url)}
      className={cn("h-4 w-4 shrink-0 rounded-full border border-border-subtle bg-surface", className)}
    />
  );
}
