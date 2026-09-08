import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../../storage-sqlite/adapter.js";
import type { Storage } from "../../storage/types.js";
import { type Kernel, createKernel } from "../kernel.js";
import { VerifyAccumulator, checkSelected } from "./verify.js";

describe("checkSelected", () => {
  it("selects everything when the list is omitted or empty", () => {
    expect(checkSelected("chain.cycle", undefined)).toBe(true);
    expect(checkSelected("chain.cycle", [])).toBe(true);
  });

  it("matches a full code", () => {
    expect(checkSelected("chain.cycle", ["chain.cycle"])).toBe(true);
    expect(checkSelected("chain.cycle", ["hash.mismatch"])).toBe(false);
  });

  it("matches a family prefix", () => {
    expect(checkSelected("chain.cycle", ["chain"])).toBe(true);
    expect(checkSelected("chain.no_current", ["chain"])).toBe(true);
    expect(checkSelected("links.set_mismatch", ["chain"])).toBe(false);
  });
});

describe("VerifyAccumulator", () => {
  it("tallies counts by check and severity", () => {
    const acc = new VerifyAccumulator("warn", 100);
    acc.countVersions(5);
    acc.countDocuments(2);
    acc.add({ check: "chain.cycle", severity: "error", repo: "r", detail: {} });
    acc.add({ check: "chain.cycle", severity: "error", repo: "r", detail: {} });
    acc.add({ check: "hash.missing", severity: "warn", repo: "r", detail: {} });

    const report = acc.report();
    expect(report.counts).toEqual({
      versions_scanned: 5,
      documents_scanned: 2,
      by_check: { "chain.cycle": 2, "hash.missing": 1 },
      by_severity: { warn: 1, error: 2 },
    });
    expect(report.findings).toHaveLength(3);
    expect(report.truncated).toBe(false);
  });

  it("drops findings below min_severity but never counts them", () => {
    const acc = new VerifyAccumulator("error", 100);
    acc.add({ check: "hash.missing", severity: "warn", repo: "r", detail: {} });
    acc.add({ check: "chain.cycle", severity: "error", repo: "r", detail: {} });

    const report = acc.report();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.check).toBe("chain.cycle");
    expect(report.counts.by_severity).toEqual({ warn: 0, error: 1 });
  });

  it("caps the emitted list at max_findings but keeps counts exact", () => {
    const acc = new VerifyAccumulator("warn", 2);
    for (let i = 0; i < 5; i++) {
      acc.add({ check: "chain.cycle", severity: "error", repo: "r", detail: { i } });
    }
    const report = acc.report();
    expect(report.findings).toHaveLength(2);
    expect(report.truncated).toBe(true);
    expect(report.counts.by_check).toEqual({ "chain.cycle": 5 });
    expect(report.counts.by_severity.error).toBe(5);
  });

  it("records skipped checks", () => {
    const acc = new VerifyAccumulator("warn", 100);
    acc.skip("chunks.unembedded", "no embedder configured");
    expect(acc.report().checks_skipped).toEqual([
      { check: "chunks.unembedded", reason: "no embedder configured" },
    ]);
  });
});

describe("kernel.verify skeleton (WS1)", () => {
  let storage: Storage;
  let kernel: Kernel;

  beforeEach(async () => {
    const path = join(tmpdir(), `mrplex-verify-${Date.now()}-${Math.random()}.db`);
    storage = await sqliteAdapter.open({ database: `sqlite:${path}` });
    kernel = createKernel(storage);
    await storage.repos_create({ slug: "notes", created_at: new Date().toISOString() });
    await storage.repos_create({ slug: "secret", created_at: new Date().toISOString() });
  });

  it("returns a well-formed empty report over all repos", async () => {
    const report = await kernel.verify({}, {});
    expect(report.findings).toEqual([]);
    expect(report.truncated).toBe(false);
    expect(report.counts.versions_scanned).toBe(0);
    expect(report.counts.documents_scanned).toBe(0);
    // No embedder configured in this harness, so chunks.unembedded is
    // skipped-and-noted (once, deduped across repos).
    expect(report.checks_skipped).toEqual([
      { check: "chunks.unembedded", reason: "no embedder configured" },
    ]);
  });

  it("throws repo_not_found for an unknown --repo", async () => {
    await expect(kernel.verify({}, { repo: "nope" })).rejects.toMatchObject({
      code: "repo_not_found",
    });
  });

  it("hides an out-of-scope repo as not-found", async () => {
    await expect(
      kernel.verify({ scope: [{ repo: "notes" }] }, { repo: "secret" }),
    ).rejects.toMatchObject({ code: "repo_not_found" });
  });

  it("scopes a repo-less run to visible repos without throwing", async () => {
    const report = await kernel.verify({ scope: [{ repo: "notes" }] }, {});
    expect(report.findings).toEqual([]);
  });

  it("verifies a system-namespaced repo when named explicitly", async () => {
    await storage.repos_create({ slug: ":deleted-old", created_at: new Date().toISOString() });
    const report = await kernel.verify({}, { repo: ":deleted-old" });
    expect(report.findings).toEqual([]);
  });
});
