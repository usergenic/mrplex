import { describe, expect, it } from "vitest";
import { compileGlob, globToRegexSource, pathMatchesGlobs, slugMatchesPattern } from "./glob.js";

describe("compileGlob", () => {
  describe("** (any subtree)", () => {
    it("** matches any path", () => {
      const rx = compileGlob("**");
      expect(rx.test("foo.md")).toBe(true);
      expect(rx.test("a/b/c.md")).toBe(true);
      expect(rx.test("")).toBe(true);
    });

    it("bare ** compiles without a redundant any-depth prefix", () => {
      // `(?:.*/)?` is subsumed by the trailing `.*` — emitting it is dead text.
      expect(globToRegexSource("**")).toBe(".*");
    });

    it("drafts/** matches everything strictly inside drafts/", () => {
      const rx = compileGlob("drafts/**");
      expect(rx.test("drafts/foo.md")).toBe(true);
      expect(rx.test("drafts/sub/deep.md")).toBe(true);
      expect(rx.test("drafts")).toBe(false);
      expect(rx.test("drafts.md")).toBe(false);
      expect(rx.test("notes/drafts/foo.md")).toBe(false);
    });

    it("a/**/z matches zero or more segments between", () => {
      // Gitignore: middle `**/` is zero-or-more segments — `a/z` matches.
      const rx = compileGlob("a/**/z");
      expect(rx.test("a/z")).toBe(true);
      expect(rx.test("a/x/z")).toBe(true);
      expect(rx.test("a/x/y/z")).toBe(true);
    });

    it("**/foo.md matches at any depth including root", () => {
      const rx = compileGlob("**/foo.md");
      expect(rx.test("foo.md")).toBe(true);
      expect(rx.test("a/foo.md")).toBe(true);
      expect(rx.test("a/b/foo.md")).toBe(true);
      expect(rx.test("bar.md")).toBe(false);
    });
  });

  describe("* (within-segment)", () => {
    it("drafts/* matches one level only", () => {
      const rx = compileGlob("drafts/*");
      expect(rx.test("drafts/foo.md")).toBe(true);
      expect(rx.test("drafts/sub/deep.md")).toBe(false);
      expect(rx.test("drafts")).toBe(false);
    });

    it("*.md is a bare basename — matches at any depth", () => {
      // Gitignore rule: patterns without `/` are basename-any-depth.
      const rx = compileGlob("*.md");
      expect(rx.test("foo.md")).toBe(true);
      expect(rx.test("foo.txt")).toBe(false);
      expect(rx.test("a/foo.md")).toBe(true);
      expect(rx.test("a/b/foo.md")).toBe(true);
    });
  });

  describe("basename-at-any-depth", () => {
    it("bare basename matches root and every subdirectory", () => {
      const rx = compileGlob("horses.md");
      expect(rx.test("horses.md")).toBe(true);
      expect(rx.test("racing/horses.md")).toBe(true);
      expect(rx.test("a/b/c/horses.md")).toBe(true);
      expect(rx.test("horses.md.bak")).toBe(false);
      expect(rx.test("horses-notes.md")).toBe(false);
    });

    it("adding a `/` to the pattern anchors it", () => {
      // `a/foo.md` contains `/`, so no basename-any-depth prefix.
      const rx = compileGlob("a/foo.md");
      expect(rx.test("a/foo.md")).toBe(true);
      expect(rx.test("x/a/foo.md")).toBe(false);
    });
  });

  describe("leading / — explicit root anchor", () => {
    it("/horses.md matches only root-level", () => {
      const rx = compileGlob("/horses.md");
      expect(rx.test("horses.md")).toBe(true);
      expect(rx.test("racing/horses.md")).toBe(false);
    });

    it("leading / disables the basename-any-depth rule", () => {
      const rx = compileGlob("/*.md");
      expect(rx.test("foo.md")).toBe(true);
      expect(rx.test("a/foo.md")).toBe(false);
    });
  });

  describe("literals + escapes", () => {
    it(". is a literal dot, not any-char", () => {
      const rx = compileGlob("/a.md");
      expect(rx.test("a.md")).toBe(true);
      expect(rx.test("axmd")).toBe(false);
    });

    it("regex specials are escaped", () => {
      const rx = compileGlob("/a+(b).md");
      expect(rx.test("a+(b).md")).toBe(true);
      expect(rx.test("a+bb.md")).toBe(false);
    });
  });

  describe("? single-char wildcard", () => {
    it("? matches one non-/ char", () => {
      const rx = compileGlob("/f?o.md");
      expect(rx.test("foo.md")).toBe(true);
      expect(rx.test("fao.md")).toBe(true);
      expect(rx.test("f/o.md")).toBe(false);
      expect(rx.test("fo.md")).toBe(false);
    });
  });
});

describe("pathMatchesGlobs (last-match-wins)", () => {
  it("returns false for an empty glob list", () => {
    expect(pathMatchesGlobs([], "foo.md")).toBe(false);
  });

  it("positive match wins", () => {
    expect(pathMatchesGlobs(["**"], "foo.md")).toBe(true);
  });

  it("later negation overrides earlier positive", () => {
    expect(pathMatchesGlobs(["drafts/**", "!drafts/pinned/**"], "drafts/foo.md")).toBe(true);
    expect(pathMatchesGlobs(["drafts/**", "!drafts/pinned/**"], "drafts/pinned/foo.md")).toBe(
      false,
    );
  });

  it("later positive overrides earlier negation", () => {
    expect(
      pathMatchesGlobs(
        ["drafts/**", "!drafts/pinned/**", "drafts/pinned/exception.md"],
        "drafts/pinned/exception.md",
      ),
    ).toBe(true);
  });

  it("no pattern matches → false", () => {
    expect(pathMatchesGlobs(["drafts/**"], "notes/foo.md")).toBe(false);
  });
});

describe("slugMatchesPattern", () => {
  it("exact literal", () => {
    expect(slugMatchesPattern("notes", "notes")).toBe(true);
    expect(slugMatchesPattern("notes", "other")).toBe(false);
  });

  it("* matches any slug", () => {
    expect(slugMatchesPattern("*", "notes")).toBe(true);
    expect(slugMatchesPattern("*", "team-alpha")).toBe(true);
  });

  it("prefix* matches by prefix", () => {
    expect(slugMatchesPattern("team-*", "team-alpha")).toBe(true);
    expect(slugMatchesPattern("team-*", "team-")).toBe(true);
    expect(slugMatchesPattern("team-*", "teem-alpha")).toBe(false);
  });
});
