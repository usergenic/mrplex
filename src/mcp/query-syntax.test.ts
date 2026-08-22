/**
 * Drift guard: the query_syntax reference (query-syntax.ts) documents the
 * filter language, but the truth lives in the parser + compilers. These
 * tests compile every documented construct through the real pipeline
 * (parseCel → compileFilter) so the doc can't claim syntax that doesn't
 * work — and can't silently omit an intrinsic the compiler grows.
 */

import { describe, expect, it } from "vitest";
import { KernelError } from "../kernel/errors.js";
import { parseCel } from "../kernel/query/cel-parse.js";
import { type FilterCtx, compileFilter } from "../storage-sqlite/compile-filter.js";
import {
  DOCUMENTED_GRAPH_COLLECTIONS,
  DOCUMENTED_GRAPH_MEMBERSHIP,
  DOCUMENTED_INTRINSICS,
  QUERY_SYNTAX_DOC,
} from "./query-syntax.js";

// Graph predicates require the caller's visibility builders; stubs suffice
// for compile-success checks.
const GRAPH_CTX: FilterCtx = {
  graphScope: () => ({ sql: "1", params: [] }),
  graphSigils: () => ({ sql: "1", params: [] }),
};

function compiles(filter: string): void {
  const ast = parseCel(filter);
  if (!ast.expr) throw new Error(`empty filter: ${filter}`);
  compileFilter(ast.expr, GRAPH_CTX);
}

describe("documented constructs compile", () => {
  it("every documented intrinsic compiles", () => {
    for (const name of DOCUMENTED_INTRINSICS) {
      compiles(`$${name} == "x"`);
    }
  });

  it("every documented graph membership predicate compiles", () => {
    for (const name of DOCUMENTED_GRAPH_MEMBERSHIP) {
      compiles(`$${name}("moc/**")`);
      compiles(`$${name}("moc/**", "parent")`);
    }
  });

  it("every documented graph collection compiles with .size/.exists/.all", () => {
    for (const name of DOCUMENTED_GRAPH_COLLECTIONS) {
      compiles(`$${name}().size() == 0`);
      compiles(`$${name}().exists(d, d.status == "draft")`);
      compiles(`$${name}().all(d, d.$path.startsWith("guides/"))`);
    }
  });

  it("doc examples compile", () => {
    for (const filter of [
      'status == "published"',
      'meta.owner == "alice"',
      'contains($body, "pricing")',
      '$path.matches("^guides/[^/]+\\\\.md$")',
      '$updated_at >= "2026-08-01"',
      '"pricing" in list(tags)',
      "size(list(tags)) > 2",
      'list(tags).all(t, t.startsWith("p"))',
      'list(authors).exists(a, a == "alice")',
      '$in("moc/**") && !$in("moc/contractors.md")',
      '!$in("**")',
      '$has("projects/**", "parent")',
      "$links().size() == 0",
      '$backlinks().exists(d, d.status == "draft")',
    ]) {
      compiles(filter);
    }
  });
});

describe("documented sets match the compiler", () => {
  it("the compiler's unknown-intrinsic error lists exactly the documented intrinsics", () => {
    // compileIntrinsic derives its "expected" list from INTRINSIC_COLUMNS;
    // comparing against it keeps DOCUMENTED_INTRINSICS honest both ways.
    const ast = parseCel("$bogus_intrinsic == 1");
    let reason = "";
    try {
      compileFilter(ast.expr as never, GRAPH_CTX);
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      reason = String((err as KernelError).data.reason);
    }
    const listed = (reason.match(/\$[a-z_]+/g) ?? [])
      .filter((n) => n !== "$bogus_intrinsic")
      .sort();
    expect(listed).toEqual(DOCUMENTED_INTRINSICS.map((n) => `$${n}`).sort());
  });
});

describe("the reference doc mentions every documented name", () => {
  it("intrinsics", () => {
    for (const name of DOCUMENTED_INTRINSICS) {
      expect(QUERY_SYNTAX_DOC).toContain(`$${name}`);
    }
  });

  it("graph predicates and collections", () => {
    for (const name of [...DOCUMENTED_GRAPH_MEMBERSHIP, ...DOCUMENTED_GRAPH_COLLECTIONS]) {
      expect(QUERY_SYNTAX_DOC).toContain(`$${name}`);
    }
  });

  it("list() polymorphism", () => {
    expect(QUERY_SYNTAX_DOC).toContain("in list(");
  });
});
