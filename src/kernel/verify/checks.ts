/**
 * Shared context + helpers for the verify check families (docs/verify-plan.md
 * §2). Each family is a pure-ish async function `(ctx) => void` that reads
 * through the storage scans (WS2) and pushes findings onto the accumulator.
 *
 * Scope (§2.7): a family emits a finding only when the caller can read the
 * referenced path. For derived-table orphans that reference an UNREADABLE
 * version, the finding is dropped (a scoped caller verifies only its slice;
 * a full-trust `--unsafe` run sees everything). `canRead` centralizes that.
 */

import type { LinkConfig } from "../../links/link-config.js";
import type { RepoRow, Storage } from "../../storage/types.js";
import type { ClaimMatcher } from "../auth/scope.js";
import { claimsGrantRead } from "../auth/scope.js";
import type { PathConfig } from "../path-config.js";
import { encodeVersionId } from "../version-id.js";
import type { VerifyFinding } from "../wire.js";
import type { VerifyAccumulator } from "./verify.js";

/** Page size for the keyset-paginated verify scans. */
export const SCAN_BATCH = 500;

export type CheckContext = {
  storage: Storage;
  repo: RepoRow;
  /** Effective path config for the repo (system/hidden sigils, etc.). */
  pathConfig: PathConfig;
  /** Effective link-extraction config for the repo (the `links` family). */
  linkConfig: LinkConfig;
  claims: ClaimMatcher[] | null;
  acc: VerifyAccumulator;
  /** Whether `check` (family or full code) is selected this run. */
  selected: (check: string) => boolean;
};

/** Encode an internal version id for the wire (opaque string, §3.3). */
export function vid(id: number): string {
  return encodeVersionId(id);
}

/** Encode an internal document id for the wire (reuses the version-id codec). */
export function did(id: number): string {
  return encodeVersionId(id);
}

/**
 * True when the caller may read `path` in this repo. Absent scope = full
 * visibility. Used to drop findings that would leak an unreadable path (§2.7).
 */
export function canRead(ctx: CheckContext, path: string): boolean {
  return ctx.claims === null || claimsGrantRead(ctx.claims, ctx.repo.slug, path);
}

/** Build a finding pre-filled with the repo slug. */
export function finding(ctx: CheckContext, f: Omit<VerifyFinding, "repo">): VerifyFinding {
  return { repo: ctx.repo.slug, ...f };
}
