/**
 * Verify check families (docs/verify-plan.md §2) — the correctness proof.
 *
 * Each test seeds a healthy corpus through the kernel, asserts a clean report,
 * then injects one specific corruption (usually via a second raw SQLite handle,
 * since the store's own write path won't produce these states) and asserts the
 * exact finding. SQLite-only: corruption injection is engine-specific, and the
 * check logic is pure/shared, so SQLite coverage proves the family.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "../src/kernel/context.js";
import { type Kernel, createKernel } from "../src/kernel/kernel.js";
import { decodeVersionId } from "../src/kernel/version-id.js";
import type { VerifyFinding } from "../src/kernel/wire.js";
import { sqliteAdapter } from "../src/storage-sqlite/adapter.js";
import type { Storage } from "../src/storage/types.js";

const ROOT: CallContext = {};

let dbPath: string;
let storage: Storage;
let kernel: Kernel;

beforeEach(async () => {
  dbPath = join(tmpdir(), `mrplex-verify-checks-${Date.now()}-${Math.random()}.db`);
  storage = await sqliteAdapter.open({ database: `sqlite:${dbPath}` });
  kernel = createKernel(storage);
  await kernel.repos.create(ROOT, "notes");
});

afterEach(async () => {
  await storage.close();
});

/**
 * Run `fn` against a second raw handle to the DB file, always closing it — an
 * un-closed better-sqlite3 handle keeps the vitest worker alive (looks like a
 * hang). Corruption injections must also respect the partial unique indexes
 * (e.g. can't null a next_id if that would create two live rows at one path),
 * or the UPDATE throws and leaks the handle.
 */
function withRaw<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Inject corruption that the schema's own constraints normally forbid — the
 * whole point of some checks is to catch states a healthy write path can't
 * produce. Disables FK enforcement and drops the partial unique indexes for the
 * mutation, so e.g. a dangling chunk ref or a two-live-versions document can be
 * created. The indexes aren't restored (the DB is thrown away after the test).
 */
function withRawUnsafe<T>(fn: (db: Database.Database) => T): T {
  return withRaw((db) => {
    db.pragma("foreign_keys = OFF");
    db.exec("drop index if exists versions_document_current_uidx");
    db.exec("drop index if exists versions_repo_path_current_uidx");
    db.exec("drop index if exists versions_repo_pathnorm_current_uidx");
    return fn(db);
  });
}

/** Findings for a given check code. */
function findingsFor(report: { findings: VerifyFinding[] }, check: string): VerifyFinding[] {
  return report.findings.filter((f) => f.check === check);
}

describe("verify: clean corpus", () => {
  it("reports no findings on a healthy repo", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "title: A\n",
      body: "see [B](b.md)\n",
    });
    await kernel.docs.create(ROOT, "notes", "b.md", {
      frontmatter_raw: "title: B\n",
      body: "hello\n",
    });
    const report = await kernel.verify(ROOT, {});
    expect(report.findings).toEqual([]);
    expect(report.counts.documents_scanned).toBe(2);
  });
});

describe("verify: chain family", () => {
  it("chain.orphan_document — a document with no versions", async () => {
    // documents_create with no version_insert leaves an orphan.
    await storage.documents_create(1);
    const report = await kernel.verify(ROOT, { checks: ["chain.orphan_document"] });
    expect(findingsFor(report, "chain.orphan_document")).toHaveLength(1);
  });

  it("chain.prev_next_asymmetry — v1.next_id doesn't point back at v2", async () => {
    // One document, two versions (edit) + a decoy version in another doc. v2's
    // prev_id still points at v1, but repoint v1.next_id at the decoy: within
    // the document, v1 (prev of v2) no longer claims v2 → asymmetry. Using a
    // real decoy id satisfies the next_id FK; v1 stays non-current (its next_id
    // is non-null) so a.md's single live slot is unaffected.
    const v1 = await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    await kernel.docs.put(ROOT, "notes", v1.version_id, "a.md", { body: "two\n" });
    const decoy = await kernel.docs.create(ROOT, "notes", "d.md", {
      frontmatter_raw: "",
      body: "d\n",
    });
    const v1Id = decodeVersionId(v1.version_id);
    const decoyId = decodeVersionId(decoy.version_id);
    withRaw((r) => r.prepare("update versions set next_id = ? where id = ?").run(decoyId, v1Id));
    const report = await kernel.verify(ROOT, { checks: ["chain.prev_next_asymmetry"] });
    expect(findingsFor(report, "chain.prev_next_asymmetry").length).toBeGreaterThanOrEqual(1);
  });

  it("chain.multiple_current — two live versions in one document", async () => {
    // Move a.md → b.md so the document has two versions at DIFFERENT paths.
    // Nulling the superseded version's next_id then makes both live without
    // colliding on (repo, path_norm).
    const v1 = await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    await kernel.docs.put(ROOT, "notes", v1.version_id, "b.md", { body: "one\n" });
    const v1Id = decodeVersionId(v1.version_id);
    // Two live rows in one document violates versions_document_current_uidx, so
    // the injection must drop that index (withRawUnsafe).
    withRawUnsafe((r) => r.prepare("update versions set next_id = null where id = ?").run(v1Id));
    const report = await kernel.verify(ROOT, { checks: ["chain.multiple_current"] });
    expect(findingsFor(report, "chain.multiple_current")).toHaveLength(1);
  });

  it("chain.no_current — no live version in a document", async () => {
    const a = await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "",
      body: "one\n",
    });
    const b = await kernel.docs.create(ROOT, "notes", "b.md", {
      frontmatter_raw: "",
      body: "two\n",
    });
    const aId = decodeVersionId(a.version_id);
    const bId = decodeVersionId(b.version_id);
    // Point a's only version at b's version (a real id → satisfies the FK), so
    // a's document has no next_id-null row → headless. Frees a.md's live slot,
    // so the (repo, path_norm) unique index isn't violated either.
    withRaw((r) => r.prepare("update versions set next_id = ? where id = ?").run(bId, aId));
    const report = await kernel.verify(ROOT, { checks: ["chain.no_current"] });
    expect(findingsFor(report, "chain.no_current")).toHaveLength(1);
  });

  it("chain.repo_mismatch — version repo_id disagrees with its document", async () => {
    await kernel.repos.create(ROOT, "other");
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "one\n" });
    withRaw((r) => {
      const otherId = (
        r.prepare("select id from repos where slug='other'").get() as {
          id: number;
        }
      ).id;
      r.prepare("update versions set repo_id = ? where path = 'a.md'").run(otherId);
    });
    const report = await kernel.verify(ROOT, { checks: ["chain.repo_mismatch"] });
    expect(findingsFor(report, "chain.repo_mismatch").length).toBeGreaterThanOrEqual(1);
  });
});

describe("verify: hash family", () => {
  it("hash.mismatch — stored content_hash disagrees with recomputed", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "real body\n" });
    withRaw((r) =>
      r.prepare("update versions set content_hash = 'deadbeef' where path = 'a.md'").run(),
    );
    const report = await kernel.verify(ROOT, { checks: ["hash.mismatch"] });
    const hits = findingsFor(report, "hash.mismatch");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail.stored).toBe("deadbeef");
  });

  it("hash.missing — a pre-backfill null content_hash (warn)", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "body\n" });
    withRaw((r) => r.prepare("update versions set content_hash = null where path = 'a.md'").run());
    const report = await kernel.verify(ROOT, { checks: ["hash.missing"] });
    const hits = findingsFor(report, "hash.missing");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("warn");
    expect(hits[0]?.suggested_fix).toBe("mrplex hash backfill");
  });
});

describe("verify: frontmatter family", () => {
  it("frontmatter.divergence — stored JSON disagrees with re-parsed raw", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "status: draft\n",
      body: "b\n",
    });
    // Tamper the parsed JSON so it no longer matches the raw YAML.
    withRaw((r) =>
      r
        .prepare("update versions set frontmatter = ? where path = 'a.md'")
        .run(JSON.stringify({ status: "published" })),
    );
    const report = await kernel.verify(ROOT, { checks: ["frontmatter.divergence"] });
    const hits = findingsFor(report, "frontmatter.divergence");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail.keys_differing).toEqual(["status"]);
  });

  it("frontmatter.parse_error — stored raw no longer parses as YAML", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "title: A\n",
      body: "b\n",
    });
    // Unbalanced bracket → YAML parse failure.
    withRaw((r) =>
      r
        .prepare("update versions set frontmatter_raw = ? where path = 'a.md'")
        .run("title: [oops\n"),
    );
    const report = await kernel.verify(ROOT, { checks: ["frontmatter.parse_error"] });
    expect(findingsFor(report, "frontmatter.parse_error")).toHaveLength(1);
  });

  it("frontmatter.system_leak — a $-prefixed key persisted in storage", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "title: A\n", body: "b\n" });
    withRaw((r) =>
      r
        .prepare("update versions set frontmatter_raw = ? where path = 'a.md'")
        .run("title: A\n$version: v99\n"),
    );
    const report = await kernel.verify(ROOT, { checks: ["frontmatter.system_leak"] });
    const hits = findingsFor(report, "frontmatter.system_leak");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail.in_raw).toBe(true);
  });
});

describe("verify: fts family", () => {
  it("fts.missing — a version with no fts_docs row", async () => {
    const v = await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "a\n" });
    const vId = decodeVersionId(v.version_id);
    withRaw((r) =>
      r.prepare("insert into fts_docs(fts_docs, rowid, body) values('delete', ?, ?)").run(vId, "a"),
    );
    const report = await kernel.verify(ROOT, { checks: ["fts.missing"] });
    expect(findingsFor(report, "fts.missing")).toHaveLength(1);
  });

  it("fts.orphan — an fts_docs row with no version", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "a\n" });
    withRaw((r) => r.prepare("insert into fts_docs(rowid, body) values (?, ?)").run(9999, "ghost"));
    const report = await kernel.verify(ROOT, { checks: ["fts.orphan"] });
    expect(findingsFor(report, "fts.orphan")).toHaveLength(1);
  });

  it("fts family is skipped-with-note under a --repo filter", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "a\n" });
    const report = await kernel.verify(ROOT, { repo: "notes", checks: ["fts.missing"] });
    expect(report.checks_skipped).toContainEqual({
      check: "fts",
      reason: "whole-store check; omit --repo to run",
    });
  });
});

describe("verify: chunks family", () => {
  it("chunks.orphan — a chunk row referencing a nonexistent version", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "a\n" });
    // A chunk referencing a nonexistent version is an FK violation by design —
    // inject with FK off (withRawUnsafe) to simulate the corruption.
    withRawUnsafe((r) =>
      r
        .prepare(
          "insert into chunks(version_id, ix, text, text_hash, model, embedding) values (?,?,?,?,?,?)",
        )
        .run(9999, 0, "t", "h", "m", Buffer.from(new Float32Array([1, 0]).buffer)),
    );
    const report = await kernel.verify(ROOT, { checks: ["chunks.orphan"] });
    expect(findingsFor(report, "chunks.orphan")).toHaveLength(1);
  });

  it("chunks.backlog_orphan — a backlog row referencing a nonexistent version", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "a\n" });
    withRawUnsafe((r) =>
      r
        .prepare(
          "insert into embedding_backlog(version_id, attempts, last_error, next_retry_at) values (?,?,?,?)",
        )
        .run(9999, 0, null, null),
    );
    const report = await kernel.verify(ROOT, { checks: ["chunks.backlog_orphan"] });
    expect(findingsFor(report, "chunks.backlog_orphan")).toHaveLength(1);
  });

  it("chunks.mixed_dim — one version with vectors of differing dimension", async () => {
    const v = await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "a\n" });
    const vId = decodeVersionId(v.version_id);
    withRaw((r) => {
      const ins = r.prepare(
        "insert into chunks(version_id, ix, text, text_hash, model, embedding) values (?,?,?,?,?,?)",
      );
      ins.run(vId, 0, "t0", "h0", "m", Buffer.from(new Float32Array([1, 0]).buffer)); // 8 bytes
      ins.run(vId, 1, "t1", "h1", "m", Buffer.from(new Float32Array([1, 0, 0]).buffer)); // 12 bytes
    });
    const report = await kernel.verify(ROOT, { checks: ["chunks.mixed_dim"] });
    expect(findingsFor(report, "chunks.mixed_dim")).toHaveLength(1);
  });

  it("chunks.unembedded is skipped-with-note when no embedder is configured", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", { frontmatter_raw: "", body: "a\n" });
    const report = await kernel.verify(ROOT, { checks: ["chunks.unembedded"] });
    expect(report.checks_skipped).toContainEqual({
      check: "chunks.unembedded",
      reason: "no embedder configured",
    });
    expect(findingsFor(report, "chunks.unembedded")).toHaveLength(0);
  });
});

describe("verify: links family", () => {
  it("links.set_mismatch — stored edges disagree with re-extraction", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "",
      body: "see [B](b.md)\n",
    });
    await kernel.docs.create(ROOT, "notes", "b.md", { frontmatter_raw: "", body: "hi\n" });
    // Corrupt the stored edge target so re-extraction won't match.
    withRaw((r) =>
      r.prepare("update links set target_raw = 'wrong.md', target_norm = 'wrong.md'").run(),
    );
    const report = await kernel.verify(ROOT, { checks: ["links.set_mismatch"] });
    expect(findingsFor(report, "links.set_mismatch").length).toBeGreaterThanOrEqual(1);
  });

  it("links.misresolved_dangling — a dangling edge that should have bound", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "",
      body: "see [B](b.md)\n",
    });
    await kernel.docs.create(ROOT, "notes", "b.md", { frontmatter_raw: "", body: "hi\n" });
    // Force the a→b edge to dangle even though b.md is live.
    withRaw((r) => r.prepare("update links set target_id = null").run());
    const report = await kernel.verify(ROOT, { checks: ["links.misresolved_dangling"] });
    expect(findingsFor(report, "links.misresolved_dangling").length).toBeGreaterThanOrEqual(1);
  });

  it("is clean on a correct link graph", async () => {
    await kernel.docs.create(ROOT, "notes", "a.md", {
      frontmatter_raw: "",
      body: "see [B](b.md)\n",
    });
    await kernel.docs.create(ROOT, "notes", "b.md", { frontmatter_raw: "", body: "hi\n" });
    const report = await kernel.verify(ROOT, { checks: ["links"] });
    expect(findingsFor(report, "links.set_mismatch")).toHaveLength(0);
    expect(findingsFor(report, "links.misresolved_dangling")).toHaveLength(0);
    expect(findingsFor(report, "links.misresolved_bound")).toHaveLength(0);
  });
});
