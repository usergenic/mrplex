import { describe, expect, it } from "vitest";
import { KernelError } from "../errors.js";
import { INTRINSIC_PREFIX, parseCel, preprocessDollarIdents } from "./cel-parse.js";

describe("preprocessDollarIdents", () => {
  it("mangles a top-level $identifier", () => {
    expect(preprocessDollarIdents("$path")).toBe(`${INTRINSIC_PREFIX}path`);
  });

  it("mangles $identifier followed by a selector", () => {
    expect(preprocessDollarIdents("$path.startsWith('x')")).toBe(
      `${INTRINSIC_PREFIX}path.startsWith('x')`,
    );
  });

  it("mangles multiple $identifiers", () => {
    expect(preprocessDollarIdents("$path == '/' || $created_at < '2026'")).toBe(
      `${INTRINSIC_PREFIX}path == '/' || ${INTRINSIC_PREFIX}created_at < '2026'`,
    );
  });

  it("does NOT mangle $ inside a double-quoted string", () => {
    expect(preprocessDollarIdents('contains(body, "$foo")')).toBe('contains(body, "$foo")');
  });

  it("does NOT mangle $ inside a single-quoted string", () => {
    expect(preprocessDollarIdents("contains(body, '$foo')")).toBe("contains(body, '$foo')");
  });

  it("handles escaped quote inside a string (does not exit early)", () => {
    // "he said \"$foo\"" — the \" doesn't end the string.
    expect(preprocessDollarIdents('body == "he said \\"$foo\\""')).toBe(
      'body == "he said \\"$foo\\""',
    );
  });

  it("mangles $ident that appears after a string ends", () => {
    expect(preprocessDollarIdents('"ignored $foo" && $path == "/"')).toBe(
      `"ignored $foo" && ${INTRINSIC_PREFIX}path == "/"`,
    );
  });

  it("leaves a bare $ (not followed by an ident char) alone", () => {
    expect(preprocessDollarIdents("$ + 1")).toBe("$ + 1");
    expect(preprocessDollarIdents("$1foo")).toBe("$1foo"); // ident must start with letter/_
  });

  it("leaves plain code untouched", () => {
    expect(preprocessDollarIdents('status == "draft" && size(tags) > 0')).toBe(
      'status == "draft" && size(tags) > 0',
    );
  });
});

describe("parseCel", () => {
  it("parses a valid frontmatter-field comparison", () => {
    const ast = parseCel('status == "draft"');
    expect(ast).toBeDefined();
    expect(ast.expr).toBeDefined();
  });

  it("parses $-intrinsics after preprocessing", () => {
    const ast = parseCel('$path.startsWith("drafts/")');
    expect(ast).toBeDefined();
    expect(ast.expr).toBeDefined();
  });

  it("parses list() polymorphic membership", () => {
    const ast = parseCel('"pricing" in list(tags)');
    expect(ast).toBeDefined();
  });

  it("parses list().all(...) comprehension", () => {
    const ast = parseCel('list(tags).all(t, t.startsWith("p"))');
    expect(ast).toBeDefined();
  });

  it("throws filter_invalid on malformed input", () => {
    try {
      parseCel("bad syntax [");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("filter_invalid");
      const data = (err as KernelError<{ source: string; error: string }>).data;
      expect(data.source).toBe("bad syntax [");
      expect(data.error).toBeTruthy();
    }
  });

  it("surfaces $-preprocessed source in the error data (mangled form is internal)", () => {
    // Even if a mangled ident causes a downstream parse error, the caller
    // sees the ORIGINAL source in the error data — the preprocessor is
    // an implementation detail.
    try {
      parseCel("$path @@@ bad");
      throw new Error("expected throw");
    } catch (err) {
      const data = (err as KernelError<{ source: string }>).data;
      expect(data.source).toBe("$path @@@ bad");
    }
  });
});
