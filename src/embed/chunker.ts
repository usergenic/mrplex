/**
 * Deterministic markdown-body chunker (design §5.3, m4-plan §5 decision 7).
 *
 * Contract:
 *   • Same input → same chunks. Always. Dedup by (model, text_hash)
 *     relies on this and only this — a change here re-embeds everything.
 *   • Body-only. Frontmatter is the structured/query side (§3.2); the
 *     hook never sees it.
 *   • Splits on ATX heading and blank-line block boundaries; greedy-packs
 *     consecutive blocks up to MAX_CHUNK_CHARS; a single block exceeding
 *     the cap hard-splits at the cap.
 *   • `text_hash` = sha256(chunk_text) — same primitive as token hashing.
 *
 * The chunk-size constant is code, not config: `text_hash` dedup keys
 * would silently invalidate on a config change, and users of `rank`
 * would see quiet drift in ranking behavior across servers. Revisiting
 * chunk size later only costs one backfill (§5.3, `embed backfill`).
 */

import { createHash } from "node:crypto";

/** Maximum characters per chunk. Constant, not config; see file header. */
export const MAX_CHUNK_CHARS = 2000;

export type Chunk = {
  /** 0-based document order. Contiguous within a chunk[] result. */
  ix: number;
  text: string;
  text_hash: string;
};

/**
 * Chunk a document body. Empty / whitespace-only body → empty array
 * (a valid state; the doc simply never ranks — see §5.3).
 */
export function chunkBody(body: string): Chunk[] {
  const blocks = splitBlocks(body);
  const packed = greedyPack(blocks, MAX_CHUNK_CHARS);
  return packed.map((text, ix) => ({
    ix,
    text,
    text_hash: sha256(text),
  }));
}

/**
 * Split into blocks at ATX heading and blank-line boundaries. Blank
 * lines are ONLY the boundary — they don't join the output.
 *
 * "Block" here is coarse: consecutive non-blank lines belong to one
 * block; an ATX heading line starts a fresh block. That covers the
 * common markdown shapes (paragraphs, lists, headings, code fences)
 * without a full commonmark parse. If a code fence contains an
 * accidental `#`-leading line, the heading rule mis-splits — a chunker
 * is not a renderer, and this is worse cosmetically than semantically:
 * the split still deterministically produces the same chunks every
 * time, which is what dedup requires.
 */
function splitBlocks(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  const push = () => {
    if (current.length === 0) return;
    const joined = current.join("\n").replace(/\s+$/, "");
    if (joined.length > 0) blocks.push(joined);
    current = [];
  };
  for (const line of lines) {
    const isBlank = line.trim().length === 0;
    const isHeading = /^\s{0,3}#{1,6}\s/.test(line);
    if (isBlank) {
      push();
      continue;
    }
    if (isHeading && current.length > 0) {
      push();
    }
    current.push(line);
  }
  push();
  return blocks;
}

/**
 * Greedy-pack blocks into chunks of at most `cap` characters. A single
 * block over `cap` hard-splits at exactly `cap` byte-wise on characters
 * (JS string units) — no attempt to preserve word boundaries. Reason:
 * an accidental split is far preferable to a per-corpus non-deterministic
 * split rule (dedup sensitivity, §5.3).
 */
function greedyPack(blocks: readonly string[], cap: number): string[] {
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length === 0) return;
    chunks.push(buf);
    buf = "";
  };
  for (const block of blocks) {
    if (block.length > cap) {
      // Flush anything we were building; hard-split the oversized block.
      flush();
      for (let i = 0; i < block.length; i += cap) {
        chunks.push(block.slice(i, i + cap));
      }
      continue;
    }
    if (buf.length === 0) {
      buf = block;
      continue;
    }
    // Join with a blank line so a two-block chunk still reads as
    // two blocks — hooks that stem/tokenize benefit from the separator.
    const candidate = `${buf}\n\n${block}`;
    if (candidate.length <= cap) {
      buf = candidate;
    } else {
      flush();
      buf = block;
    }
  }
  flush();
  return chunks;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
