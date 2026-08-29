import { describe, expect, it } from "vitest";
import { KernelError } from "./errors.js";
import {
  type EffectivePathConfig,
  SLUG_MAX_LENGTH,
  isPathGlobPattern,
  normalizeExactDocumentPath,
  pathHasSigilSegment,
  validatePath,
  validateSlug,
} from "./validation.js";

const DEFAULT_CONFIG: EffectivePathConfig = {
  disallowed_chars: ["\\", "<", ">", ":", "|", "?", '"'],
  system_sigils: [":"],
  hidden_sigils: ["."],
};

function expectPathInvalid(fn: () => void, expectedReasonSubstring: string): void {
  try {
    fn();
    throw new Error("expected path_invalid");
  } catch (err) {
    expect(err).toBeInstanceOf(KernelError);
    const ke = err as KernelError<{ reason: string }>;
    expect(ke.code).toBe("path_invalid");
    expect(ke.data.reason).toContain(expectedReasonSubstring);
  }
}

function expectSlugInvalid(fn: () => void, expectedReasonSubstring: string): void {
  try {
    fn();
    throw new Error("expected slug_invalid");
  } catch (err) {
    expect(err).toBeInstanceOf(KernelError);
    const ke = err as KernelError<{ reason: string }>;
    expect(ke.code).toBe("slug_invalid");
    expect(ke.data.reason).toContain(expectedReasonSubstring);
  }
}

describe("normalizeExactDocumentPath", () => {
  it("accepts canonical slashless paths unchanged", () => {
    expect(normalizeExactDocumentPath("projects/foo.md", DEFAULT_CONFIG)).toBe("projects/foo.md");
  });

  it("strips exactly one leading slash (repository-root alias)", () => {
    expect(normalizeExactDocumentPath("/AGENTS.md", DEFAULT_CONFIG)).toBe("AGENTS.md");
    expect(normalizeExactDocumentPath("/projects/foo.md", DEFAULT_CONFIG)).toBe("projects/foo.md");
  });

  it("is idempotent", () => {
    for (const p of ["foo.md", "/foo.md", "a/b/c.md"]) {
      const once = normalizeExactDocumentPath(p, DEFAULT_CONFIG);
      expect(normalizeExactDocumentPath(once, DEFAULT_CONFIG)).toBe(once);
    }
  });

  it("normalizes alias and canonical to the same identity key", () => {
    expect(normalizeExactDocumentPath("foo.md", DEFAULT_CONFIG)).toBe(
      normalizeExactDocumentPath("/foo.md", DEFAULT_CONFIG),
    );
  });

  describe("rejections", () => {
    it("rejects empty and lone slash", () => {
      expectPathInvalid(() => normalizeExactDocumentPath("", DEFAULT_CONFIG), "empty");
      expectPathInvalid(() => normalizeExactDocumentPath("/", DEFAULT_CONFIG), "empty");
    });
    it("rejects multiple leading slashes", () => {
      expectPathInvalid(() => normalizeExactDocumentPath("//foo.md", DEFAULT_CONFIG), "multiple");
    });
    it("rejects backslashes", () => {
      expectPathInvalid(() => normalizeExactDocumentPath("foo\\bar.md", DEFAULT_CONFIG), "backslash");
    });
    it("rejects traversal and reserved segments after alias strip", () => {
      expectPathInvalid(() => normalizeExactDocumentPath("/../foo.md", DEFAULT_CONFIG), "reserved");
      expectPathInvalid(() => normalizeExactDocumentPath("./foo.md", DEFAULT_CONFIG), "reserved");
    });
    it("rejects system sigil paths regardless of leading slash", () => {
      expectPathInvalid(
        () => normalizeExactDocumentPath("/:deleted/foo.md", DEFAULT_CONFIG),
        "system sigil",
      );
    });
  });
});

describe("isPathGlobPattern", () => {
  it("detects glob metacharacters", () => {
    expect(isPathGlobPattern("/projects/*.md")).toBe(true);
    expect(isPathGlobPattern("people/?.md")).toBe(true);
  });
  it("treats literal paths as non-patterns", () => {
    expect(isPathGlobPattern("projects/foo.md")).toBe(false);
    expect(isPathGlobPattern("/AGENTS.md")).toBe(false);
  });
});

describe("validatePath", () => {
  describe("accepts", () => {
    for (const good of [
      "hello.md",
      "notes/readme.md",
      "guides/getting-started.md",
      "a/b/c/d/e.md",
      "README",
      "file-with-hyphens.md",
      "under_scores.md",
      "with spaces.md", // space is not in default disallowed_chars
      "unicode-café.md",
    ]) {
      it(`"${good}"`, () => {
        expect(() => validatePath(good, DEFAULT_CONFIG)).not.toThrow();
      });
    }
  });

  describe("structural rejections (§3.5.1)", () => {
    it("rejects empty", () => {
      expectPathInvalid(() => validatePath("", DEFAULT_CONFIG), "empty");
    });
    it("rejects leading /", () => {
      expectPathInvalid(() => validatePath("/foo.md", DEFAULT_CONFIG), "leading '/'");
    });
    it("rejects trailing /", () => {
      expectPathInvalid(() => validatePath("foo/", DEFAULT_CONFIG), "trailing '/'");
    });
    it("rejects //", () => {
      expectPathInvalid(() => validatePath("a//b.md", DEFAULT_CONFIG), "reserved");
    });
    it('rejects "." segment', () => {
      expectPathInvalid(() => validatePath("./foo.md", DEFAULT_CONFIG), "reserved");
    });
    it('rejects ".." segment', () => {
      expectPathInvalid(() => validatePath("a/../b.md", DEFAULT_CONFIG), "reserved");
    });
    it('rejects a lone "."', () => {
      expectPathInvalid(() => validatePath(".", DEFAULT_CONFIG), "reserved");
    });
  });

  describe("sigil rejections (§3.5.3)", () => {
    it("rejects segment starting with system sigil at root", () => {
      expectPathInvalid(() => validatePath(":deleted/foo.md", DEFAULT_CONFIG), "system sigil");
    });
    it("rejects segment starting with system sigil deep in path", () => {
      expectPathInvalid(() => validatePath("notes/:bad.md", DEFAULT_CONFIG), "system sigil");
    });
    it("multi-char sigil is honored", () => {
      const cfg: EffectivePathConfig = { ...DEFAULT_CONFIG, system_sigils: ["__sys_"] };
      expectPathInvalid(() => validatePath("__sys_deleted/foo.md", cfg), "system sigil");
      expect(() => validatePath("_notsys/foo.md", cfg)).not.toThrow();
    });
    it("hidden sigil is NOT rejected on writes (users can write to their own hidden dirs)", () => {
      expect(() => validatePath(".obsidian/config.md", DEFAULT_CONFIG)).not.toThrow();
    });
  });

  describe("disallowed char rejections (§3.5.3)", () => {
    for (const ch of ["\\", "<", ">", ":", "|", "?", '"']) {
      it(`rejects "${ch}" in a segment`, () => {
        expectPathInvalid(() => validatePath(`a/b${ch}c.md`, DEFAULT_CONFIG), "disallowed");
      });
    }
    it("permits chars removed from disallowed_chars via per-repo override", () => {
      const cfg: EffectivePathConfig = { ...DEFAULT_CONFIG, disallowed_chars: [] };
      expect(() => validatePath("weird<name>.md", cfg)).not.toThrow();
    });
  });
});

describe("validateSlug", () => {
  describe("accepts", () => {
    for (const good of ["notes", "team-alpha", "under_scores", "abc123", "café"]) {
      it(`"${good}"`, () => {
        expect(() => validateSlug(good, DEFAULT_CONFIG)).not.toThrow();
      });
    }
  });

  describe("structural rejections", () => {
    it("rejects empty", () => {
      expectSlugInvalid(() => validateSlug("", DEFAULT_CONFIG), "reserved");
    });
    it('rejects "."', () => {
      expectSlugInvalid(() => validateSlug(".", DEFAULT_CONFIG), "reserved");
    });
    it('rejects ".."', () => {
      expectSlugInvalid(() => validateSlug("..", DEFAULT_CONFIG), "reserved");
    });
    it("rejects a slug containing /", () => {
      expectSlugInvalid(() => validateSlug("foo/bar", DEFAULT_CONFIG), "contains '/'");
    });
    it("rejects a slug longer than SLUG_MAX_LENGTH", () => {
      expectSlugInvalid(
        () => validateSlug("x".repeat(SLUG_MAX_LENGTH + 1), DEFAULT_CONFIG),
        `exceeds ${SLUG_MAX_LENGTH}`,
      );
    });
    it("accepts a slug exactly SLUG_MAX_LENGTH long", () => {
      expect(() => validateSlug("x".repeat(SLUG_MAX_LENGTH), DEFAULT_CONFIG)).not.toThrow();
    });
    it("rejects leading whitespace", () => {
      expectSlugInvalid(() => validateSlug(" notes", DEFAULT_CONFIG), "whitespace");
    });
    it("rejects trailing whitespace", () => {
      expectSlugInvalid(() => validateSlug("notes ", DEFAULT_CONFIG), "whitespace");
    });
    it("rejects control characters", () => {
      expectSlugInvalid(() => validateSlug("bad\x01slug", DEFAULT_CONFIG), "control");
      expectSlugInvalid(() => validateSlug("with\ttab", DEFAULT_CONFIG), "control");
      expectSlugInvalid(() => validateSlug("with\x7fdel", DEFAULT_CONFIG), "control");
    });
  });

  describe("sigil rejections (§3.5.6)", () => {
    it("rejects a slug starting with a system sigil (would collide with kernel-emitted slugs)", () => {
      expectSlugInvalid(() => validateSlug(":deleted-notes", DEFAULT_CONFIG), "system sigil");
    });
    it("rejects a slug starting with a hidden sigil", () => {
      expectSlugInvalid(() => validateSlug(".hidden", DEFAULT_CONFIG), "hidden sigil");
    });
  });

  describe("disallowed chars", () => {
    it("rejects disallowed chars in the middle of a slug", () => {
      expectSlugInvalid(() => validateSlug("bad:name", DEFAULT_CONFIG), "disallowed");
    });
  });
});

describe("pathHasSigilSegment", () => {
  it("returns true when the first segment starts with a sigil", () => {
    expect(pathHasSigilSegment(":deleted/foo.md", [":"])).toBe(true);
  });
  it("returns true for a mid-path sigil segment", () => {
    expect(pathHasSigilSegment("notes/.obsidian/config.md", ["."])).toBe(true);
  });
  it("returns false when no segment matches", () => {
    expect(pathHasSigilSegment("notes/readme.md", [":"])).toBe(false);
  });
  it("returns false for an empty sigil list", () => {
    expect(pathHasSigilSegment("anything", [])).toBe(false);
  });
  it("honors multi-character sigils", () => {
    expect(pathHasSigilSegment("__sys_deleted/foo.md", ["__sys_"])).toBe(true);
    expect(pathHasSigilSegment("_notsys/foo.md", ["__sys_"])).toBe(false);
  });
});
