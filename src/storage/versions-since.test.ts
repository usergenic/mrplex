import { describe, expect, it } from "vitest";
import { type FrontierRow, safeFrontier } from "./versions-since.js";

const WINDOW = 30_000;
const NOW = 1_000_000;

/** Build a contiguous run of rows starting at `start`, all old (settled). */
function contiguous(start: number, count: number, repo_id = 1): FrontierRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: start + i,
    repo_id,
    created_at_ms: NOW - WINDOW * 2, // well older than the window
  }));
}

describe("safeFrontier", () => {
  it("returns the full contiguous run when there are no gaps", () => {
    const rows = contiguous(1, 5);
    expect(safeFrontier(rows, 0, undefined, 100, NOW, WINDOW).upper_id).toBe(5);
  });

  it("advances from a non-zero cursor", () => {
    const rows = contiguous(11, 3); // ids 11,12,13
    expect(safeFrontier(rows, 10, undefined, 100, NOW, WINDOW).upper_id).toBe(13);
  });

  it("crosses a burned gap when the successor is old", () => {
    // ids 1,2, [3 burned], 4 — 4 is old, so 3 is burned → cross it.
    const rows: FrontierRow[] = [
      ...contiguous(1, 2),
      { id: 4, repo_id: 1, created_at_ms: NOW - WINDOW * 2 },
    ];
    expect(safeFrontier(rows, 0, undefined, 100, NOW, WINDOW).upper_id).toBe(4);
  });

  it("truncates before a hot gap when the successor is young", () => {
    // ids 1,2, [3 missing], 4 — 4 is younger than the window → 3 may be a
    // sibling still committing → stop before 4.
    const rows: FrontierRow[] = [
      ...contiguous(1, 2),
      { id: 4, repo_id: 1, created_at_ms: NOW - 1_000 }, // young
    ];
    expect(safeFrontier(rows, 0, undefined, 100, NOW, WINDOW).upper_id).toBe(2);
  });

  it("caps the page at the limit-th matching row", () => {
    const rows = contiguous(1, 10);
    // limit 3 → deliver through id 3, but the frontier is safe further out.
    expect(safeFrontier(rows, 0, undefined, 3, NOW, WINDOW).upper_id).toBe(3);
  });

  it("does not cap when matches are within limit (skips empty tail)", () => {
    const rows = contiguous(1, 3);
    // limit 10, only 3 rows → advance to the frontier, not capped.
    expect(safeFrontier(rows, 0, undefined, 10, NOW, WINDOW).upper_id).toBe(3);
  });

  it("repo filter narrows delivered matches but does not affect gaps", () => {
    // Interleaved repos: ids 1(r1) 2(r2) 3(r1) 4(r2) 5(r1), all old.
    const rows: FrontierRow[] = [
      { id: 1, repo_id: 1, created_at_ms: NOW - WINDOW * 2 },
      { id: 2, repo_id: 2, created_at_ms: NOW - WINDOW * 2 },
      { id: 3, repo_id: 1, created_at_ms: NOW - WINDOW * 2 },
      { id: 4, repo_id: 2, created_at_ms: NOW - WINDOW * 2 },
      { id: 5, repo_id: 1, created_at_ms: NOW - WINDOW * 2 },
    ];
    // Filtering repo 1 with limit 2 caps at the 2nd repo-1 match (id 3).
    expect(safeFrontier(rows, 0, 1, 2, NOW, WINDOW).upper_id).toBe(3);
    // With a generous limit, advances to the global frontier (id 5).
    expect(safeFrontier(rows, 0, 1, 100, NOW, WINDOW).upper_id).toBe(5);
  });

  it("returns after_id unchanged when caught up (no rows)", () => {
    expect(safeFrontier([], 42, undefined, 100, NOW, WINDOW).upper_id).toBe(42);
  });

  it("stalls at after_id when the very first id is a hot leading gap", () => {
    // cursor 0, first visible id is 2 (young) → id 1 may be committing.
    const rows: FrontierRow[] = [{ id: 2, repo_id: 1, created_at_ms: NOW - 100 }];
    expect(safeFrontier(rows, 0, undefined, 100, NOW, WINDOW).upper_id).toBe(0);
  });

  it("crosses a leading burned gap when the first visible id is old", () => {
    const rows: FrontierRow[] = [{ id: 2, repo_id: 1, created_at_ms: NOW - WINDOW * 2 }];
    expect(safeFrontier(rows, 0, undefined, 100, NOW, WINDOW).upper_id).toBe(2);
  });
});
