import { describe, expect, it } from "vitest";
import { LIBRARY_PATH, presetViewPath, viewedPresetIdFrom } from "./presetRoute";

describe("presetRoute", () => {
  it("round-trips a preset id through the Library URL", () => {
    const url = new URL(presetViewPath("p 1/2"), "http://app");
    expect(url.pathname).toBe(LIBRARY_PATH);
    expect(viewedPresetIdFrom(url.pathname, url.search)).toBe("p 1/2");
  });

  it("views no preset on the plain Library", () => {
    expect(viewedPresetIdFrom(LIBRARY_PATH, "")).toBeNull();
  });

  // The sidebar used to keep the last preset lit on every page.
  it("views no preset away from the Library, whatever the query", () => {
    expect(viewedPresetIdFrom("/", "?preset=p-web")).toBeNull();
    expect(viewedPresetIdFrom("/settings", "?preset=p-web")).toBeNull();
  });
});
