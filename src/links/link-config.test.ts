import { describe, expect, it } from "vitest";
import { KernelError } from "../kernel/errors.js";
import {
  ConfigError,
  DEFAULT_BODY_SYNTAXES,
  DEFAULT_FRONTMATTER_SYNTAXES,
  HARDCODED_DEFAULTS,
  type LinkConfig,
  type LinkConfigOverride,
  effectiveLinkConfig,
  mergeConfig,
  parseRepoOverride,
  validateConfig,
  validateRepoOverride,
} from "./link-config.js";

describe("HARDCODED_DEFAULTS", () => {
  it("enables all body syntaxes and a frontmatter profile with fullpath + wikilink + inline", () => {
    expect(HARDCODED_DEFAULTS).toEqual({
      body: DEFAULT_BODY_SYNTAXES,
      frontmatter: DEFAULT_FRONTMATTER_SYNTAXES,
      resolution: { wikilink_elision: true, preserve_anchors: true, index_basename: "index" },
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

  it("replaces frontmatter wholesale, leaving body + resolution inherited", () => {
    const result = mergeConfig(HARDCODED_DEFAULTS, {
      frontmatter: { inline: false, reference: false, autolink: false, wikilink: false, fullpath: false },
    });
    expect(result.frontmatter.fullpath).toBe(false);
    expect(result.body).toEqual(HARDCODED_DEFAULTS.body);
    expect(result.resolution).toEqual(HARDCODED_DEFAULTS.resolution);
  });

  it("replaces the whole body object (no per-key merge)", () => {
    const result = mergeConfig(HARDCODED_DEFAULTS, {
      body: { inline: true, reference: false, autolink: false, wikilink: false, fullpath: false },
    });
    expect(result.body.wikilink).toBe(false);
    expect(result.frontmatter).toEqual(HARDCODED_DEFAULTS.frontmatter);
  });
});

describe("effectiveLinkConfig", () => {
  it("is a shortcut for mergeConfig", () => {
    const override: LinkConfigOverride = {
      frontmatter: { ...DEFAULT_FRONTMATTER_SYNTAXES, fullpath: false },
    };
    expect(effectiveLinkConfig(HARDCODED_DEFAULTS, override)).toEqual(
      mergeConfig(HARDCODED_DEFAULTS, override),
    );
  });

  it("layers server over defaults, then repo over server", () => {
    const server = mergeConfig(HARDCODED_DEFAULTS, {
      body: { inline: true, reference: true, autolink: true, wikilink: false, fullpath: true },
    });
    const effective = effectiveLinkConfig(server, {
      frontmatter: { ...DEFAULT_FRONTMATTER_SYNTAXES, wikilink: false },
    });
    expect(effective.body.wikilink).toBe(false);
    expect(effective.frontmatter.wikilink).toBe(false);
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
    expect(parseRepoOverride('{"frontmatter":{"fullpath":false}}')).toEqual({
      frontmatter: { fullpath: false },
    });
  });
  it("rejects non-object JSON", () => {
    expect(() => parseRepoOverride('["nope"]')).toThrow(/expected object/);
  });
});

describe("validateConfig", () => {
  it("accepts the hardcoded defaults", () => {
    expect(() => validateConfig(HARDCODED_DEFAULTS)).not.toThrow();
  });

  it("rejects a non-boolean syntax knob", () => {
    const cfg: LinkConfig = {
      ...HARDCODED_DEFAULTS,
      body: { ...HARDCODED_DEFAULTS.body, inline: "yes" as unknown as boolean },
    };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
    expect(() => validateConfig(cfg)).toThrow(/body.inline must be a boolean/);
  });

  it("rejects an empty index_basename", () => {
    const cfg: LinkConfig = {
      ...HARDCODED_DEFAULTS,
      resolution: { ...HARDCODED_DEFAULTS.resolution, index_basename: "" },
    };
    expect(() => validateConfig(cfg)).toThrow(/index_basename must be a non-empty string/);
  });
});

describe("validateRepoOverride", () => {
  it("accepts an override that merges cleanly", () => {
    expect(() =>
      validateRepoOverride({ frontmatter: { ...DEFAULT_FRONTMATTER_SYNTAXES, fullpath: false } }, HARDCODED_DEFAULTS),
    ).not.toThrow();
  });

  it("throws link_config_invalid (KernelError) on a bad merge", () => {
    try {
      validateRepoOverride(
        { body: { ...DEFAULT_BODY_SYNTAXES, inline: "nope" as unknown as boolean } },
        HARDCODED_DEFAULTS,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("link_config_invalid");
    }
  });
});
