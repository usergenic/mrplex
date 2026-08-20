import { describe, expect, it } from "vitest";
import { KernelError } from "../kernel/errors.js";
import {
  ConfigError,
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
  it("matches the §11.2 defaults (body syntaxes on, fields opt-in)", () => {
    expect(HARDCODED_DEFAULTS).toEqual({
      syntaxes: { inline: true, reference: true, autolink: true, wikilink: true },
      fields: [],
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

  it("replaces fields wholesale, leaving syntaxes + resolution inherited", () => {
    const result = mergeConfig(HARDCODED_DEFAULTS, { fields: ["parent", "related"] });
    expect(result.fields).toEqual(["parent", "related"]);
    expect(result.syntaxes).toEqual(HARDCODED_DEFAULTS.syntaxes);
    expect(result.resolution).toEqual(HARDCODED_DEFAULTS.resolution);
  });

  it("replaces the whole syntaxes object (decision 7 — no per-key merge)", () => {
    const result = mergeConfig(HARDCODED_DEFAULTS, {
      syntaxes: { inline: true, reference: false, autolink: false, wikilink: false },
    });
    expect(result.syntaxes).toEqual({
      inline: true,
      reference: false,
      autolink: false,
      wikilink: false,
    });
    // fields + resolution still inherited
    expect(result.fields).toEqual([]);
    expect(result.resolution).toEqual(HARDCODED_DEFAULTS.resolution);
  });
});

describe("effectiveLinkConfig", () => {
  it("is a shortcut for mergeConfig", () => {
    const override: LinkConfigOverride = { fields: ["parent"] };
    expect(effectiveLinkConfig(HARDCODED_DEFAULTS, override)).toEqual(
      mergeConfig(HARDCODED_DEFAULTS, override),
    );
  });

  it("layers server over defaults, then repo over server", () => {
    const server = mergeConfig(HARDCODED_DEFAULTS, {
      syntaxes: { inline: true, reference: true, autolink: true, wikilink: false },
    });
    const effective = effectiveLinkConfig(server, { fields: ["parent"] });
    expect(effective.syntaxes.wikilink).toBe(false); // from server
    expect(effective.fields).toEqual(["parent"]); // from repo
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
    expect(parseRepoOverride('{"fields":["parent"]}')).toEqual({ fields: ["parent"] });
  });
  it("rejects non-object JSON", () => {
    expect(() => parseRepoOverride('["nope"]')).toThrow(/expected object/);
  });
});

describe("validateConfig", () => {
  it("accepts the hardcoded defaults", () => {
    expect(() => validateConfig(HARDCODED_DEFAULTS)).not.toThrow();
  });

  it("accepts declared frontmatter field paths (dot + bracket)", () => {
    const cfg: LinkConfig = {
      ...HARDCODED_DEFAULTS,
      fields: ["parent", "project.lead", 'owners["team-lead"]', "stakeholders.name"],
    };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("rejects a non-boolean syntax knob", () => {
    const cfg = {
      ...HARDCODED_DEFAULTS,
      syntaxes: { ...HARDCODED_DEFAULTS.syntaxes, inline: "yes" as unknown as boolean },
    };
    expect(() => validateConfig(cfg)).toThrow(ConfigError);
    expect(() => validateConfig(cfg)).toThrow(/syntaxes.inline must be a boolean/);
  });

  it("rejects an empty field path", () => {
    const cfg: LinkConfig = { ...HARDCODED_DEFAULTS, fields: [""] };
    expect(() => validateConfig(cfg)).toThrow(/valid CEL field path/);
  });

  it("rejects a '$body' declared field (sentinel, not a field)", () => {
    const cfg: LinkConfig = { ...HARDCODED_DEFAULTS, fields: ["$body"] };
    expect(() => validateConfig(cfg)).toThrow(/valid CEL field path/);
  });

  it("rejects a field path with an array index", () => {
    const cfg: LinkConfig = { ...HARDCODED_DEFAULTS, fields: ["stakeholders[0].name"] };
    expect(() => validateConfig(cfg)).toThrow(/valid CEL field path/);
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
    expect(() => validateRepoOverride({ fields: ["parent"] }, HARDCODED_DEFAULTS)).not.toThrow();
  });

  it("throws link_config_invalid (KernelError) on a bad merge", () => {
    try {
      validateRepoOverride({ fields: ["bad index[0]"] }, HARDCODED_DEFAULTS);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("link_config_invalid");
    }
  });
});
