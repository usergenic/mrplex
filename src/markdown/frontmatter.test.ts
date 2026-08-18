import { describe, expect, it } from "vitest";
import {
  FrontmatterInvalidError,
  appendSystemProperty,
  extractSystemProperties,
  join,
  parse,
  split,
} from "./frontmatter.js";

describe("split", () => {
  it("returns pure body when no frontmatter block is present", () => {
    expect(split("hello\nworld\n")).toEqual({
      frontmatter_raw: "",
      body: "hello\nworld\n",
    });
  });

  it("extracts frontmatter between delimiter lines", () => {
    expect(split("---\ntitle: hi\n---\nbody line\n")).toEqual({
      frontmatter_raw: "title: hi\n",
      body: "body line\n",
    });
  });

  it("extracts multi-line frontmatter", () => {
    expect(split("---\ntitle: hi\ntags: [a, b]\n---\n# heading\n\ntext\n")).toEqual({
      frontmatter_raw: "title: hi\ntags: [a, b]\n",
      body: "# heading\n\ntext\n",
    });
  });

  it("treats present-but-empty frontmatter as raw with just a newline", () => {
    expect(split("---\n\n---\nbody\n")).toEqual({
      frontmatter_raw: "\n",
      body: "body\n",
    });
  });

  it("recognizes immediately-adjacent delimiters (empty frontmatter, no blank line)", () => {
    // Closing --- appears right after the opening ---; the parser must not
    // skip over the shared newline. Round-trip is semantic, not byte-exact
    // (empty frontmatter collapses to no-frontmatter on rejoin).
    expect(split("---\n---\nbody\n")).toEqual({
      frontmatter_raw: "",
      body: "body\n",
    });
  });

  it("handles a document with only frontmatter and no body", () => {
    expect(split("---\ntitle: hi\n---\n")).toEqual({
      frontmatter_raw: "title: hi\n",
      body: "",
    });
  });

  it("treats a leading --- with no closing delimiter as body", () => {
    expect(split("---\ntitle: hi\nno close here\n")).toEqual({
      frontmatter_raw: "",
      body: "---\ntitle: hi\nno close here\n",
    });
  });

  it("handles empty input", () => {
    expect(split("")).toEqual({ frontmatter_raw: "", body: "" });
  });
});

describe("join", () => {
  it("omits the block when frontmatter_raw is empty", () => {
    expect(join({ frontmatter_raw: "", body: "hello\n" })).toBe("hello\n");
  });

  it("emits canonical delimiters around non-empty frontmatter", () => {
    expect(join({ frontmatter_raw: "title: hi\n", body: "body\n" })).toBe(
      "---\ntitle: hi\n---\nbody\n",
    );
  });

  it("appends a trailing newline to raw if missing", () => {
    expect(join({ frontmatter_raw: "title: hi", body: "body\n" })).toBe(
      "---\ntitle: hi\n---\nbody\n",
    );
  });
});

describe("round-trip", () => {
  const canonicalSamples = [
    "hello\nworld\n",
    "---\ntitle: hi\n---\nbody line\n",
    "---\ntitle: hi\ntags: [a, b]\ncount: 3\n---\n# heading\n\ntext\n",
    "---\n\n---\nbody\n",
    "just a single line",
    "---\nfoo: bar\n---\n",
    "",
    "---\nfoo: bar\n---\n\n# body with blank line first\n",
  ];

  it.each(canonicalSamples)("join(split(x)) === x for %j", (sample) => {
    expect(join(split(sample))).toBe(sample);
  });
});

describe("parse", () => {
  it("returns {} for empty raw", () => {
    expect(parse("")).toEqual({});
  });

  it("parses a well-formed YAML map", () => {
    expect(parse("title: hi\ntags: [a, b]\n")).toEqual({ title: "hi", tags: ["a", "b"] });
  });

  it("returns {} for a null document", () => {
    expect(parse("\n")).toEqual({});
  });

  it("throws frontmatter_invalid on a YAML syntax error", () => {
    expect(() => parse("title: [unclosed")).toThrow(FrontmatterInvalidError);
  });

  it("throws frontmatter_invalid when the top level is a list", () => {
    expect(() => parse("- a\n- b\n")).toThrow(FrontmatterInvalidError);
  });

  it("throws frontmatter_invalid when the top level is a scalar", () => {
    expect(() => parse("just a string\n")).toThrow(FrontmatterInvalidError);
  });
});

describe("appendSystemProperty", () => {
  it("returns a single line when raw is empty", () => {
    expect(appendSystemProperty("", "version", "v42")).toBe("$version: v42\n");
  });

  it("appends to non-empty raw with an existing trailing newline", () => {
    expect(appendSystemProperty("title: hi\n", "version", "v42")).toBe(
      "title: hi\n$version: v42\n",
    );
  });

  it("ensures a trailing newline when raw lacks one", () => {
    expect(appendSystemProperty("title: hi", "version", "v42")).toBe("title: hi\n$version: v42\n");
  });

  it("emits numbers and booleans unquoted", () => {
    expect(appendSystemProperty("", "count", 3)).toBe("$count: 3\n");
    expect(appendSystemProperty("", "flag", true)).toBe("$flag: true\n");
  });
});

describe("extractSystemProperties", () => {
  it("returns raw unchanged and an empty map when no $-keys are present", () => {
    expect(extractSystemProperties("title: hi\n")).toEqual({
      raw: "title: hi\n",
      props: {},
    });
  });

  it("returns raw unchanged when raw is empty", () => {
    expect(extractSystemProperties("")).toEqual({ raw: "", props: {} });
  });

  it("strips a trailing $version line and returns the value", () => {
    expect(extractSystemProperties("title: hi\n$version: v42\n")).toEqual({
      raw: "title: hi\n",
      props: { version: "v42" },
    });
  });

  it("strips a leading $version line", () => {
    expect(extractSystemProperties("$version: v42\ntitle: hi\n")).toEqual({
      raw: "title: hi\n",
      props: { version: "v42" },
    });
  });

  it("strips multiple system properties in one pass", () => {
    expect(extractSystemProperties("$version: v42\ntitle: hi\n$author: alice\n")).toEqual({
      raw: "title: hi\n",
      props: { version: "v42", author: "alice" },
    });
  });

  it("does not strip nested $-keys inside a map body (indented)", () => {
    const raw = "meta:\n  $note: keep me\n";
    expect(extractSystemProperties(raw)).toEqual({ raw, props: {} });
  });

  it("preserves user-authored content byte-exact around a stripped line", () => {
    // Comment above, list below — none of it touched.
    const raw = "# a comment\ntitle: hi\n$version: v42\ntags:\n  - a\n  - b\n";
    const { raw: cleaned, props } = extractSystemProperties(raw);
    expect(cleaned).toBe("# a comment\ntitle: hi\ntags:\n  - a\n  - b\n");
    expect(props).toEqual({ version: "v42" });
  });

  it("round-trips: extract(append(x, k, v)) recovers x and {k: v}", () => {
    const original = "title: hi\ntags: [a, b]\n";
    const withProp = appendSystemProperty(original, "version", "v99");
    expect(extractSystemProperties(withProp)).toEqual({
      raw: original,
      props: { version: "v99" },
    });
  });
});
