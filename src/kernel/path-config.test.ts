import { describe, expect, it } from "vitest";
import {
  ConfigError,
  HARDCODED_DEFAULTS,
  type PathConfig,
  type PathConfigOverride,
  effectivePathConfig,
  mergeConfig,
  parseRepoOverride,
  validateConfig,
  validateRepoOverride,
} from "./path-config.js";

describe("HARDCODED_DEFAULTS", () => {
  it("matches the design §3.5.2 defaults (Obsidian-safe minus /)", () => {
    expect(HARDCODED_DEFAULTS).toEqual({
      disallowed_chars: ["\\", "<", ">", ":", "|", "?", '"'],
      system_sigils: [":"],
      hidden_sigils: ["."],
    });
  });

  it("passes validateConfig", () => {
    expect(() => validateConfig(HARDCODED_DEFAULTS)).not.toThrow();
  });
});

describe("mergeConfig (replace-not-merge)", () => {
  it("returns base unchanged when override is null", () => {
    expect(mergeConfig(HARDCODED_DEFAULTS, null)).toEqual(HARDCODED_DEFAULTS);
  });

  it("replaces a field wholesale, not deep-merging", () => {
    const result = mergeConfig(HARDCODED_DEFAULTS, { hidden_sigils: [".", "_"] });
    expect(result.hidden_sigils).toEqual([".", "_"]);
    expect(result.system_sigils).toEqual([":"]); // inherited
    expect(result.disallowed_chars).toEqual(HARDCODED_DEFAULTS.disallowed_chars);
  });

  it("replaces disallowed_chars only, leaving sigils inherited", () => {
    const result = mergeConfig(HARDCODED_DEFAULTS, { disallowed_chars: [] });
    expect(result.disallowed_chars).toEqual([]);
    expect(result.system_sigils).toEqual([":"]);
    expect(result.hidden_sigils).toEqual(["."]);
  });
});

describe("effectivePathConfig", () => {
  it("is a shortcut for mergeConfig", () => {
    const override: PathConfigOverride = { hidden_sigils: ["_"] };
    expect(effectivePathConfig(HARDCODED_DEFAULTS, override)).toEqual(
      mergeConfig(HARDCODED_DEFAULTS, override),
    );
  });
});

describe("parseRepoOverride", () => {
  it("null → null", () => {
    expect(parseRepoOverride(null)).toBeNull();
  });
  it('"null" → null', () => {
    expect(parseRepoOverride("null")).toBeNull();
  });
  it("parses a valid object", () => {
    expect(parseRepoOverride('{"hidden_sigils":[".","_"]}')).toEqual({
      hidden_sigils: [".", "_"],
    });
  });
  it("rejects non-object JSON", () => {
    expect(() => parseRepoOverride('["nope"]')).toThrow(/expected object/);
  });
});

describe("validateConfig — startup invariants (§3.5.2)", () => {
  it("accepts the hardcoded defaults", () => {
    expect(() => validateConfig(HARDCODED_DEFAULTS)).not.toThrow();
  });

  it("accepts multi-character sigils that don't prefix-shadow", () => {
    const cfg: PathConfig = {
      disallowed_chars: [],
      system_sigils: ["__sys_"],
      hidden_sigils: ["~$"],
    };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("rejects a disallowed_chars entry that is not a single char", () => {
    const cfg: PathConfig = { ...HARDCODED_DEFAULTS, disallowed_chars: ["ab"] };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
    expect(() => validateConfig(cfg)).toThrow(/single character/);
  });

  it("rejects an empty sigil", () => {
    const cfg: PathConfig = { ...HARDCODED_DEFAULTS, system_sigils: [""] };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
    expect(() => validateConfig(cfg)).toThrow(/non-empty string/);
  });

  it("rejects the path separator '/' inside disallowed_chars", () => {
    const cfg: PathConfig = { ...HARDCODED_DEFAULTS, disallowed_chars: ["/"] };
    expect(() => validateConfig(cfg)).toThrow(/path separator/);
  });

  it("rejects the path separator inside a sigil", () => {
    const cfg: PathConfig = { ...HARDCODED_DEFAULTS, system_sigils: ["a/b"] };
    expect(() => validateConfig(cfg)).toThrow(/path separator/);
  });

  it("rejects a sigil that is a prefix of another sigil (same list)", () => {
    const cfg: PathConfig = {
      ...HARDCODED_DEFAULTS,
      system_sigils: [":", ":h"],
    };
    expect(() => validateConfig(cfg)).toThrow(/prefix/);
  });

  it("rejects a sigil that is a prefix of a sigil in the OTHER list", () => {
    const cfg: PathConfig = {
      disallowed_chars: [],
      system_sigils: [":"],
      hidden_sigils: [":h"],
    };
    expect(() => validateConfig(cfg)).toThrow(/prefix/);
  });

  it("rejects a hidden sigil containing a disallowed char", () => {
    const cfg: PathConfig = {
      disallowed_chars: ["_"],
      system_sigils: [":"],
      hidden_sigils: ["_"],
    };
    expect(() => validateConfig(cfg)).toThrow(/hidden sigil.*disallowed/);
  });

  it("PERMITS a system sigil containing a disallowed char (users never write those)", () => {
    const cfg: PathConfig = {
      disallowed_chars: [":"],
      system_sigils: [":"],
      hidden_sigils: ["."],
    };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("rejects an empty system_sigils list", () => {
    const cfg: PathConfig = { ...HARDCODED_DEFAULTS, system_sigils: [] };
    expect(() => validateConfig(cfg)).toThrow(/system_sigils.*non-empty/);
  });

  it("rejects an empty hidden_sigils list", () => {
    const cfg: PathConfig = { ...HARDCODED_DEFAULTS, hidden_sigils: [] };
    expect(() => validateConfig(cfg)).toThrow(/hidden_sigils.*non-empty/);
  });
});

describe("validateRepoOverride", () => {
  it("accepts an override that merges cleanly", () => {
    expect(() =>
      validateRepoOverride({ hidden_sigils: [".", "_"] }, HARDCODED_DEFAULTS),
    ).not.toThrow();
  });

  it("rejects an override that would violate an invariant post-merge", () => {
    // System stays ":"; override sets hidden to ":h" — now a system sigil
    // prefix-shadows a hidden sigil.
    expect(() => validateRepoOverride({ hidden_sigils: [":h"] }, HARDCODED_DEFAULTS)).toThrow(
      /prefix/,
    );
  });
});
