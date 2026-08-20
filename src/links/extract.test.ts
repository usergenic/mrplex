import { describe, expect, it } from "vitest";
import type { FrontmatterJson } from "../markdown/frontmatter.js";
import { BODY_FIELD, type RawEdge, extractEdges } from "./extract.js";
import { HARDCODED_DEFAULTS, type LinkConfig, mergeConfig } from "./link-config.js";

function extract(
  body: string,
  opts: { frontmatter?: FrontmatterJson; config?: LinkConfig } = {},
): RawEdge[] {
  return extractEdges({
    body,
    frontmatter: opts.frontmatter ?? {},
    config: opts.config ?? HARDCODED_DEFAULTS,
  });
}

const targets = (edges: RawEdge[]) => edges.map((e) => e.target);

describe("inline links", () => {
  it("extracts the destination, ignores link text and title", () => {
    const edges = extract('See [Alice](people/alice.md "the title") here.');
    expect(edges).toEqual([
      { ord: 0, field: BODY_FIELD, target: "people/alice.md", wikilink: false },
    ]);
  });

  it("extracts multiple links in document order", () => {
    expect(targets(extract("[a](one.md) then [b](two.md)"))).toEqual(["one.md", "two.md"]);
  });

  it("preserves anchors on the raw target", () => {
    expect(targets(extract("[x](foo.md#section)"))).toEqual(["foo.md#section"]);
  });

  it("strips pointy-bracket destinations, keeping the inner path", () => {
    expect(targets(extract("[a](<path/to/thing.md>)"))).toEqual(["path/to/thing.md"]);
  });

  it("preserves spaces inside a pointy-bracket destination", () => {
    expect(targets(extract("[b](<path with spaces.md>)"))).toEqual(["path with spaces.md"]);
  });

  it("keeps an anchor inside a pointy-bracket destination", () => {
    expect(targets(extract("[c](<foo.md#sec>)"))).toEqual(["foo.md#sec"]);
  });
});

describe("reference links", () => {
  it("resolves full references against their definition", () => {
    expect(targets(extract("Ref [Bob][b].\n\n[b]: people/bob.md"))).toEqual(["people/bob.md"]);
  });

  it("resolves collapsed and shortcut references", () => {
    expect(targets(extract("[Carol][] and [Dave]\n\n[carol]: c.md\n[dave]: d.md"))).toEqual([
      "c.md",
      "d.md",
    ]);
  });

  it("does not emit an edge for a reference with no matching definition", () => {
    expect(extract("[ghost] and [miss][nope] here.")).toEqual([]);
  });

  it("strips pointy-bracket destinations in a definition (spaces preserved)", () => {
    expect(targets(extract("Ref [a][x].\n\n[x]: <path with spaces.md>"))).toEqual([
      "path with spaces.md",
    ]);
  });
});

describe("images (! is a cosmetic embed prefix, not a type)", () => {
  it("extracts an image destination as an ordinary edge", () => {
    expect(targets(extract("![diagram](img/arch.png)"))).toEqual(["img/arch.png"]);
  });

  it("rides the inline toggle, not a separate image knob", () => {
    const noInline = mergeConfig(HARDCODED_DEFAULTS, {
      syntaxes: { inline: false, reference: true, autolink: true, wikilink: true },
    });
    expect(extract("![diagram](img/arch.png)", { config: noInline })).toEqual([]);
  });
});

describe("code exclusion", () => {
  it("ignores links inside inline code spans", () => {
    expect(extract("Inline `[nope](x.md)` code.")).toEqual([]);
  });

  it("ignores links inside fenced code blocks", () => {
    expect(extract("```\n[nope](y.md)\n```")).toEqual([]);
  });

  it("ignores links inside indented code blocks", () => {
    expect(extract("    [nope](z.md)")).toEqual([]);
  });

  it("still extracts real links around code", () => {
    expect(targets(extract("`[no](x.md)` but [yes](real.md)"))).toEqual(["real.md"]);
  });
});

describe("wikilinks", () => {
  it("extracts the page half, dropping the display half", () => {
    const edges = extract("[[alice]] and [[bob|Bob Smith]]");
    expect(edges).toEqual([
      { ord: 0, field: BODY_FIELD, target: "alice", wikilink: true },
      { ord: 1, field: BODY_FIELD, target: "bob", wikilink: true },
    ]);
  });

  it("treats ![[embed]] the same as [[embed]] (cosmetic prefix)", () => {
    expect(extract("![[page]]")).toEqual([
      { ord: 0, field: BODY_FIELD, target: "page", wikilink: true },
    ]);
  });

  it("keeps an anchor on the wikilink target", () => {
    expect(targets(extract("[[foo#section]]"))).toEqual(["foo#section"]);
  });

  it("is excluded inside code", () => {
    expect(extract("`[[nope]]`")).toEqual([]);
    expect(extract("```\n[[nope]]\n```")).toEqual([]);
  });

  it("is disabled when the wikilink syntax is off", () => {
    const off = mergeConfig(HARDCODED_DEFAULTS, {
      syntaxes: { inline: true, reference: true, autolink: true, wikilink: false },
    });
    expect(extract("[[alice]]", { config: off })).toEqual([]);
  });
});

describe("mixed body ordering", () => {
  it("interleaves inline and wikilink hits by source offset", () => {
    const edges = extract("[a](one.md) [[two]] [b](three.md)");
    expect(targets(edges)).toEqual(["one.md", "two", "three.md"]);
    expect(edges.map((e) => e.ord)).toEqual([0, 1, 2]);
  });
});

describe("frontmatter reference fields", () => {
  const withFields = (fields: string[]) => mergeConfig(HARDCODED_DEFAULTS, { fields });

  it("extracts a scalar field value under the declaring field path", () => {
    const edges = extract("", {
      frontmatter: { parent: "moc/employees.md" },
      config: withFields(["parent"]),
    });
    expect(edges).toEqual([
      { ord: 0, field: "parent", target: "moc/employees.md", wikilink: false },
    ]);
  });

  it("extracts list values as distinct ords under the same field", () => {
    const edges = extract("", {
      frontmatter: { related: ["alice.md", "bob.md"] },
      config: withFields(["related"]),
    });
    expect(edges).toEqual([
      { ord: 0, field: "related", target: "alice.md", wikilink: false },
      { ord: 1, field: "related", target: "bob.md", wikilink: false },
    ]);
  });

  it("reaches terminal string paths through list-of-objects (stakeholders.name)", () => {
    const edges = extract("", {
      frontmatter: {
        stakeholders: [
          { name: "alice.md", role: "lead" },
          { name: "bob.md", role: "eng" },
        ],
      },
      config: withFields(["stakeholders.name"]),
    });
    expect(targets(edges)).toEqual(["alice.md", "bob.md"]);
  });

  it("terminal-fields rule: a non-terminal path extracts nothing", () => {
    const edges = extract("", {
      frontmatter: {
        stakeholders: [
          { name: "alice.md", role: "lead" },
          { name: "bob.md", role: "eng" },
        ],
      },
      config: withFields(["stakeholders"]),
    });
    expect(edges).toEqual([]);
  });

  it("extracts nothing when fields are not opted in", () => {
    expect(extract("", { frontmatter: { parent: "moc/employees.md" } })).toEqual([]);
  });

  it("body edges come before frontmatter edges in ord order", () => {
    const edges = extract("[a](one.md)", {
      frontmatter: { parent: "p.md" },
      config: withFields(["parent"]),
    });
    expect(edges).toEqual([
      { ord: 0, field: BODY_FIELD, target: "one.md", wikilink: false },
      { ord: 1, field: "parent", target: "p.md", wikilink: false },
    ]);
  });
});

describe("determinism", () => {
  it("same input → identical edges", () => {
    const body = "[a](one.md) [[two]] ![img](p.png)\n\n[a]: unused.md";
    expect(extract(body)).toEqual(extract(body));
  });
});
