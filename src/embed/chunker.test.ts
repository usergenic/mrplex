import { describe, expect, it } from "vitest";
import { MAX_CHUNK_CHARS, chunkBody } from "./chunker.js";

describe("chunker", () => {
  it("empty body → zero chunks", () => {
    expect(chunkBody("")).toEqual([]);
    expect(chunkBody("\n\n\n")).toEqual([]);
    expect(chunkBody("   \n  \n\t")).toEqual([]);
  });

  it("single short paragraph → one chunk with sha256 hash", () => {
    const c = chunkBody("hello world");
    expect(c.length).toBe(1);
    expect(c[0]?.ix).toBe(0);
    expect(c[0]?.text).toBe("hello world");
    expect(c[0]?.text_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("determinism: same input → identical text_hash across calls", () => {
    const body = "# a\n\ntext one\n\n## b\n\ntext two";
    const c1 = chunkBody(body);
    const c2 = chunkBody(body);
    expect(c1.map((x) => x.text_hash)).toEqual(c2.map((x) => x.text_hash));
  });

  it("headings start a fresh block; blank lines are boundaries", () => {
    const body = "para one\n\npara two\n\n# heading\n\npara three";
    const c = chunkBody(body);
    // With a 2000 cap, all four blocks pack into one chunk — but they
    // stay as textually-separate blocks joined by blank lines.
    expect(c.length).toBe(1);
    expect(c[0]?.text).toContain("para one");
    expect(c[0]?.text).toContain("# heading");
  });

  it("greedy-packs multiple blocks into one chunk when under the cap", () => {
    const a = "a".repeat(200);
    const b = "b".repeat(200);
    const c = "c".repeat(200);
    const chunks = chunkBody(`${a}\n\n${b}\n\n${c}`);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe(`${a}\n\n${b}\n\n${c}`);
  });

  it("splits into multiple chunks when a pack would exceed the cap", () => {
    const half = "x".repeat(MAX_CHUNK_CHARS - 100);
    const other = "y".repeat(200);
    // Two blocks: pack-1 = half, pack-2 = other (because half+"\n\n"+other > cap)
    const chunks = chunkBody(`${half}\n\n${other}`);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.text).toBe(half);
    expect(chunks[1]?.text).toBe(other);
  });

  it("hard-splits a single block that exceeds the cap", () => {
    const big = "z".repeat(MAX_CHUNK_CHARS * 2 + 50);
    const chunks = chunkBody(big);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.text.length).toBe(MAX_CHUNK_CHARS);
    expect(chunks[1]?.text.length).toBe(MAX_CHUNK_CHARS);
    expect(chunks[2]?.text.length).toBe(50);
    // Ix is contiguous 0,1,2.
    expect(chunks.map((c) => c.ix)).toEqual([0, 1, 2]);
  });

  it("ix is contiguous 0-based", () => {
    const body = "# a\n\nblock 1\n\nblock 2\n\n# b\n\nblock 3";
    const chunks = chunkBody(body);
    expect(chunks.map((c) => c.ix)).toEqual(chunks.map((_, i) => i));
  });

  it("different bodies → different hashes (no accidental collisions on real content diffs)", () => {
    const h1 = chunkBody("hello world")[0]?.text_hash;
    const h2 = chunkBody("hello worlds")[0]?.text_hash;
    expect(h1).not.toBe(h2);
  });

  it("trailing whitespace on a block is normalized (dedup-friendly)", () => {
    const h1 = chunkBody("hello")[0]?.text_hash;
    const h2 = chunkBody("hello   ")[0]?.text_hash;
    expect(h1).toBe(h2);
  });
});
