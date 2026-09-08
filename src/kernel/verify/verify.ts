/**
 * kernel.verify — a read-only integrity scrub over the store (docs/verify-plan.md).
 *
 * In an append-only store the version chain IS the source of truth, and every
 * other table (fts_docs, chunks, embedding_backlog, links) is a derived index
 * that can silently drift. `verify` re-derives what should be derivable and
 * diffs it against what's stored, plus a set of structural-invariant checks the
 * partial indexes (§3.2) are supposed to make impossible but which a corrupted
 * database can still violate. mrplex's `git fsck`.
 *
 * Findings are DATA, never exceptions (verify-plan §3): the report comes back
 * even when the store is on fire. The only throws are the usual pre-flight ones
 * (`repo_not_found` for a bad `--repo`, `forbidden` never — scope narrows
 * silently, like `query`). Six check families run over a full O(total-versions)
 * history walk; see the check modules under this folder.
 *
 * WS1 (this file, initial): pre-flight + scope + empty report scaffold. The
 * check families (WS3) fill in `runChecks` per repo.
 */

import {
  HARDCODED_DEFAULTS as LINK_DEFAULTS,
  type LinkConfig,
  effectiveLinkConfig,
  parseRepoOverride as parseLinkOverride,
} from "../../links/link-config.js";
import { type RepoRow, type Storage, hasVerifyFtsScans } from "../../storage/types.js";
import { type ClaimMatcher, claimsGrantRepo } from "../auth/scope.js";
import { repoNotFound } from "../errors.js";
import type { PathConfig } from "../path-config.js";
import { effectivePathConfig, parseRepoOverride } from "../path-config.js";
import type { VerifyFinding, VerifyReport, VerifySeverity, VerifySpec } from "../wire.js";
import { checkChain } from "./chain.js";
import type { CheckContext } from "./checks.js";
import { checkChunksStore, checkChunksUnembedded } from "./chunks.js";
import { checkContent } from "./content.js";
import { checkFts } from "./fts.js";
import { checkLinks } from "./links.js";

/** Default cap on emitted findings; `counts` stay exact past it (verify-plan §3). */
export const DEFAULT_MAX_FINDINGS = 10_000;

export type VerifyDeps = {
  storage: Storage;
  serverPathConfig: PathConfig;
  /** Server-level link-extraction config; per-repo overrides layer on top. */
  serverLinkConfig?: LinkConfig;
  /**
   * Whether an embedder is configured for this store (flag → MRPLEX_EMBEDDER →
   * config). Gates the `chunks.unembedded` check: with no embedder it's skipped
   * and noted, never fired on every version (verify-plan §2.5).
   */
  embedderConfigured: boolean;
};

const SEVERITY_RANK: Record<VerifySeverity, number> = { warn: 0, error: 1 };

/**
 * True when `check` (e.g. `chain.prev_next_asymmetry`) is selected by the
 * caller's `checks` list — matched by full code or by family prefix
 * (`chain` selects every `chain.*`). Empty/omitted list = all checks.
 */
export function checkSelected(check: string, checks: readonly string[] | undefined): boolean {
  if (checks === undefined || checks.length === 0) return true;
  const family = check.split(".")[0];
  return checks.some((c) => c === check || c === family);
}

/**
 * Accumulates findings + exact counts across the scan. Findings past
 * `maxFindings` are dropped from the emitted list but still tallied, and
 * `truncated` is set (verify-plan §3).
 */
export class VerifyAccumulator {
  private readonly findings: VerifyFinding[] = [];
  private versionsScanned = 0;
  private documentsScanned = 0;
  private readonly byCheck: Record<string, number> = {};
  private readonly bySeverity: Record<VerifySeverity, number> = { warn: 0, error: 0 };
  private readonly skipped: { check: string; reason: string }[] = [];
  private truncated = false;

  constructor(
    private readonly minSeverity: VerifySeverity,
    private readonly maxFindings: number,
  ) {}

  countVersions(n: number): void {
    this.versionsScanned += n;
  }

  countDocuments(n: number): void {
    this.documentsScanned += n;
  }

  skip(check: string, reason: string): void {
    // Dedupe: a per-repo skip (e.g. chunks.unembedded with no embedder) is
    // noted once for the whole run, not once per repo.
    if (this.skipped.some((s) => s.check === check)) return;
    this.skipped.push({ check, reason });
  }

  add(finding: VerifyFinding): void {
    if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[this.minSeverity]) return;
    this.byCheck[finding.check] = (this.byCheck[finding.check] ?? 0) + 1;
    this.bySeverity[finding.severity] += 1;
    if (this.findings.length < this.maxFindings) {
      this.findings.push(finding);
    } else {
      this.truncated = true;
    }
  }

  report(): VerifyReport {
    return {
      findings: this.findings,
      counts: {
        versions_scanned: this.versionsScanned,
        documents_scanned: this.documentsScanned,
        by_check: this.byCheck,
        by_severity: this.bySeverity,
      },
      checks_skipped: this.skipped,
      truncated: this.truncated,
    };
  }
}

export async function runVerify(
  claims: ClaimMatcher[] | null,
  spec: VerifySpec,
  deps: VerifyDeps,
): Promise<VerifyReport> {
  const repos = await resolveRepos(claims, spec.repo, deps);
  const wholeStore = spec.repo === undefined; // whole-store checks need all repos

  const acc = new VerifyAccumulator(
    spec.min_severity ?? "warn",
    spec.max_findings ?? DEFAULT_MAX_FINDINGS,
  );
  const selected = (check: string): boolean => checkSelected(check, spec.checks);
  const serverLinkConfig = deps.serverLinkConfig ?? LINK_DEFAULTS;

  // Per-repo families: chain, hash/frontmatter, links, chunks.unembedded.
  for (const repo of repos) {
    const ctx: CheckContext = {
      storage: deps.storage,
      repo,
      pathConfig: effectivePathConfig(deps.serverPathConfig, parseRepoOverride(repo.path_config)),
      linkConfig: effectiveLinkConfig(serverLinkConfig, parseLinkOverride(repo.link_config)),
      claims,
      acc,
      selected,
    };
    await checkChain(ctx);
    await checkContent(ctx);
    await checkLinks(ctx);
    if (deps.embedderConfigured) {
      await checkChunksUnembedded(ctx);
    } else if (selected("chunks.unembedded")) {
      acc.skip("chunks.unembedded", "no embedder configured");
    }
  }

  // Whole-store families (fts, chunks orphan/mixed-dim): not repo-partitioned,
  // so they run once over the first repo's context — and only in an all-repos
  // run, since a --repo filter can neither attribute nor bound them (§2.5).
  if (repos.length > 0) {
    const anchor = repos[0] as RepoRow;
    const storeCtx: CheckContext = {
      storage: deps.storage,
      repo: anchor,
      pathConfig: effectivePathConfig(deps.serverPathConfig, parseRepoOverride(anchor.path_config)),
      linkConfig: effectiveLinkConfig(serverLinkConfig, parseLinkOverride(anchor.link_config)),
      claims,
      acc,
      selected,
    };
    await runWholeStoreChecks(storeCtx, wholeStore, deps, acc, selected);
  }

  return acc.report();
}

/**
 * fts + chunks orphan/mixed-dim families. Skipped-with-note under a `--repo`
 * filter (can't attribute a gone version to a repo), and the fts family is
 * further gated on the SQLite-only `VerifyFtsScans` capability (§2.4).
 */
async function runWholeStoreChecks(
  ctx: CheckContext,
  wholeStore: boolean,
  deps: VerifyDeps,
  acc: VerifyAccumulator,
  selected: (check: string) => boolean,
): Promise<void> {
  const ftsSelected = selected("fts.missing") || selected("fts.orphan");
  const chunkStoreSelected =
    selected("chunks.orphan") || selected("chunks.backlog_orphan") || selected("chunks.mixed_dim");

  if (!wholeStore) {
    if (ftsSelected) acc.skip("fts", "whole-store check; omit --repo to run");
    if (chunkStoreSelected) acc.skip("chunks", "whole-store check; omit --repo to run");
    return;
  }

  if (ftsSelected) {
    if (hasVerifyFtsScans(deps.storage)) {
      await checkFts(ctx, deps.storage);
    } else {
      acc.skip("fts", "postgres: fts_tsv is a generated column, structurally consistent");
    }
  }
  if (chunkStoreSelected) {
    await checkChunksStore(ctx);
  }
}

/**
 * The repos this call verifies. A named `repo` resolves to exactly one (and
 * gates existence through scope, same shape as `resolveRepo` in kernel.ts — an
 * out-of-scope repo looks not-found). Omitted = every repo the caller can see,
 * with system-namespaced (deleted) repos excluded, matching `repos.list`.
 */
async function resolveRepos(
  claims: ClaimMatcher[] | null,
  repoSlug: string | undefined,
  deps: VerifyDeps,
): Promise<RepoRow[]> {
  const { storage, serverPathConfig } = deps;
  // A named repo resolves even when system-namespaced (deleted) — an operator
  // may deliberately verify a `:deleted-…` repo's integrity — so this branch
  // does not apply the sigil filter; only the repo-less "all repos" case does.
  if (repoSlug !== undefined) {
    const row = await storage.repos_by_slug(repoSlug);
    if (!row) throw repoNotFound(repoSlug);
    if (claims && !claimsGrantRepo(claims, row.slug)) throw repoNotFound(repoSlug);
    return [row];
  }
  const isSystem = (slug: string): boolean =>
    serverPathConfig.system_sigils.some((sigil) => slug.startsWith(sigil));
  const rows = await storage.repos_list();
  return rows.filter(
    (r) => !isSystem(r.slug) && (claims === null || claimsGrantRepo(claims, r.slug)),
  );
}
