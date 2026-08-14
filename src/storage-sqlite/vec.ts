/**
 * sqlite-vec extension loading + float32 BLOB encode/decode.
 *
 * Design §7.2.1 pins SQLite vector search at brute-force in v1 (indexed
 * ANN belongs to M5's pgvector adapter). This module keeps that posture:
 *   • Vectors live in `chunks.embedding` as raw little-endian float32
 *     BLOBs — one column, one representation, one round-trip cost.
 *   • Distance is computed by sqlite-vec's `vec_distance_cosine` UDF over
 *     the join with `versions.next_id IS NULL`; no `vec0` virtual table
 *     (would be a shadow store to keep in sync with the version chain).
 *
 * m4-plan §5 decision 3.
 */

import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/**
 * Load the sqlite-vec loadable extension into a better-sqlite3 handle.
 * Idempotent per connection — safe to call multiple times.
 *
 * m4-plan risks: extension loading is the platform risk. If a CI cell
 * lacks the prebuilt binary for its (arch, glibc) combination, this
 * throws at open() rather than at query time — visible failure, not
 * silent degradation.
 */
export function loadSqliteVec(db: Database.Database): void {
  sqliteVec.load(db);
}

/**
 * Encode a JS number array (or Float32Array) as a little-endian float32
 * BLOB — the wire format sqlite-vec's distance UDFs expect.
 *
 * Node Buffers back their underlying ArrayBuffer natively little-endian
 * on every platform mrplex supports, but we pin the byteOrder explicitly
 * so a future big-endian read (e.g. from a non-JS reader — see m4-plan
 * risks) has a documented contract to check against.
 */
export function encodeVectorBlob(vector: readonly number[] | Float32Array): Buffer {
  const arr = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  // Copy into a fresh Buffer so callers holding the Float32Array can't
  // observe mutations through the BLOB later.
  const buf = Buffer.alloc(arr.byteLength);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i] as number, i * 4);
  }
  return buf;
}

/**
 * Decode a float32 BLOB back to a Float32Array. Length must be a
 * multiple of 4; otherwise the BLOB was written by something that
 * disagreed with §chunks storage — throw rather than silently truncate.
 */
export function decodeVectorBlob(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `vec: BLOB length ${buf.byteLength} is not a multiple of 4 (expected float32)`,
    );
  }
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = buf.readFloatLE(i * 4);
  }
  return out;
}
