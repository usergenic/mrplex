/**
 * Embedding backlog worker (design §5.3, m4-plan WS3).
 *
 * Loop:
 *   1. Dequeue due entries.
 *   2. Skip any version no longer current (superseded — the successor
 *      enqueued its own row).
 *   3. Chunk the body; look up (model, text_hash) reuse via chunks_by_hash.
 *   4. Call the hook for the remainder.
 *   5. chunks_upsert; backlog_delete.
 *   6. On failure: backlog_retain with attempts+1 and exponential backoff.
 *
 * Embedding failure NEVER fails a write (§5.3). It also never blocks
 * subsequent items — a bad version fails, next-retry is scheduled, we
 * move on to the next dequeue candidate.
 *
 * Dedup correctness is load-bearing (m4-plan risks): a text_hash bug
 * silently re-embeds everything. worker.test.ts asserts hook CALL COUNTS,
 * not just resulting vectors.
 */

import type { BacklogRow, Storage } from "../storage/types.js";
import { chunkBody } from "./chunker.js";
import type { EmbedHook, EmbedResponse } from "./hook.js";

export type WorkerOptions = {
  storage: Storage;
  hook: EmbedHook;
  /**
   * Test hook: when set, called each time the worker calls the embedding
   * hook. Used by tests to assert call counts / dedup behavior.
   */
  onHookCall?: (batchSize: number) => void;
  /** How many backlog entries to drain per iteration. Default 8. */
  batchSize?: number;
  /**
   * Delay between drain iterations when the backlog has nothing due.
   * Default 500ms. Tests pass 10ms to keep them fast.
   */
  idleMs?: number;
  /** Base backoff in ms; each attempt doubles up to `backoffCapMs`. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Log sink — defaults to stderr. Never stdout (stdio hygiene, m3). */
  log?: (msg: string) => void;
};

export type Worker = {
  /** Start the drain loop. Idempotent: second call is a no-op. */
  start(): void;
  /**
   * Signal shutdown and await the in-flight batch. After it settles the
   * hook is closed. Idempotent.
   */
  stop(): Promise<void>;
  /**
   * Drain the backlog synchronously (fully, until nothing is due). Used
   * by `embed backfill` — the same worker code path, run once.
   */
  drainOnce(): Promise<{ processed: number; failed: number; skipped: number }>;
};

export function createWorker(opts: WorkerOptions): Worker {
  const batchSize = opts.batchSize ?? 8;
  const idleMs = opts.idleMs ?? 500;
  const baseMs = opts.backoffBaseMs ?? 30_000;
  const capMs = opts.backoffCapMs ?? 3_600_000;
  const log = opts.log ?? ((m) => process.stderr.write(`${m}\n`));

  let running = false;
  let stopping = false;
  let currentIteration: Promise<void> | null = null;

  async function processOne(entry: BacklogRow): Promise<"processed" | "failed" | "skipped"> {
    const version = opts.storage.version_by_id(entry.version_id);
    if (!version) {
      // Version was deleted (impossible in v1) — clear the row.
      opts.storage.backlog_delete(entry.version_id);
      return "skipped";
    }
    if (version.next_id !== null) {
      // Superseded — the successor enqueued its own entry (§5.3).
      opts.storage.backlog_delete(entry.version_id);
      return "skipped";
    }
    const chunks = chunkBody(version.body);
    if (chunks.length === 0) {
      // Empty body: legal state, no embedding needed. Wipe any prior
      // chunks so a doc edited FROM non-empty TO empty doesn't leave
      // stale vectors that keep it rankable (Copilot #2).
      // chunks_upsert with an empty list is a documented "delete all"
      // for the version (see storage-sqlite/adapter.ts). Model string
      // is unused on the empty path but required by the signature.
      opts.storage.chunks_upsert(entry.version_id, "", []);
      opts.storage.backlog_delete(entry.version_id);
      return "processed";
    }

    // 1. Dedup lookup: check which hashes we already have vectors for
    //    under the model the prior version was embedded under. If the
    //    prior version was under a different model than the hook is
    //    about to return, we throw the reuse away below.
    const priorChunks = version.prev_id ? opts.storage.chunks_by_version(version.prev_id) : [];
    const priorModel = priorChunks[0]?.model ?? null;

    // Build the reuse map — hash → embedding — scoped to prior model.
    const reuseByHash = new Map<string, Buffer>();
    if (priorModel !== null) {
      const hashes = chunks.map((c) => c.text_hash);
      const rows = opts.storage.chunks_by_hash(priorModel, hashes);
      for (const r of rows) reuseByHash.set(r.text_hash, r.embedding);
    }

    // Which chunk indexes still need the hook? Compute once; we may
    // rebuild it after a model-change re-embed below.
    let needHookIx: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c === undefined) continue;
      if (!reuseByHash.has(c.text_hash)) needHookIx.push(i);
    }

    // Guard: helper for backoff-retain. Local closure so we can call it
    // from both hook-call paths without duplicating the arithmetic.
    const retain = (err: unknown, attempts: number) => {
      const delay = Math.min(baseMs * 2 ** (attempts - 1), capMs);
      opts.storage.backlog_retain({
        version_id: entry.version_id,
        attempts,
        last_error: String(err instanceof Error ? err.message : err).slice(0, 500),
        next_retry_at: new Date(Date.now() + delay).toISOString(),
      });
    };

    // 2. First hook call (only the not-yet-reused chunks).
    let resp: EmbedResponse | null = null;
    if (needHookIx.length > 0) {
      const texts = needHookIx.map((i) => (chunks[i] as { text: string }).text);
      opts.onHookCall?.(texts.length);
      try {
        resp = await opts.hook.embed(texts);
      } catch (err) {
        retain(err, entry.attempts + 1);
        return "failed";
      }
    }

    // 3. If the hook returned a NEW model — different from priorModel —
    //    the prior-model reuse vectors don't apply. Throw the reuse
    //    away, re-call the hook for EVERY chunk, and rebuild needHookIx
    //    so the assembly loop below finds every chunk's vector in the
    //    fresh response. (Regression fix for the review's model-change
    //    bug: previously needHookIx stayed at the original subset,
    //    which broke assembly for any chunk that was originally reused.)
    let effectiveReuse = reuseByHash;
    if (resp && priorModel !== null && resp.model !== priorModel) {
      log(
        `[embed] model changed (${priorModel} → ${resp.model}); re-embedding version ${entry.version_id}`,
      );
      effectiveReuse = new Map();
      needHookIx = chunks.map((_c, i) => i);
      const texts = chunks.map((c) => c.text);
      opts.onHookCall?.(texts.length);
      try {
        resp = await opts.hook.embed(texts);
      } catch (err) {
        retain(err, entry.attempts + 1);
        return "failed";
      }
    }

    // Model: hook response wins if we called it; otherwise (all-reuse
    // path) the prior model applies.
    const model = resp?.model ?? priorModel;
    if (model === null) {
      // Unreachable — needHookIx.length > 0 when priorModel is null, so
      // resp would be set. Defensive.
      retain(new Error("internal: no model resolvable for chunks"), entry.attempts + 1);
      return "failed";
    }

    // 4. Assemble the upsert batch. Every chunk is either reused (hash
    //    in effectiveReuse) or freshly embedded (index in needHookIx).
    //    Build a chunk-index → vector-blob map so both cases resolve in
    //    O(1) without an indexOf scan.
    const vectorByIx = new Map<number, readonly number[]>();
    if (resp) {
      for (let j = 0; j < needHookIx.length; j++) {
        const i = needHookIx[j] as number;
        const vec = resp.vectors[j];
        if (!vec) {
          retain(new Error("internal: response vector missing"), entry.attempts + 1);
          return "failed";
        }
        vectorByIx.set(i, vec);
      }
    }

    const upsertChunks = chunks.map((c, i) => {
      const fresh = vectorByIx.get(i);
      if (fresh) {
        return { ix: c.ix, text: c.text, text_hash: c.text_hash, model, embedding: fresh };
      }
      const reused = effectiveReuse.get(c.text_hash);
      if (!reused) {
        // Defensive — every chunk should be covered by fresh OR reuse.
        throw new Error(
          `worker: internal — chunk ${i} of version ${entry.version_id} has no vector`,
        );
      }
      return { ix: c.ix, text: c.text, text_hash: c.text_hash, model, embedding: reused };
    });

    try {
      opts.storage.chunks_upsert(entry.version_id, model, upsertChunks);
      opts.storage.backlog_delete(entry.version_id);
      return "processed";
    } catch (err) {
      retain(err, entry.attempts + 1);
      return "failed";
    }
  }

  async function drainOnce() {
    const now = new Date().toISOString();
    const due = opts.storage.backlog_dequeue(now, batchSize);
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    for (const entry of due) {
      if (stopping) break;
      const result = await processOne(entry);
      if (result === "processed") processed++;
      else if (result === "failed") failed++;
      else skipped++;
    }
    return { processed, failed, skipped };
  }

  async function loop() {
    while (!stopping) {
      const { processed, failed, skipped } = await drainOnce();
      if (processed + failed + skipped === 0) {
        // Nothing due — sleep.
        await new Promise((r) => setTimeout(r, idleMs));
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopping = false;
      currentIteration = loop();
    },
    async stop() {
      stopping = true;
      if (currentIteration) {
        await currentIteration.catch((err) => {
          log(`[embed] worker loop error: ${String(err)}`);
        });
        currentIteration = null;
      }
      await opts.hook.close();
      running = false;
    },
    async drainOnce() {
      // Keep draining until nothing is due — used by `embed backfill`.
      let acc = { processed: 0, failed: 0, skipped: 0 };
      while (true) {
        const round = await drainOnce();
        acc = {
          processed: acc.processed + round.processed,
          failed: acc.failed + round.failed,
          skipped: acc.skipped + round.skipped,
        };
        if (round.processed + round.failed + round.skipped === 0) break;
        if (round.failed > 0 && round.processed === 0) {
          // Every entry failed on this round — hook is down, backfill
          // caller should see it now.
          break;
        }
      }
      return acc;
    },
  };
}
