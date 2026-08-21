/**
 * Audit log — auth-shell plan §1 (audit), decision 8; noauth-plan decision 7.
 *
 * Append-only JSONL, one line per authenticated call: `{ ts, principal, op,
 * repo, path, outcome }` (+ engine `error` when the forwarded call failed).
 * Written by the guard's audit sink — a single choke point, so no surface can
 * forget to log. The engine's `author` column is *attribution* (who wrote the
 * content); this log is *accountability* (who called the shell). Different
 * facts, stored in different places on purpose.
 */

import { appendFileSync } from "node:fs";
import type { AuditEvent, AuditSink } from "./guard.js";

/** One serialized audit record. Field order is stable for greppability. */
export type AuditRecord = {
  ts: string;
  principal: string;
  op: string;
  repo?: string;
  path?: string;
  outcome: "ok" | "forbidden";
  error?: string;
};

/**
 * Build an `AuditSink` bound to a principal that appends JSONL to `path`. The
 * guard is principal-agnostic (it knows only the entitlement), so the principal
 * is closed over here — one sink per authenticated session/request.
 *
 * Appends are synchronous: an audit record must be durable before the call's
 * effect is observable, and the volume (one line per op) doesn't justify an
 * async writer. A write failure throws — losing the audit trail silently is
 * worse than failing the call.
 */
export function fileAuditSink(path: string, principal: string): AuditSink {
  return (event: AuditEvent) => {
    const record: AuditRecord = { ts: new Date().toISOString(), principal, ...event };
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  };
}
