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

import { encodeVectorBlob } from "../storage-sqlite/vec.js";
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
      // Empty body: legal state, no embedding needed. Also wipe any
      // prior chunks under any model (the caller's chunks_upsert with
      // empty array handles that, but we skip the empty-model call
      // since we don't know which model applies).
      opts.storage.backlog_delete(entry.version_id);
      return "processed";
    }

    // 1. Dedup lookup: check which hashes we already have vectors for.
    //    We don't know the model yet — chunks_by_hash is per-model —
    //    but the strategy is: probe the "most recently used" model
    //    by looking at any existing chunk for this document's prior
    //    version. Fallback: skip dedup for the first embed under a
    //    given model (worker calls the hook for every chunk).
    const priorChunks = version.prev_id ? opts.storage.chunks_by_version(version.prev_id) : [];
    const priorModel = priorChunks[0]?.model ?? null;

    // Split into (reused, needs_hook).
    const reuseByHash = new Map<string, Buffer>();
    if (priorModel !== null) {
      const hashes = chunks.map((c) => c.text_hash);
      const rows = opts.storage.chunks_by_hash(priorModel, hashes);
      for (const r of rows) reuseByHash.set(r.text_hash, r.embedding);
    }

    const needHookIx: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c === undefined) continue;
      if (!reuseByHash.has(c.text_hash)) {
        needHookIx.push(i);
      }
    }

    let resp: EmbedResponse | null = null;
    if (needHookIx.length > 0) {
      const texts = needHookIx.map((i) => (chunks[i] as { text: string }).text);
      opts.onHookCall?.(texts.length);
      try {
        resp = await opts.hook.embed(texts);
      } catch (err) {
        // Retain with backoff.
        const attempts = entry.attempts + 1;
        const delay = Math.min(baseMs * 2 ** (attempts - 1), capMs);
        const next = new Date(Date.now() + delay).toISOString();
        opts.storage.backlog_retain({
          version_id: entry.version_id,
          attempts,
          last_error: String(err instanceof Error ? err.message : err).slice(0, 500),
          next_retry_at: next,
        });
        return "failed";
      }
    }

    // Model: hook response wins if we called it; otherwise reuse-only
    // uses the prior model.
    const model = resp?.model ?? priorModel;
    if (model === null) {
      // Unreachable in practice — needHookIx.length would be > 0
      // when priorModel is null. Defensive assertion.
      opts.storage.backlog_retain({
        version_id: entry.version_id,
        attempts: entry.attempts + 1,
        last_error: "internal: no model resolvable for chunks",
        next_retry_at: new Date(Date.now() + baseMs).toISOString(),
      });
      return "failed";
    }

    // If the hook returned a different model than prior, we can't reuse
    // prior-model vectors: they belong to a different model. Re-call
    // the hook for everything.
    let effectiveReuse = reuseByHash;
    if (resp && priorModel !== null && resp.model !== priorModel) {
      log(
        `[embed] model changed (${priorModel} → ${resp.model}); re-embedding version ${entry.version_id}`,
      );
      effectiveReuse = new Map();
      const texts = chunks.map((c) => c.text);
      try {
        opts.onHookCall?.(texts.length);
        resp = await opts.hook.embed(texts);
      } catch (err) {
        const attempts = entry.attempts + 1;
        const delay = Math.min(baseMs * 2 ** (attempts - 1), capMs);
        opts.storage.backlog_retain({
          version_id: entry.version_id,
          attempts,
          last_error: String(err instanceof Error ? err.message : err).slice(0, 500),
          next_retry_at: new Date(Date.now() + delay).toISOString(),
        });
        return "failed";
      }
    }

    // Assemble the upsert batch. Order matches chunks[].
    const upsertChunks = chunks.map((c, i) => {
      const reused = effectiveReuse.get(c.text_hash);
      if (reused) {
        return {
          ix: c.ix,
          text: c.text,
          text_hash: c.text_hash,
          model,
          embedding: reused,
        };
      }
      // We just embedded it; find its slot in the hook response.
      const respIx = needHookIx.indexOf(i);
      if (respIx < 0 || !resp) {
        throw new Error("worker: internal — chunk missing from both reuse and response");
      }
      const vec = resp.vectors[respIx];
      if (!vec) throw new Error("worker: internal — response vector missing");
      return {
        ix: c.ix,
        text: c.text,
        text_hash: c.text_hash,
        model,
        embedding: encodeVectorBlob(vec),
      };
    });

    try {
      opts.storage.chunks_upsert(entry.version_id, model, upsertChunks);
      opts.storage.backlog_delete(entry.version_id);
      return "processed";
    } catch (err) {
      const attempts = entry.attempts + 1;
      opts.storage.backlog_retain({
        version_id: entry.version_id,
        attempts,
        last_error: String(err instanceof Error ? err.message : err).slice(0, 500),
        next_retry_at: new Date(Date.now() + baseMs).toISOString(),
      });
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
