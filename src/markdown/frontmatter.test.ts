import { describe, expect, it } from "vitest";
import { FrontmatterInvalidError, join, parse, split } from "./frontmatter.js";

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
