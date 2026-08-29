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

/** Drop dest_span so exact-object assertions can ignore byte offsets. */
const stripSpans = (edges: RawEdge[]): Omit<RawEdge, "dest_span">[] =>
  edges.map(({ dest_span, ...rest }) => rest);

describe("inline links", () => {
  it("extracts the destination, ignores link text and title", () => {
    const edges = extract('See [Alice](people/alice.md "the title") here.');
    expect(stripSpans(edges)).toEqual([
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
      body: { inline: false, reference: true, autolink: true, wikilink: true, fullpath: true },
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
    expect(stripSpans(edges)).toEqual([
      { ord: 0, field: BODY_FIELD, target: "alice", wikilink: true },
      { ord: 1, field: BODY_FIELD, target: "bob", wikilink: true },
    ]);
  });

  it("treats ![[embed]] the same as [[embed]] (cosmetic prefix)", () => {
    expect(stripSpans(extract("![[page]]"))).toEqual([
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
      body: { inline: true, reference: true, autolink: true, wikilink: false, fullpath: true },
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

describe("fullpath syntax", () => {
  it("extracts repo-root paths from body prose", () => {
    expect(targets(extract("See /crew/alice.md for details."))).toEqual(["/crew/alice.md"]);
  });

  it("ignores fullpaths inside code", () => {
    expect(extract("`/crew/nope.md` but /crew/yes.md")).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: "/crew/yes.md" })]),
    );
    expect(extract("```\n/crew/nope.md\n```")).toEqual([]);
  });

  it("is disabled when the fullpath syntax is off", () => {
    const off = mergeConfig(HARDCODED_DEFAULTS, {
      body: { inline: true, reference: true, autolink: true, wikilink: true, fullpath: false },
    });
    expect(extract("/crew/alice.md", { config: off })).toEqual([]);
  });
});

describe("frontmatter string values", () => {
  it("extracts a repo-root fullpath scalar under the declaring field name", () => {
    const edges = extract("", {
      frontmatter: { parent: "/moc/employees.md" },
    });
    expect(edges).toEqual([
      { ord: 0, field: "parent", target: "/moc/employees.md", wikilink: false },
    ]);
  });

  it("requires a leading slash for whole-value fullpath links", () => {
    expect(extract("", { frontmatter: { parent: "moc/employees.md" } })).toEqual([]);
  });

  it("extracts list values as distinct ords under the same field", () => {
    const edges = extract("", {
      frontmatter: { related: ["/alice.md", "/bob.md"] },
    });
    expect(edges).toEqual([
      { ord: 0, field: "related", target: "/alice.md", wikilink: false },
      { ord: 1, field: "related", target: "/bob.md", wikilink: false },
    ]);
  });

  it("reaches nested string paths (project.lead)", () => {
    const edges = extract("", {
      frontmatter: { project: { lead: "/people/lead.md" } },
    });
    expect(edges).toEqual([
      { ord: 0, field: "project.lead", target: "/people/lead.md", wikilink: false },
    ]);
  });

  it("extracts wikilinks embedded in a frontmatter string", () => {
    expect(targets(extract("", { frontmatter: { note: "See [[crew/alice]]" } }))).toEqual([
      "crew/alice",
    ]);
  });

  it("extracts inline markdown embedded in a frontmatter string", () => {
    expect(targets(extract("", { frontmatter: { note: "See [Alice](people/alice.md)" } }))).toEqual([
      "people/alice.md",
    ]);
  });

  it("skips non-string terminal values", () => {
    expect(extract("", { frontmatter: { n: 42, b: true, z: null } })).toEqual([]);
  });

  it("body edges come before frontmatter edges in ord order", () => {
    const edges = extract("[a](one.md)", {
      frontmatter: { parent: "/p.md" },
    });
    expect(stripSpans(edges)).toEqual([
      { ord: 0, field: BODY_FIELD, target: "one.md", wikilink: false },
      { ord: 1, field: "parent", target: "/p.md", wikilink: false },
    ]);
  });

  it("respects frontmatter syntax toggles", () => {
    const off = mergeConfig(HARDCODED_DEFAULTS, {
      frontmatter: { inline: false, reference: false, autolink: false, wikilink: false, fullpath: false },
    });
    expect(extract("", { frontmatter: { parent: "/p.md" }, config: off })).toEqual([]);
  });
});

describe("determinism", () => {
  it("same input → identical edges", () => {
    const body = "[a](one.md) [[two]] ![img](p.png)\n\n[a]: unused.md";
    expect(extract(body)).toEqual(extract(body));
  });
});

describe("dest_span — the rewritable destination range (for links repair)", () => {
  const spanText = (body: string, e: RawEdge) =>
    e.dest_span ? body.slice(e.dest_span.start, e.dest_span.end) : undefined;

  it("captures the inline destination text span", () => {
    const body = "see [Alice](people/alice.md) here";
    const [edge] = extract(body);
    expect(edge?.dest_span).toBeDefined();
    expect(spanText(body, edge as RawEdge)).toBe("people/alice.md");
  });

  it("captures the wikilink page-half span (not the display half)", () => {
    const body = "- [[alice|Alice Ng]]";
    const [edge] = extract(body);
    expect(spanText(body, edge as RawEdge)).toBe("alice");
  });

  it("captures the span of a pointy-bracket destination's inner text", () => {
    const body = "[x](<path with spaces.md>)";
    const [edge] = extract(body);
    expect(spanText(body, edge as RawEdge)).toBe("path with spaces.md");
  });

  it("includes the anchor in the inline destination span", () => {
    const body = "[x](foo.md#sec)";
    const [edge] = extract(body);
    expect(spanText(body, edge as RawEdge)).toBe("foo.md#sec");
  });

  it("points a reference-style link's span at its [id]: definition destination", () => {
    const body = "[Bob][b]\n\n[b]: people/bob.md";
    const [edge] = extract(body);
    // The rewritable span is the definition's destination, not the inline
    // label — so repair edits the shared definition once.
    expect(spanText(body, edge as RawEdge)).toBe("people/bob.md");
  });

  it("shortcut + collapsed references resolve their span to the definition", () => {
    const body = "[carol] and [carol][]\n\n[carol]: people/carol.md";
    const edges = extract(body);
    expect(edges).toHaveLength(2);
    // Both references share the single definition's destination span.
    for (const e of edges) expect(spanText(body, e)).toBe("people/carol.md");
    expect(edges[0]?.dest_span).toEqual(edges[1]?.dest_span);
  });

  it("omits the span for frontmatter edges", () => {
    const edges = extract("", {
      frontmatter: { parent: "/p.md" },
    });
    expect(edges[0]?.dest_span).toBeUndefined();
  });

  it("spans stay correct with multiple links on one line", () => {
    const body = "[a](a.md) and [b](b.md)";
    const edges = extract(body);
    expect(spanText(body, edges[0] as RawEdge)).toBe("a.md");
    expect(spanText(body, edges[1] as RawEdge)).toBe("b.md");
  });
});
