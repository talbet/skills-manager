/**
 * The Library shows every skill at `/my-skills`; a preset is a view of it at
 * `/my-skills?preset=<id>`. Keeping the preset in the URL means the sidebar
 * highlights a preset only while that view is open.
 */
export const LIBRARY_PATH = "/my-skills";
export const PRESET_PARAM = "preset";

export function presetViewPath(presetId: string) {
  return `${LIBRARY_PATH}?${PRESET_PARAM}=${encodeURIComponent(presetId)}`;
}

/** The preset id the current Library URL is scoped to, if any. */
export function viewedPresetIdFrom(pathname: string, search: string) {
  if (pathname !== LIBRARY_PATH) return null;
  return new URLSearchParams(search).get(PRESET_PARAM);
}
