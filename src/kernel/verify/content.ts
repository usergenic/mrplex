/**
 * `hash` + `frontmatter` verify families (docs/verify-plan.md §2.2, §2.3).
 *
 * Both re-derive from a version's stored bytes, so they share one
 * `versions_all` walk (a version scan is the expensive part; running both
 * families over it is free). Per version:
 *
 *   • hash.mismatch / hash.missing — recompute contentHash(frontmatter_raw,
 *     body) and compare to the stored content_hash column.
 *   • frontmatter.parse_error / .divergence — re-parse frontmatter_raw as YAML
 *     and deep-equal it against the stored frontmatter JSON.
 *   • frontmatter.system_leak — a `$`-prefixed key must never be persisted
 *     (canonicalizeFrontmatter strips them at write time); a leak corrupts
 *     $content_hash and re-injection.
 *
 * `frontmatter.divergence` is strict and always an error: in a correct store
 * raw and JSON are written together in one tx and cannot drift, so a finding
 * means the query index is lying (verify-plan §2.3, §8).
 */

import { contentHash } from "../../markdown/content-hash.js";
import { FrontmatterInvalidError, parse as parseFrontmatter } from "../../markdown/frontmatter.js";
import type { FrontmatterJson } from "../../storage/types.js";
import { INTRINSIC_SIGIL } from "../constants.js";
import { type CheckContext, SCAN_BATCH, canRead, did, finding, vid } from "./checks.js";

export async function checkContent(ctx: CheckContext): Promise<void> {
  const hashMismatch = ctx.selected("hash.mismatch");
  const hashMissing = ctx.selected("hash.missing");
  const parseError = ctx.selected("frontmatter.parse_error");
  const divergence = ctx.selected("frontmatter.divergence");
  const systemLeak = ctx.selected("frontmatter.system_leak");

  const anyHash = hashMismatch || hashMissing;
  const anyFm = parseError || divergence || systemLeak;
  if (!anyHash && !anyFm) return;

  let afterId = 0;
  for (;;) {
    const versions = await ctx.storage.versions_all({
      repo_id: ctx.repo.id,
      after_id: afterId,
      limit: SCAN_BATCH,
    });
    if (versions.length === 0) break;
    // Note: the chain family already tallies versions_scanned via
    // versions_by_document; this family doesn't double-count.

    for (const v of versions) {
      afterId = v.id; // advance the keyset cursor first (defensive: no continue today)
      const path = canRead(ctx, v.path) ? v.path : undefined;

      if (anyHash) {
        if (v.content_hash === null) {
          if (hashMissing) {
            ctx.acc.add(
              finding(ctx, {
                check: "hash.missing",
                severity: "warn",
                document_id: did(v.document_id),
                version_id: vid(v.id),
                path,
                detail: {},
                suggested_fix: "mrplex hash backfill",
              }),
            );
          }
        } else if (hashMismatch) {
          const computed = contentHash(v.frontmatter_raw, v.body);
          if (computed !== v.content_hash) {
            ctx.acc.add(
              finding(ctx, {
                check: "hash.mismatch",
                severity: "error",
                document_id: did(v.document_id),
                version_id: vid(v.id),
                path,
                detail: { stored: v.content_hash, computed },
              }),
            );
          }
        }
      }

      if (anyFm) {
        checkFrontmatter(ctx, v, path, { parseError, divergence, systemLeak });
      }
    }
  }
}

function checkFrontmatter(
  ctx: CheckContext,
  v: { id: number; document_id: number; frontmatter_raw: string; frontmatter: FrontmatterJson },
  path: string | undefined,
  which: { parseError: boolean; divergence: boolean; systemLeak: boolean },
): void {
  // system_leak: a `$`-prefixed top-level key in the stored raw or JSON.
  if (which.systemLeak) {
    const rawLeak = hasSystemLine(v.frontmatter_raw);
    const jsonLeak = Object.keys(v.frontmatter).some((k) => k.startsWith(INTRINSIC_SIGIL));
    if (rawLeak || jsonLeak) {
      ctx.acc.add(
        finding(ctx, {
          check: "frontmatter.system_leak",
          severity: "error",
          document_id: did(v.document_id),
          version_id: vid(v.id),
          path,
          detail: { in_raw: rawLeak, in_json: jsonLeak },
        }),
      );
    }
  }

  if (!which.parseError && !which.divergence) return;

  let reparsed: FrontmatterJson;
  try {
    reparsed = parseFrontmatter(v.frontmatter_raw);
  } catch (err) {
    if (which.parseError) {
      ctx.acc.add(
        finding(ctx, {
          check: "frontmatter.parse_error",
          severity: "error",
          document_id: did(v.document_id),
          version_id: vid(v.id),
          path,
          detail: {
            reason: err instanceof FrontmatterInvalidError ? err.message : String(err),
          },
        }),
      );
    }
    return; // can't diverge-check what won't parse
  }

  if (which.divergence && !deepEqual(reparsed, v.frontmatter)) {
    ctx.acc.add(
      finding(ctx, {
        check: "frontmatter.divergence",
        severity: "error",
        document_id: did(v.document_id),
        version_id: vid(v.id),
        path,
        detail: { keys_differing: differingKeys(reparsed, v.frontmatter) },
      }),
    );
  }
}

/** True if any top-level line begins with the intrinsic sigil (`$key:`). */
function hasSystemLine(raw: string): boolean {
  if (!raw.includes(INTRINSIC_SIGIL)) return false;
  for (const line of raw.split("\n")) {
    if (line.startsWith(INTRINSIC_SIGIL)) return true;
  }
  return false;
}

/** Top-level keys whose values differ (or are present in only one side). */
function differingKeys(a: FrontmatterJson, b: FrontmatterJson): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (!deepEqual(a[k], b[k])) out.push(k);
  }
  return out.sort();
}

/** Structural deep-equality for JSON values (stored frontmatter is JSON). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}
