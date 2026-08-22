/**
 * $degrees AST binding (degrees.ts). The graph engine binds `$degrees` to a
 * per-round integer constant by rewriting the parsed filter; these tests pin
 * that the rewrite is pure, total over the AST shapes, and produces a compiler-
 * consumable constant.
 */

import { describe, expect, it } from "vitest";
import { compileFilter } from "../../storage-sqlite/compile-filter.js";
import { parseCel } from "./cel-parse.js";
import { DEGREES_MANGLED, bindDegrees, referencesDegrees } from "./degrees.js";

function ast(src: string) {
  const p = parseCel(src);
  if (!p.expr) throw new Error("empty");
  return p.expr;
}

describe("referencesDegrees", () => {
  it("detects $degrees at any depth", () => {
    expect(referencesDegrees(ast("$degrees <= 1"))).toBe(true);
    expect(referencesDegrees(ast('type == "person" || $degrees == 0'))).toBe(true);
    expect(referencesDegrees(ast('status == "x"'))).toBe(false);
  });
});

describe("bindDegrees", () => {
  it("does not mutate the input AST (pure)", () => {
    const original = ast("$degrees <= 2");
    bindDegrees(original, 5);
    // A second bind still sees $degrees, proving the first left the input alone.
    expect(referencesDegrees(original)).toBe(true);
  });

  it("replaces $degrees so the compiler no longer sees the intrinsic", () => {
    const bound = bindDegrees(ast("$degrees <= 2"), 1);
    expect(referencesDegrees(bound)).toBe(false);
    // And it compiles to real SQL (an unknown intrinsic would throw).
    const frag = compileFilter(bound);
    expect(frag.sql).toContain("<=");
    // The literal 1 is bound as a positional param.
    expect(frag.params).toContain(1);
  });

  it("leaves other intrinsics and frontmatter untouched", () => {
    const bound = bindDegrees(ast('$degrees == 0 || $path == "a.md"'), 3);
    const frag = compileFilter(bound);
    expect(frag.sql).toContain("versions.path");
  });

  it("the mangled name matches the parser's convention", () => {
    expect(DEGREES_MANGLED).toBe("__mrplex_i_degrees");
  });
});
