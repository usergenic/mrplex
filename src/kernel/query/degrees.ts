/**
 * `$degrees` binding for the graph read surface (docs/graph-plan.md §2.1,
 * decision 5). `$degrees` is a scalar CEL intrinsic legal ONLY inside a
 * `graph` call's `filter`: the minimum hops from the nearest root at which a
 * document was reached.
 *
 * BFS visits every document at its minimal distance first, and the filter can
 * only *prune* (visibility is monotone), so every candidate in round `r`
 * shares `$degrees = r`. We exploit that: compile the filter once per round
 * with `$degrees` inlined as an integer constant, then reuse the existing
 * query-compilation machinery unchanged. This module does the inlining by
 * rewriting the parsed CEL AST — the parser mangles `$degrees` to
 * `__mrplex_i_degrees` (cel-parse.ts), and here we replace that ident with an
 * `int64` constant node. Neither dialect compiler needs to know `$degrees`
 * exists.
 *
 * A `$degrees` reference outside a `graph` filter reaches a dialect compiler
 * as an unknown intrinsic and fails `filter_invalid` there — which is the
 * desired only-in-graph behavior (decision 14).
 */

import { ConstantSchema, ExprSchema } from "@bufbuild/cel-spec/cel/expr/syntax_pb.js";
import { clone, create } from "@bufbuild/protobuf";
import type { CelExpr } from "./ast.js";
import { INTRINSIC_PREFIX } from "./cel-parse.js";

/** The mangled ident the parser produces for `$degrees`. */
export const DEGREES_MANGLED = `${INTRINSIC_PREFIX}degrees`;

/**
 * Return a copy of `ast` with every `$degrees` reference replaced by the
 * integer literal `value`. Pure — the input AST is never mutated, so the
 * per-round callers can re-bind the same parsed filter for each round.
 */
export function bindDegrees(ast: CelExpr, value: number): CelExpr {
  const copy = clone(ExprSchema, ast);
  rewrite(copy, value);
  return copy;
}

function rewrite(expr: CelExpr, value: number): void {
  const kind = expr.exprKind;
  switch (kind.case) {
    case "identExpr":
      if (kind.value.name === DEGREES_MANGLED) {
        // Replace the ident node in place with an int64 constant.
        expr.exprKind = {
          case: "constExpr",
          value: create(ConstantSchema, {
            constantKind: { case: "int64Value", value: BigInt(value) },
          }),
        };
      }
      return;
    case "selectExpr":
      if (kind.value.operand) rewrite(kind.value.operand, value);
      return;
    case "callExpr": {
      if (kind.value.target) rewrite(kind.value.target, value);
      for (const arg of kind.value.args) rewrite(arg, value);
      return;
    }
    case "comprehensionExpr": {
      const c = kind.value;
      if (c.iterRange) rewrite(c.iterRange, value);
      if (c.accuInit) rewrite(c.accuInit, value);
      if (c.loopCondition) rewrite(c.loopCondition, value);
      if (c.loopStep) rewrite(c.loopStep, value);
      if (c.result) rewrite(c.result, value);
      return;
    }
    case "listExpr":
      for (const el of kind.value.elements) rewrite(el, value);
      return;
    case "structExpr":
      for (const entry of kind.value.entries) {
        if (entry.value) rewrite(entry.value, value);
      }
      return;
    default:
      return;
  }
}

/** True if the parsed filter references `$degrees` anywhere. */
export function referencesDegrees(expr: CelExpr): boolean {
  let found = false;
  const walk = (e: CelExpr): void => {
    if (found) return;
    const kind = e.exprKind;
    switch (kind.case) {
      case "identExpr":
        if (kind.value.name === DEGREES_MANGLED) found = true;
        return;
      case "selectExpr":
        if (kind.value.operand) walk(kind.value.operand);
        return;
      case "callExpr":
        if (kind.value.target) walk(kind.value.target);
        for (const arg of kind.value.args) walk(arg);
        return;
      case "comprehensionExpr": {
        const c = kind.value;
        for (const sub of [c.iterRange, c.accuInit, c.loopCondition, c.loopStep, c.result]) {
          if (sub) walk(sub);
        }
        return;
      }
      case "listExpr":
        for (const el of kind.value.elements) walk(el);
        return;
      case "structExpr":
        for (const entry of kind.value.entries) if (entry.value) walk(entry.value);
        return;
      default:
        return;
    }
  };
  walk(expr);
  return found;
}
