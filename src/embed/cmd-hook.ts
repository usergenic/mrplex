/**
 * Subprocess embedding hook (--embed-cmd). Spawns a long-lived process
 * once; writes one JSON line per batch to stdin; reads one JSON line
 * back from stdout (design §5.3, m4-plan §5 decision 1).
 *
 * Stderr passes through to the server log; the hook doesn't parse it.
 *
 * Concurrency: at most one in-flight embed() call per hook instance.
 * The worker's drain loop is single-flight per batch, so this is fine
 * for v1 — a hook that needs parallelism can implement it internally.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type EmbedHook, type EmbedResponse, validateEmbedResponse } from "./hook.js";

export type CmdHookOptions = {
  command: string;
  /** Optional args if the command needs them (rare; usually a single script). */
  args?: readonly string[];
  timeoutMs?: number;
  /** stderr sink — defaults to the parent's stderr. */
  onStderr?: (chunk: string) => void;
};

export function createCmdEmbedHook(opts: CmdHookOptions): EmbedHook {
  const timeout = opts.timeoutMs ?? 60_000;
  const onStderr = opts.onStderr ?? ((c) => process.stderr.write(c));

  let proc: ChildProcessWithoutNullStreams | null = null;
  let readBuffer = "";
  let pending: ((line: string) => void) | null = null;
  let pendingError: ((err: Error) => void) | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();

  function ensureProc(): ChildProcessWithoutNullStreams {
    if (proc && proc.exitCode === null) return proc;
    proc = spawn(opts.command, opts.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      readBuffer += chunk;
      let nl = readBuffer.indexOf("\n");
      while (nl >= 0) {
        const line = readBuffer.slice(0, nl);
        readBuffer = readBuffer.slice(nl + 1);
        if (pending) {
          const cb = pending;
          pending = null;
          pendingError = null;
          cb(line);
        }
        nl = readBuffer.indexOf("\n");
      }
    });
    proc.stderr.on("data", (chunk: string) => onStderr(chunk));
    proc.on("exit", (code, signal) => {
      const err = new Error(
        `embed hook subprocess exited (code=${code} signal=${signal ?? ""})`,
      );
      if (pendingError) {
        const cb = pendingError;
        pending = null;
        pendingError = null;
        cb(err);
      }
      proc = null;
      readBuffer = "";
    });
    return proc;
  }

  return {
    label: [opts.command, ...(opts.args ?? [])].join(" "),
    async embed(chunks: readonly string[]): Promise<EmbedResponse> {
      // Serialize batches — one in-flight at a time. Awaiting the
      // previous call's promise chains us behind it.
      const gate = inFlight.catch(() => undefined);
      inFlight = gate.then(async () => {
        const p = ensureProc();
        const linePromise = new Promise<string>((resolve, reject) => {
          pending = resolve;
          pendingError = reject;
        });
        const timer = setTimeout(() => {
          if (pendingError) {
            const cb = pendingError;
            pending = null;
            pendingError = null;
            cb(new Error(`embed hook timed out after ${timeout}ms`));
          }
        }, timeout);
        try {
          p.stdin.write(`${JSON.stringify({ chunks })}\n`);
          const line = await linePromise;
          const body: unknown = JSON.parse(line);
          return validateEmbedResponse(body, chunks);
        } finally {
          clearTimeout(timer);
        }
      });
      return inFlight as Promise<EmbedResponse>;
    },
    async close() {
      if (proc && proc.exitCode === null) {
        proc.stdin.end();
        proc.kill();
      }
      proc = null;
    },
  };
}
