/**
 * Scope filter (sync/history plan §4.1) — one predicate must filter both
 * directions. In particular, dot-prefixed segments (`.mrplex/`, `.obsidian/`)
 * are excluded so the scope filter agrees with the fs-store walk's prune.
 */

import { describe, expect, it } from "vitest";
import { makeScopeFilter } from "../src/sync/paths.js";

describe("makeScopeFilter", () => {
  it("includes plain .md files by default", () => {
    const s = makeScopeFilter();
    expect(s.matches("a.md")).toBe(true);
    expect(s.matches("notes/deep/b.md")).toBe(true);
  });

  it("excludes non-.md files under the default include", () => {
    const s = makeScopeFilter();
    expect(s.matches("a.txt")).toBe(false);
  });

  it("excludes the .mrplex state dir", () => {
    const s = makeScopeFilter();
    expect(s.matches(".mrplex/sync.json")).toBe(false);
  });

  it("excludes ALL dot-prefixed segments, at any depth (agrees with the walk)", () => {
    const s = makeScopeFilter();
    expect(s.matches(".obsidian/config.md")).toBe(false);
    expect(s.matches("notes/.hidden/x.md")).toBe(false);
    expect(s.matches("a/.b/c/d.md")).toBe(false);
  });

  it("honors custom include/exclude, exclude winning", () => {
    const s = makeScopeFilter({ include: ["**/*.md", "**/*.txt"], exclude: ["drafts/**"] });
    expect(s.matches("a.txt")).toBe(true);
    expect(s.matches("drafts/x.md")).toBe(false);
  });
});
