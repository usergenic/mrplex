/**
 * HTTP embedding hook (--embed-url). POST { chunks: string[] } → the
 * contract response (design §5.3, m4-plan §5 decision 1).
 *
 * Uses Node ≥ 20's built-in fetch — no dep. Timeout defaults to 30s;
 * anything longer usually means the operator wants a subprocess hook.
 */

import { type EmbedHook, type EmbedResponse, validateEmbedResponse } from "./hook.js";

export type HttpHookOptions = {
  url: string;
  timeoutMs?: number;
};

export function createHttpEmbedHook(opts: HttpHookOptions): EmbedHook {
  const timeout = opts.timeoutMs ?? 30_000;
  return {
    label: opts.url,
    async embed(chunks: readonly string[]): Promise<EmbedResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chunks }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`embed hook HTTP ${res.status}: ${text.slice(0, 500)}`);
        }
        const body: unknown = await res.json();
        return validateEmbedResponse(body, chunks);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      // fetch is stateless; nothing to close.
    },
  };
}
