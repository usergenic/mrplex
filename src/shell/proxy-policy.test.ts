/**
 * REST route classification for proxy mode — auth-shell plan WS4. Pure input
 * classification, so plain unit tests. The point is that the URL path is
 * authoritative for writes, letting the proxy police without a kernel.
 */

import { describe, expect, it } from "vitest";
import { classifyRestRequest } from "./proxy-policy.js";

describe("classifyRestRequest", () => {
  it("classifies reads", () => {
    expect(classifyRestRequest("GET", "/", undefined)).toEqual({ kind: "read" });
    expect(classifyRestRequest("GET", "/query", undefined)).toEqual({ kind: "read" });
    expect(classifyRestRequest("POST", "/query", undefined)).toEqual({ kind: "read" });
    expect(classifyRestRequest("GET", "/repos", undefined)).toEqual({ kind: "read" });
    expect(classifyRestRequest("GET", "/repos/notes", undefined)).toEqual({ kind: "read" });
    expect(classifyRestRequest("GET", "/repos/notes/docs/a.md", undefined)).toEqual({
      kind: "read",
    });
    expect(classifyRestRequest("GET", "/repos/notes/history/a.md", undefined)).toEqual({
      kind: "read",
    });
  });

  it("classifies destructive repo ops", () => {
    expect(classifyRestRequest("POST", "/repos", undefined)).toEqual({ kind: "destructive" });
    expect(classifyRestRequest("DELETE", "/repos/notes", undefined)).toEqual({
      kind: "destructive",
    });
    expect(classifyRestRequest("MOVE", "/repos/notes", undefined)).toEqual({ kind: "destructive" });
    expect(classifyRestRequest("PUT", "/repos/notes/config", undefined)).toEqual({
      kind: "destructive",
    });
    expect(classifyRestRequest("PUT", "/repos/notes/link-config", undefined)).toEqual({
      kind: "destructive",
    });
  });

  it("classifies doc writes with the target path from the URL", () => {
    expect(classifyRestRequest("PUT", "/repos/notes/docs/drafts/x.md", undefined)).toEqual({
      kind: "write",
      repo: "notes",
      paths: ["drafts/x.md"],
    });
    expect(classifyRestRequest("DELETE", "/repos/notes/docs/drafts/x.md", undefined)).toEqual({
      kind: "write",
      repo: "notes",
      paths: ["drafts/x.md"],
    });
  });

  it("classifies a MOVE as both endpoints", () => {
    const r = classifyRestRequest(
      "MOVE",
      "/repos/notes/docs/drafts/a.md",
      "/repos/notes/docs/drafts/b.md",
    );
    expect(r).toEqual({ kind: "write", repo: "notes", paths: ["drafts/a.md", "drafts/b.md"] });
  });

  it("falls back to the source path when the MOVE destination is cross-repo/unparseable", () => {
    const r = classifyRestRequest(
      "MOVE",
      "/repos/notes/docs/a.md",
      "/repos/other/docs/b.md", // cross-repo → dest dropped, engine rejects later
    );
    expect(r).toEqual({ kind: "write", repo: "notes", paths: ["a.md"] });
  });

  it("decodes percent-encoded path segments", () => {
    const r = classifyRestRequest("PUT", "/repos/notes/docs/a%20b.md", undefined);
    expect(r).toEqual({ kind: "write", repo: "notes", paths: ["a b.md"] });
  });

  it("marks unrecognized routes unknown (refuse rather than pass blind)", () => {
    expect(classifyRestRequest("GET", "/wat", undefined)).toEqual({ kind: "unknown" });
    expect(classifyRestRequest("PATCH", "/repos/notes/docs/a.md", undefined)).toEqual({
      kind: "unknown",
    });
    expect(classifyRestRequest("POST", "/repos/notes", undefined)).toEqual({ kind: "unknown" });
  });
});
