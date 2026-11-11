import { describe, expect, it } from "vitest";
import type { ManagedSkill } from "./tauri";
import {
  buildBundleIndex,
  getSkillSourceInfo,
  groupIntoBundles,
  UNGROUPED_KEY,
} from "./skillSource";

function skill(id: string, source_type: string, source_ref: string | null, source_ref_resolved: string | null = null): ManagedSkill {
  return {
    id, name: id, description: null, source_type, source_ref, source_ref_resolved,
    source_subpath: null, source_branch: null, source_revision: null, remote_revision: null,
    update_status: "", last_checked_at: null, last_check_error: null,
    central_path: `/central/${id}`, enabled: true, created_at: 0, updated_at: 0,
    status: "", targets: [], preset_ids: [], tags: [],
  };
}

const library = [
  skill("brainstorm", "git", "https://github.com/Obra/superpowers.git"),
  skill("tdd", "skillssh", "obra/superpowers/tdd", "https://github.com/obra/superpowers"),
  skill("solo-git", "git", "https://github.com/someone/one-skill"),
  skill("mine", "local", "/home/me/skills/mine"),
  skill("site-a", "well-known", "https://skills.sh/site/example.com/a"),
];

describe("getSkillSourceInfo avatar", () => {
  it("uses the GitHub owner's avatar for git and skills.sh skills", () => {
    expect(getSkillSourceInfo(library[0]).avatarUrl).toBe("https://github.com/obra.png?size=64");
    expect(getSkillSourceInfo(library[1]).avatarUrl).toBe("https://github.com/obra.png?size=64");
  });

  it("has no avatar for local, site or non-GitHub sources", () => {
    expect(getSkillSourceInfo(library[3]).avatarUrl).toBeNull();
    expect(getSkillSourceInfo(library[4]).avatarUrl).toBeNull();
    expect(getSkillSourceInfo(skill("gl", "git", "https://gitlab.com/a/b")).avatarUrl).toBeNull();
  });
});

describe("bundles", () => {
  const index = buildBundleIndex(library);

  it("only treats sources with several library skills as bundles", () => {
    expect([...index.keys()]).toEqual(["repo:github.com/obra/superpowers"]);
  });

  it("keeps a filtered-down bundle together and puts the rest in one ungrouped section", () => {
    const visible = [library[3], library[1], library[2]];
    const sections = groupIntoBundles(visible, (s) => getSkillSourceInfo(s).key, index);
    expect(sections.map((s) => [s.key, s.items.map((i) => i.id)])).toEqual([
      ["repo:github.com/obra/superpowers", ["tdd"]],
      [UNGROUPED_KEY, ["mine", "solo-git"]],
    ]);
  });
});
