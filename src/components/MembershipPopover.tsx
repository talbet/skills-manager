import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Square, SquareCheck } from "lucide-react";
import { cn } from "../utils";

export interface MembershipItem {
  id: string;
  label: string;
  /** Rendered before the label, e.g. a preset icon or a tag colour swatch. */
  icon?: React.ReactNode;
}

interface Props {
  items: MembershipItem[];
  /** Ids the skill currently belongs to. Read when the popover opens. */
  selected: string[];
  /**
   * Called on every toggle with the full next selection, so a caller that
   * writes the whole set (tags) never builds it from a stale copy.
   */
  onChange: (next: string[], toggledId: string, checked: boolean) => void;
  /** Offers a "Create" row for a query that matches no item; it reports through onChange. */
  allowCreate?: boolean;
  /** Lets the host refresh once, after the last toggle, and lift its card. */
  onOpenChange?: (open: boolean) => void;
  label: string;
  searchPlaceholder: string;
  emptyLabel: string;
  createLabel?: (query: string) => string;
  disabled?: boolean;
  triggerClassName?: string;
  children: React.ReactNode;
}

const PANEL_WIDTH = 224;
const PANEL_MAX_HEIGHT = 288;
const GAP = 4;

/**
 * A checkbox list anchored to a trigger, for editing which tags or presets a
 * skill belongs to. The panel is portaled to <body> with fixed coordinates: the
 * sortable card wrapper carries a CSS transform, which would otherwise become
 * the containing block and clip the panel inside the scroll container.
 */
export function MembershipPopover({
  items,
  selected,
  onChange,
  allowCreate,
  onOpenChange,
  label,
  searchPlaceholder,
  emptyLabel,
  createLabel,
  disabled,
  triggerClassName,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openChangeRef = useRef(onOpenChange);
  const listId = useId();

  useEffect(() => {
    openChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    openChangeRef.current?.(next);
  }, []);

  const close = useCallback(() => {
    setOpenState(false);
    triggerRef.current?.focus();
  }, [setOpenState]);

  const trimmed = query.trim();
  // A value created in this session shows as a checked row before the host's
  // item list catches up.
  const allItems = useMemo(() => {
    const known = new Set(items.map((item) => item.id));
    const created: MembershipItem[] = draft.filter((id) => !known.has(id)).map((id) => ({ id, label: id }));
    return [...items, ...created];
  }, [items, draft]);
  const visibleItems = useMemo(() => {
    const q = trimmed.toLowerCase();
    return q ? allItems.filter((item) => item.label.toLowerCase().includes(q)) : allItems;
  }, [allItems, trimmed]);
  const canCreate =
    !!allowCreate
    && trimmed.length > 0
    && !allItems.some((item) => item.label.toLowerCase() === trimmed.toLowerCase());
  const rowCount = visibleItems.length + (canCreate ? 1 : 0);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - GAP * 2;
    const above = rect.top - GAP * 2;
    const flip = below < 180 && above > below;
    const maxHeight = Math.min(PANEL_MAX_HEIGHT, flip ? above : below);
    const left = Math.max(GAP * 2, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - GAP * 2));
    const top = flip ? rect.top - GAP - maxHeight : rect.bottom + GAP;
    setPosition({ left, top, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpenState(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Consumed here so multi-select and the detail sheet don't also react.
      e.stopPropagation();
      close();
    };
    const handleScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpenState(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, close, place, setOpenState]);

  // The panel mounts once it has a position, a render after `open` flips.
  const panelMounted = open && position !== null;
  useEffect(() => {
    if (panelMounted) inputRef.current?.focus();
  }, [panelMounted]);

  // Report the collapsed state if this popover unmounts while open.
  useEffect(() => () => openChangeRef.current?.(false), []);

  const toggle = (id: string) => {
    const checked = !draft.includes(id);
    const next = checked ? [...draft, id] : draft.filter((value) => value !== id);
    setDraft(next);
    onChange(next, id, checked);
  };

  const create = () => {
    if (!canCreate) return;
    const next = [...draft, trimmed];
    setDraft(next);
    onChange(next, trimmed, true);
    setQuery("");
  };

  const handleInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i + 1) % rowCount));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i - 1 + rowCount) % rowCount));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex < visibleItems.length) toggle(visibleItems[activeIndex].id);
      else create();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            setOpenState(false);
            return;
          }
          setDraft(selected);
          setQuery("");
          setActiveIndex(0);
          setOpenState(true);
        }}
        className={cn(
          "outline-none disabled:pointer-events-none",
          triggerClassName
        )}
      >
        {children}
      </button>
      {open && position &&
        createPortal(
          <div
            ref={panelRef}
            // React events bubble through portals: keep clicks off the card.
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ left: position.left, top: position.top, width: PANEL_WIDTH, maxHeight: position.maxHeight }}
            className="fixed z-[70] flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
          >
            <div className="border-b border-border-subtle p-1.5">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleInputKey}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={listId}
                className="h-7 w-full rounded-md bg-bg-secondary px-2 text-[12px] text-secondary outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/60"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={label}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
            >
              {visibleItems.map((item, index) => {
                const checked = draft.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => toggle(item.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-secondary outline-none transition-colors",
                      index === activeIndex && "bg-surface-hover"
                    )}
                    title={item.label}
                  >
                    {checked ? (
                      <SquareCheck className="h-3.5 w-3.5 shrink-0 text-accent" />
                    ) : (
                      <Square className="h-3.5 w-3.5 shrink-0 text-faint" />
                    )}
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
              {canCreate && createLabel && (
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(visibleItems.length)}
                  onClick={create}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-secondary outline-none transition-colors",
                    activeIndex === visibleItems.length && "bg-surface-hover"
                  )}
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="truncate">{createLabel(trimmed)}</span>
                </button>
              )}
              {rowCount === 0 && (
                <p className="px-2 py-1.5 text-[12px] text-muted">{emptyLabel}</p>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
