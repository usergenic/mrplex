/**
 * Embedding hook contract (design §5.3).
 *
 *   embed(chunks: string[]) → { vectors: number[][], model: string, dim: int }
 *
 * mrplex does NOT call any provider itself: the operator wires a hook
 * that speaks this contract. m4-plan ships two shapes: HTTP endpoint
 * (--embed-url) and long-lived subprocess with JSON-lines over stdio
 * (--embed-cmd). In-process plugin is deferred (m4-plan §5 decision 1).
 *
 * Contract-validation happens here so every shape gets the same
 * checks: batch alignment, per-vector dim, non-empty model. A single
 * bad response fails the whole batch — never partial-write.
 */

export type EmbedResponse = {
  vectors: number[][];
  model: string;
  dim: number;
};

export type EmbedHook = {
  /** Human-facing description (URL / command), used in log lines. */
  label: string;
  /**
   * Embed a batch. Batching, rate limiting, provider retries all live
   * inside the hook (§5.3) — the worker only paces dispatch.
   *
   * Contract-invariant: `vectors[i]` corresponds to `chunks[i]`.
   */
  embed(chunks: readonly string[]): Promise<EmbedResponse>;
  /** Release resources (kill subprocess, close sockets). */
  close(): Promise<void>;
};

/**
 * Validate a response against the hook contract. Returns the response
 * unchanged on success; throws a descriptive Error on any violation.
 * Hooks call this before returning so the worker can trust the shape.
 */
export function validateEmbedResponse(resp: unknown, requested: readonly string[]): EmbedResponse {
  if (typeof resp !== "object" || resp === null) {
    throw new Error("embed hook: response is not an object");
  }
  const r = resp as Record<string, unknown>;
  const model = r.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("embed hook: response.model must be a non-empty string");
  }
  const dim = r.dim;
  if (typeof dim !== "number" || !Number.isInteger(dim) || dim <= 0) {
    throw new Error(
      `embed hook: response.dim must be a positive integer (got ${JSON.stringify(dim)})`,
    );
  }
  const vectors = r.vectors;
  if (!Array.isArray(vectors)) {
    throw new Error("embed hook: response.vectors must be an array");
  }
  if (vectors.length !== requested.length) {
    throw new Error(
      `embed hook: vectors.length (${vectors.length}) !== requested chunks (${requested.length})`,
    );
  }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v)) {
      throw new Error(`embed hook: vectors[${i}] is not an array`);
    }
    if (v.length !== dim) {
      throw new Error(`embed hook: vectors[${i}].length (${v.length}) !== dim (${dim})`);
    }
    for (let j = 0; j < v.length; j++) {
      if (typeof v[j] !== "number" || !Number.isFinite(v[j])) {
        throw new Error(`embed hook: vectors[${i}][${j}] is not a finite number`);
      }
    }
  }
  return { vectors: vectors as number[][], model, dim };
}
