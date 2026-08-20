import { describe, expect, it } from "vitest";
import type { RawEdge } from "./extract.js";
import { BODY_FIELD } from "./extract.js";
import { HARDCODED_DEFAULTS, mergeConfig } from "./link-config.js";
import { normalizeTarget } from "./resolve.js";

function raw(target: string, wikilink = false): RawEdge {
  return { ord: 0, field: BODY_FIELD, target, wikilink };
}

const norm = (target: string, srcPath: string, wikilink = false, config = HARDCODED_DEFAULTS) =>
  normalizeTarget(raw(target, wikilink), srcPath, config);

describe("CommonMark relative resolution", () => {
  it("resolves relative to the source document's directory", () => {
    const e = norm("../horses.md", "people/alice.md");
    expect(e.target_raw).toBe("horses.md");
    expect(e.candidates).toEqual(["horses.md"]);
  });

  it("resolves a sibling reference", () => {
    expect(norm("bob.md", "people/alice.md").candidates).toEqual(["people/bob.md"]);
  });

  it("resolves a deeper relative path", () => {
    expect(norm("sub/bob.md", "people/alice.md").candidates).toEqual(["people/sub/bob.md"]);
  });

  it("treats a leading slash as repo-absolute", () => {
    expect(norm("/moc/index.md", "people/alice.md").candidates).toEqual(["moc/index.md"]);
  });

  it("collapses '.' segments", () => {
    expect(norm("./bob.md", "people/alice.md").candidates).toEqual(["people/bob.md"]);
  });

  it("yields no candidate when the path escapes the repo root", () => {
    expect(norm("../../../etc/passwd", "a.md").candidates).toEqual([]);
  });
});

describe("anchors", () => {
  it("preserves an anchor on target_raw but not on the candidate", () => {
    const e = norm("foo.md#section", "a.md");
    expect(e.target_raw).toBe("foo.md#section");
    expect(e.candidates).toEqual(["foo.md"]);
  });

  it("a bare fragment is a same-document link with no candidate", () => {
    const e = norm("#section", "a.md");
    expect(e.candidates).toEqual([]);
  });

  it("drops the anchor when preserve_anchors is off", () => {
    const off = mergeConfig(HARDCODED_DEFAULTS, {
      resolution: { ...HARDCODED_DEFAULTS.resolution, preserve_anchors: false },
    });
    expect(norm("foo.md#section", "a.md", false, off).target_raw).toBe("foo.md");
  });
});

describe("external targets", () => {
  it("drops http(s) URIs", () => {
    expect(norm("https://example.com/x", "a.md").candidates).toEqual([]);
  });

  it("drops mailto: and other schemes", () => {
    expect(norm("mailto:a@b.com", "a.md").candidates).toEqual([]);
  });
});

describe("wikilink resolution — root-relative base cases", () => {
  it("[[alice]] elides to alice.md then alice/index.md", () => {
    const e = norm("alice", "moc/employees.md", true);
    expect(e.target_raw).toBe("alice.md");
    expect(e.candidates).toEqual(["alice.md", "alice/index.md"]);
  });

  it("resolves root-relative regardless of source directory", () => {
    // The source is deep, but the wikilink resolves from the repo root,
    // NOT relative to the source dir (this is the Obsidian contract, and
    // what distinguishes wikilinks from CommonMark relative links).
    expect(norm("alice", "deep/nested/note.md", true).candidates).toEqual([
      "alice.md",
      "alice/index.md",
    ]);
  });

  it("[[moc/index]] resolves a nested wikilink", () => {
    expect(norm("moc/index", "a.md", true).candidates).toEqual([
      "moc/index.md",
      "moc/index/index.md",
    ]);
  });

  it("a leading slash is tolerated and stripped (still root-relative)", () => {
    expect(norm("/moc/alice", "deep/note.md", true).candidates).toEqual([
      "moc/alice.md",
      "moc/alice/index.md",
    ]);
  });
});

describe("wikilink resolution — extension / elision ambiguities", () => {
  it("an explicit .md suffix skips elision (single candidate)", () => {
    expect(norm("alice.md", "a.md", true).candidates).toEqual(["alice.md"]);
  });

  it("a nested .md suffix skips elision", () => {
    expect(norm("moc/alice.md", "a.md", true).candidates).toEqual(["moc/alice.md"]);
  });

  it("a dotted daily-note name still elides to <name>.md (NOT treated as an extension)", () => {
    // Regression guard: `2024.01.01` must become `2024.01.01.md`, not be
    // mistaken for an already-extensioned file. This is the bug a naive
    // "contains a dot" heuristic would introduce.
    const e = norm("2024.01.01", "journal/index.md", true);
    expect(e.target_raw).toBe("2024.01.01.md");
    expect(e.candidates).toEqual(["2024.01.01.md", "2024.01.01/index.md"]);
  });

  it("a dotted name with a trailing .md skips elision", () => {
    expect(norm("2024.01.01.md", "a.md", true).candidates).toEqual(["2024.01.01.md"]);
  });

  it("a non-.md extension gets .md appended (and will simply dangle)", () => {
    // mrplex documents are markdown (§2); a wikilink to `diagram.png`
    // becomes `diagram.png.md`, which won't resolve — inert to the graph,
    // no special-casing of asset extensions.
    const e = norm("diagram.png", "a.md", true);
    expect(e.target_raw).toBe("diagram.png.md");
    expect(e.candidates).toEqual(["diagram.png.md", "diagram.png/index.md"]);
  });

  it("an uppercase .MD is not the .md sentinel — byte-exact, so it elides", () => {
    // mrplex paths are byte-exact (§3.5.1), unlike Obsidian's case-insensitive
    // matching. `.MD` is not `.md`, so elision applies.
    const e = norm("alice.MD", "a.md", true);
    expect(e.target_raw).toBe("alice.MD.md");
    expect(e.candidates).toEqual(["alice.MD.md", "alice.MD/index.md"]);
  });
});

describe("wikilink resolution — path normalization within the root", () => {
  it("collapses '.' segments", () => {
    expect(norm("moc/./alice", "a.md", true).candidates).toEqual([
      "moc/alice.md",
      "moc/alice/index.md",
    ]);
  });

  it("applies '..' segments within the root", () => {
    expect(norm("moc/sub/../alice", "a.md", true).candidates).toEqual([
      "moc/alice.md",
      "moc/alice/index.md",
    ]);
  });

  it("yields no candidate when '..' escapes the repo root", () => {
    const e = norm("../../etc/passwd", "a.md", true);
    expect(e.candidates).toEqual([]);
  });

  it("collapses redundant internal slashes", () => {
    expect(norm("moc//alice", "a.md", true).candidates).toEqual([
      "moc/alice.md",
      "moc/alice/index.md",
    ]);
  });
});

describe("wikilink resolution — anchors and case", () => {
  it("keeps an anchor on a wikilink target_raw, strips it from candidates", () => {
    const e = norm("foo#section", "a.md", true);
    expect(e.target_raw).toBe("foo.md#section");
    expect(e.candidates).toEqual(["foo.md", "foo/index.md"]);
  });

  it("keeps an anchor on an explicit-.md wikilink", () => {
    const e = norm("foo.md#section", "a.md", true);
    expect(e.target_raw).toBe("foo.md#section");
    expect(e.candidates).toEqual(["foo.md"]);
  });

  it("preserves case byte-exact in candidates (no lowercasing)", () => {
    expect(norm("People/Alice", "a.md", true).candidates).toEqual([
      "People/Alice.md",
      "People/Alice/index.md",
    ]);
  });

  it("preserves spaces in a wikilink target", () => {
    expect(norm("My Note", "a.md", true).candidates).toEqual(["My Note.md", "My Note/index.md"]);
  });
});

describe("wikilink resolution — config knobs", () => {
  it("honors a custom index_basename", () => {
    const cfg = mergeConfig(HARDCODED_DEFAULTS, {
      resolution: { ...HARDCODED_DEFAULTS.resolution, index_basename: "_index" },
    });
    expect(norm("alice", "a.md", true, cfg).candidates).toEqual(["alice.md", "alice/_index.md"]);
  });

  it("takes the wikilink literally (no .md) when elision is disabled", () => {
    const cfg = mergeConfig(HARDCODED_DEFAULTS, {
      resolution: { ...HARDCODED_DEFAULTS.resolution, wikilink_elision: false },
    });
    const e = norm("alice", "a.md", true, cfg);
    expect(e.target_raw).toBe("alice");
    expect(e.candidates).toEqual(["alice"]);
  });

  it("with elision off, still normalizes '.'/'..' and strips the anchor from candidates", () => {
    const cfg = mergeConfig(HARDCODED_DEFAULTS, {
      resolution: { ...HARDCODED_DEFAULTS.resolution, wikilink_elision: false },
    });
    const e = norm("moc/../alice#sec", "a.md", true, cfg);
    expect(e.target_raw).toBe("alice#sec");
    expect(e.candidates).toEqual(["alice"]);
  });

  it("drops the anchor from target_raw when preserve_anchors is off", () => {
    const cfg = mergeConfig(HARDCODED_DEFAULTS, {
      resolution: { ...HARDCODED_DEFAULTS.resolution, preserve_anchors: false },
    });
    const e = norm("foo#section", "a.md", true, cfg);
    expect(e.target_raw).toBe("foo.md");
    expect(e.candidates).toEqual(["foo.md", "foo/index.md"]);
  });
});
