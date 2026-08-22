/**
 * `/k/<token>/…` URL-prefix stripping — the pure parser behind the token-in-URL
 * credential delivery. The end-to-end path (routing + auth) is covered in
 * serve.test.ts; here we pin the parsing edge cases.
 */

import { describe, expect, it } from "vitest";
import { stripTokenPrefix } from "./serve.js";

describe("stripTokenPrefix", () => {
  it("peels the token and rewrites /k/<t>/mcp → /mcp", () => {
    expect(stripTokenPrefix("/k/abc123/mcp")).toEqual({ token: "abc123", url: "/mcp" });
  });

  it("handles a deep path and preserves the query string", () => {
    expect(stripTokenPrefix("/k/abc/repos/notes/docs/a.md?raw=true")).toEqual({
      token: "abc",
      url: "/repos/notes/docs/a.md?raw=true",
    });
  });

  it("rewrites a bare /k/<t> to /", () => {
    expect(stripTokenPrefix("/k/abc")).toEqual({ token: "abc", url: "/" });
  });

  it("percent-decodes the token segment", () => {
    // A base64url key has no reserved chars, but a JWT never appears here; still,
    // decode defensively so an encoded segment round-trips.
    expect(stripTokenPrefix("/k/a%2Bb/mcp")).toEqual({ token: "a+b", url: "/mcp" });
  });

  it("returns null when there is no /k/ prefix", () => {
    expect(stripTokenPrefix("/mcp")).toBeNull();
    expect(stripTokenPrefix("/repos/notes")).toBeNull();
    expect(stripTokenPrefix("/")).toBeNull();
  });

  it("returns null for an empty token segment (/k//…)", () => {
    expect(stripTokenPrefix("/k//repos")).toBeNull();
    expect(stripTokenPrefix("/k/")).toBeNull();
  });

  it("does not treat a /k segment deeper in the path as a prefix", () => {
    // Only the leading segment counts; /repos/k/... is a normal path.
    expect(stripTokenPrefix("/repos/k/abc")).toBeNull();
  });
});
