/**
 * Narrow AST types over @bufbuild/cel's protobuf ParsedExpr, plus small
 * predicates the compiler uses to dispatch on `exprKind.case`.
 *
 * We don't try to re-declare the full CEL AST — @bufbuild/cel-spec exports
 * the generated types. This file is just the seam the compiler imports from,
 * so an eventual parser swap (§7.1) only touches cel-parse.ts.
 */

import type { Expr } from "@bufbuild/cel-spec/cel/expr/syntax_pb.js";

export type CelExpr = Expr;
export type ExprKind = Expr["exprKind"]["case"];

/**
 * The CEL constant kinds we compile. Numeric bigints (`int64Value`) become
 * JS numbers when small; uints become bigints only if they exceed Number's
 * safe range.
 */
export type ConstantValue = string | number | bigint | boolean | null;

export function unwrapConstant(expr: CelExpr): ConstantValue | undefined {
  if (expr.exprKind.case !== "constExpr") return undefined;
  const k = expr.exprKind.value.constantKind;
  if (!k) return undefined;
  switch (k.case) {
    case "stringValue":
      return k.value;
    case "boolValue":
      return k.value;
    case "int64Value":
      return typeof k.value === "bigint" &&
        k.value <= BigInt(Number.MAX_SAFE_INTEGER) &&
        k.value >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(k.value)
        : k.value;
    case "uint64Value":
      return typeof k.value === "bigint" && k.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(k.value)
        : k.value;
    case "doubleValue":
      return k.value;
    case "nullValue":
      return null;
    default:
      return undefined;
  }
}

/**
 * If the expression is a call to `list(x)`, return x. Used by the `@in`
 * compiler and comprehension compilers to detect the polymorphic-scalar-
 * or-list hint (§5.2).
 */
export function unwrapListHint(expr: CelExpr): CelExpr | undefined {
  if (expr.exprKind.case !== "callExpr") return undefined;
  const call = expr.exprKind.value;
  if (call.function === "list" && call.target === undefined && call.args.length === 1) {
    return call.args[0];
  }
  return undefined;
}
