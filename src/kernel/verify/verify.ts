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

import type { RepoRow, Storage } from "../../storage/types.js";
import { type ClaimMatcher, claimsGrantRepo } from "../auth/scope.js";
import { repoNotFound } from "../errors.js";
import type { PathConfig } from "../path-config.js";
import { effectivePathConfig, parseRepoOverride } from "../path-config.js";
import type { VerifyFinding, VerifyReport, VerifySeverity, VerifySpec } from "../wire.js";

/** Default cap on emitted findings; `counts` stay exact past it (verify-plan §3). */
export const DEFAULT_MAX_FINDINGS = 10_000;

export type VerifyDeps = {
  storage: Storage;
  serverPathConfig: PathConfig;
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

  const acc = new VerifyAccumulator(
    spec.min_severity ?? "warn",
    spec.max_findings ?? DEFAULT_MAX_FINDINGS,
  );

  for (const repo of repos) {
    await runChecks(acc, repo, claims, spec, deps);
  }

  return acc.report();
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

/**
 * Run the selected check families against one repo, appending findings to
 * `acc`. WS1 scaffold — the six families (WS3) plug in here. `effectiveConfig`
 * is resolved once per repo so sigil-aware checks share it.
 */
async function runChecks(
  acc: VerifyAccumulator,
  repo: RepoRow,
  _claims: ClaimMatcher[] | null,
  _spec: VerifySpec,
  deps: VerifyDeps,
): Promise<void> {
  const _effectiveConfig = effectivePathConfig(
    deps.serverPathConfig,
    parseRepoOverride(repo.path_config),
  );
  // WS3 wires the check families in here; the accumulator + config are the
  // seam they hang off. Intentionally empty in the WS1 skeleton.
}
