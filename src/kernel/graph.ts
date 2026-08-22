/**
 * kernel.graph — the graph read surface (docs/graph-plan.md).
 *
 * A read-only BFS neighborhood expansion over the repo-local `links` derived
 * index. Given a root set, expand outward under a direction lens, honoring
 * scope and `filter` as *visibility* (traversal happens inside the visible
 * subgraph), and return documents, distinct induced links, a behavioral
 * frontier, and truncation metadata.
 *
 * The whole thing is expressed in the system's own vocabulary — documents and
 * links — with no node/edge layer. See §5 for the pinned decisions.
 *
 * Visibility reuse: rather than re-implement scope/sigil/filter evaluation,
 * every visibility check runs through the existing `versions_search` path via
 * a `SearchPlan`. `$degrees` is bound per round by rewriting the parsed filter
 * to an integer constant (degrees.ts), so both dialect compilers stay unaware
 * of it. This is the "reuse the SearchPlan path" mandate of §4.3.
 */

import { BODY_FIELD } from "../links/extract.js";
import type { SearchPlan, SigilExclusion } from "../storage/search-plan.js";
import type { AdjacentLink, RepoRow, Storage, VersionRow } from "../storage/types.js";
import { compileGlob } from "./auth/glob.js";
import { type ClaimMatcher, claimsGrantRepo, claimsToScopeGroups } from "./auth/scope.js";
import { KernelError, repoNotFound } from "./errors.js";
import { type PathConfig, effectivePathConfig, parseRepoOverride } from "./path-config.js";
import type { CelExpr } from "./query/ast.js";
import { parseCel } from "./query/cel-parse.js";
import { bindDegrees } from "./query/degrees.js";
import type { GraphDirection, GraphDocument, GraphLink, GraphResult, GraphSpec } from "./wire.js";

// Defaults + caps (§8). Following query's constant-default style rather than
// config knobs; a generous links ceiling keeps a hub expansion bounded.
export const DEFAULT_DEGREES = 1;
export const MAX_DEGREES = 5;
export const DEFAULT_MAX_DOCUMENTS = 100;
export const HARD_MAX_DOCUMENTS = 500;
export const LINKS_CEILING = 5000;

export type GraphDeps = {
  storage: Storage;
  serverPathConfig: PathConfig;
};

type Internal = {
  storage: Storage;
  repo: RepoRow;
  claims: ClaimMatcher[] | null;
  scope: SearchPlan["scope"];
  sigils: readonly SigilExclusion[];
  direction: GraphDirection;
  degrees: number;
  maxDocuments: number;
  fieldSet: ReadonlySet<string> | null; // storage field values, or null = all
  filterAst: CelExpr | undefined;
  select: string[];
};

export async function runGraph(
  claims: ClaimMatcher[] | null,
  spec: GraphSpec,
  deps: GraphDeps,
): Promise<GraphResult> {
  const repo = await deps.storage.repos_by_slug(spec.repo);
  if (!repo) throw repoNotFound(spec.repo);
  if (claims && !claimsGrantRepo(claims, repo.slug)) throw repoNotFound(spec.repo);

  const internal = buildInternal(claims, spec, deps, repo);

  const rootPatterns = normalizeRoots(spec.roots);
  const emptyResult: GraphResult = {
    documents: [],
    links: [],
    frontier: [],
    complete_degrees: 0,
    truncated: false,
  };

  // 1-2. Resolve roots against visible, filter-matching current docs at
  // $degrees = 0. A glob matching nothing → empty result, not an error.
  const roots = await resolveRoots(internal, rootPatterns);
  if (roots.length === 0) return emptyResult;

  // 3-4. BFS by rounds within the effective graph, bounded by max_documents.
  const bfs = await expand(internal, roots);

  // 5. Behavioral frontier: admitted docs with ≥1 effective link to a
  // document not in the result.
  const frontier = await computeFrontier(internal, bfs);

  // 6. Induced links: distinct (source, target, field) over admitted docs.
  const { links, linksTruncated } = await inducedLinks(internal, bfs.admittedIds);

  // 7. Degree counts: scope-visible distinct in/out neighbor counts,
  // independent of this call's filter/fields/degrees.
  const degreeCounts = await degreeCountsFor(internal, bfs.admittedIds);

  // 8. Assemble. Documents ordered ($degrees, $path); links (source,target,field).
  const documents = assembleDocuments(internal, bfs, degreeCounts);

  return {
    documents,
    links,
    frontier,
    complete_degrees: bfs.completeDegrees,
    truncated: bfs.truncated || linksTruncated,
  };
}

// -----------------------------------------------------------------------------
// Spec validation + normalization
// -----------------------------------------------------------------------------

const KNOWN_FIELDS = new Set<keyof GraphSpec>([
  "repo",
  "roots",
  "direction",
  "degrees",
  "fields",
  "filter",
  "select",
  "max_documents",
]);

function buildInternal(
  claims: ClaimMatcher[] | null,
  spec: GraphSpec,
  deps: GraphDeps,
  repo: RepoRow,
): Internal {
  for (const key of Object.keys(spec)) {
    if (!KNOWN_FIELDS.has(key as keyof GraphSpec)) {
      throw new KernelError("filter_invalid", {
        reason: `unknown GraphSpec field: ${JSON.stringify(key)}`,
      });
    }
  }

  const direction = spec.direction ?? "both";
  if (direction !== "out" && direction !== "in" && direction !== "both") {
    throw new KernelError("filter_invalid", {
      reason: `direction must be "out", "in", or "both" (got ${JSON.stringify(direction)})`,
    });
  }

  let degrees = spec.degrees ?? DEFAULT_DEGREES;
  if (!Number.isSafeInteger(degrees) || degrees < 0) {
    throw new KernelError("filter_invalid", {
      reason: `degrees must be a non-negative integer (got ${JSON.stringify(spec.degrees)})`,
    });
  }
  if (degrees > MAX_DEGREES) degrees = MAX_DEGREES;

  let maxDocuments = spec.max_documents ?? DEFAULT_MAX_DOCUMENTS;
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments <= 0) {
    throw new KernelError("filter_invalid", {
      reason: `max_documents must be a positive integer (got ${JSON.stringify(spec.max_documents)})`,
    });
  }
  if (maxDocuments > HARD_MAX_DOCUMENTS) maxDocuments = HARD_MAX_DOCUMENTS;

  // `fields` maps `$body` → the storage sentinel; other members are
  // frontmatter field paths, stored verbatim.
  let fieldSet: ReadonlySet<string> | null = null;
  if (spec.fields !== undefined) {
    if (!Array.isArray(spec.fields) || spec.fields.some((f) => typeof f !== "string")) {
      throw new KernelError("filter_invalid", { reason: "fields must be an array of strings" });
    }
    fieldSet = new Set(spec.fields.map((f) => (f === "$body" ? BODY_FIELD : f)));
  }

  const select = spec.select ?? ["title"];
  if (!Array.isArray(select) || select.some((s) => typeof s !== "string")) {
    throw new KernelError("filter_invalid", { reason: "select must be an array of strings" });
  }
  for (const key of select) {
    if (key.startsWith("$")) {
      throw new KernelError("filter_invalid", {
        reason: `select takes bare frontmatter keys, not intrinsics (got ${JSON.stringify(key)})`,
      });
    }
  }

  let filterAst: CelExpr | undefined;
  if (spec.filter !== undefined) {
    const parsed = parseCel(spec.filter);
    if (!parsed.expr) throw new KernelError("filter_invalid", { reason: "empty filter" });
    filterAst = parsed.expr;
  }

  const effectiveConfig = effectivePathConfig(
    deps.serverPathConfig,
    parseRepoOverride(repo.path_config),
  );
  const sigils = buildSigilExclusion(repo.id, effectiveConfig);
  const scope = buildScope(claims, repo);

  return {
    storage: deps.storage,
    repo,
    claims,
    scope,
    sigils,
    direction,
    degrees,
    maxDocuments,
    fieldSet,
    filterAst,
    select,
  };
}

function normalizeRoots(roots: string | string[]): string[] {
  const list = Array.isArray(roots) ? roots : [roots];
  if (list.length === 0 || list.some((r) => typeof r !== "string")) {
    throw new KernelError("filter_invalid", {
      reason: "roots must be a path/glob string or a non-empty array of them",
    });
  }
  return list;
}

/**
 * A graph never surfaces system/hidden docs unless the caller could, but the
 * graph tool has no include_hidden/system flags — expansion always excludes
 * hidden + system namespaces (matching `query`'s defaults). Build the
 * exclusion the same way runQuery does.
 */
function buildSigilExclusion(repoId: number, cfg: PathConfig): SigilExclusion[] {
  const sigils = [...cfg.hidden_sigils, ...cfg.system_sigils];
  if (sigils.length === 0) return [];
  return [{ repo_ids: [repoId], sigils }];
}

function buildScope(claims: ClaimMatcher[] | null, repo: RepoRow): SearchPlan["scope"] {
  if (claims === null) return { kind: "allow_all" };
  const groups = claimsToScopeGroups(claims, [repo]);
  if (groups.length === 0) return { kind: "deny_all" };
  return { kind: "groups", groups };
}

// -----------------------------------------------------------------------------
// Visibility (§4.1, §4.3) — reuses versions_search.
// -----------------------------------------------------------------------------

/**
 * Return the subset of `docIds` that are visible at hop `degrees` — i.e. live
 * current documents passing scope∧sigils∧filter (with `$degrees` bound to
 * `degrees`). One `versions_search` pass over the candidate document set.
 */
async function visibleAt(
  internal: Internal,
  docIds: readonly number[],
  degrees: number,
): Promise<VersionRow[]> {
  if (docIds.length === 0) return [];
  if (internal.scope.kind === "deny_all") return [];
  const filterAst =
    internal.filterAst === undefined ? undefined : bindDegrees(internal.filterAst, degrees);
  const plan: SearchPlan = {
    repo_ids: [internal.repo.id],
    // A generous cap: we want every visible candidate. candidate_document_ids
    // already bounds the result to the batch.
    limit: docIds.length,
    filter_ast: filterAst,
    sigils: internal.sigils,
    scope: internal.scope,
    candidate_document_ids: docIds,
  };
  return internal.storage.versions_search(plan);
}

/**
 * Scope+sigil visibility WITHOUT the filter — used for `$links`/`$backlinks`
 * degree counts, which describe true visible connectivity independent of this
 * call's filter/fields/degrees (§2.2, decision 7).
 */
async function scopeVisible(internal: Internal, docIds: readonly number[]): Promise<Set<number>> {
  if (docIds.length === 0) return new Set();
  if (internal.scope.kind === "deny_all") return new Set();
  const plan: SearchPlan = {
    repo_ids: [internal.repo.id],
    limit: docIds.length,
    sigils: internal.sigils,
    scope: internal.scope,
    candidate_document_ids: docIds,
  };
  const rows = await internal.storage.versions_search(plan);
  return new Set(rows.map((r) => r.document_id));
}

// -----------------------------------------------------------------------------
// Roots (§4.2)
// -----------------------------------------------------------------------------

async function resolveRoots(internal: Internal, patterns: string[]): Promise<VersionRow[]> {
  // Candidate live docs whose path matches any root pattern.
  const live = await internal.storage.versions_live_by_repo(internal.repo.id);
  const regexes = patterns.map((p) => compileGlob(p));
  const matchIds = live
    .filter((v) => regexes.some((re) => re.test(v.path)))
    .map((v) => v.document_id);
  if (matchIds.length === 0) return [];
  // Roots are visible + filter-matching at $degrees = 0.
  const visible = await visibleAt(internal, matchIds, 0);
  return visible;
}

// -----------------------------------------------------------------------------
// BFS expansion (§4.3, §4.4)
// -----------------------------------------------------------------------------

type BfsState = {
  /** document_id → { degrees, version } for every admitted document. */
  admitted: Map<number, { degrees: number; version: VersionRow }>;
  /** Admitted ids in deterministic BFS order (round, then path). */
  admittedOrder: number[];
  admittedIds: number[];
  completeDegrees: number;
  truncated: boolean;
  /** document_ids at the final admitted round that may need expansion still
   * (cut by degrees cap or by budget). */
  boundaryIds: number[];
};

async function expand(internal: Internal, roots: VersionRow[]): Promise<BfsState> {
  const admitted = new Map<number, { degrees: number; version: VersionRow }>();
  const admittedOrder: number[] = [];

  // Admit roots (round 0), sorted by path for determinism.
  const sortedRoots = [...roots].sort((a, b) => cmpPath(a.path, b.path));
  let truncated = false;
  let completeDegrees = 0;

  for (const v of sortedRoots) {
    if (admitted.size >= internal.maxDocuments) {
      truncated = true;
      break;
    }
    admitted.set(v.document_id, { degrees: 0, version: v });
    admittedOrder.push(v.document_id);
  }
  // If roots themselves overflowed the budget, round 0 is incomplete.
  if (truncated) {
    completeDegrees = 0;
    return finishState(admitted, admittedOrder, completeDegrees, truncated, [
      // boundary = admitted round-0 docs (all potentially unexpanded)
      ...admittedOrder,
    ]);
  }
  completeDegrees = 0; // will bump to r on each clean round

  let frontierIds = [...admittedOrder]; // round r-1's newly admitted docs
  for (let r = 1; r <= internal.degrees; r++) {
    if (frontierIds.length === 0) {
      // Nothing left to expand — the whole reachable graph fits; complete
      // through the requested degrees.
      completeDegrees = internal.degrees;
      break;
    }
    // Candidate neighbor document ids reached this round (not yet admitted).
    const neighborIds = await neighborsOf(internal, frontierIds);
    const fresh = [...new Set(neighborIds)].filter((id) => !admitted.has(id));
    if (fresh.length === 0) {
      // Ring r is empty: every neighbor already seen. Complete through r.
      completeDegrees = r;
      frontierIds = [];
      continue;
    }
    // Visibility at this round ($degrees = r).
    const visibleRows = await visibleAt(internal, fresh, r);
    // Deterministic admission order within the round: by path.
    visibleRows.sort((a, b) => cmpPath(a.path, b.path));

    const admittedThisRound: number[] = [];
    let roundCut = false;
    for (const v of visibleRows) {
      if (admitted.has(v.document_id)) continue;
      if (admitted.size >= internal.maxDocuments) {
        roundCut = true;
        break;
      }
      admitted.set(v.document_id, { degrees: r, version: v });
      admittedOrder.push(v.document_id);
      admittedThisRound.push(v.document_id);
    }

    if (roundCut) {
      // Budget cut this ring mid-way: the previous ring is the last exhaustive
      // one (§4.4).
      completeDegrees = r - 1;
      truncated = true;
      // Boundary = everything admitted this round PLUS the prior frontier
      // (their onward links weren't fully enumerated) — but the frontier peek
      // handles the general behavioral test, so return the admitted-this-round
      // plus prior frontier as expansion candidates.
      return finishState(admitted, admittedOrder, completeDegrees, truncated, [
        ...admittedThisRound,
        ...frontierIds,
      ]);
    }

    // Clean ring.
    completeDegrees = r;
    frontierIds = admittedThisRound;
  }

  // Boundary docs whose onward links weren't enumerated: those admitted at the
  // final requested degree (they were never expanded).
  const boundaryIds = admittedOrder.filter(
    (id) => (admitted.get(id) as { degrees: number }).degrees === internal.degrees,
  );
  return finishState(admitted, admittedOrder, completeDegrees, truncated, boundaryIds);
}

function finishState(
  admitted: Map<number, { degrees: number; version: VersionRow }>,
  admittedOrder: number[],
  completeDegrees: number,
  truncated: boolean,
  boundaryIds: number[],
): BfsState {
  return {
    admitted,
    admittedOrder,
    admittedIds: [...admitted.keys()],
    completeDegrees,
    truncated,
    boundaryIds,
  };
}

/**
 * Distinct neighbor document ids of `sourceIds` under the direction lens,
 * `fields`-filtered. Traversal only follows edges whose field passes `fields`.
 */
async function neighborsOf(internal: Internal, sourceIds: readonly number[]): Promise<number[]> {
  const adj = await adjacencyFor(internal, sourceIds);
  const out: number[] = [];
  for (const a of adj) {
    // The "other end" relative to the seed set depends on which direction the
    // edge was fetched for; adjacencyFor already orients this.
    out.push(a.otherId);
  }
  return out;
}

type OrientedLink = { seedId: number; otherId: number; field: string };

/**
 * Fetch adjacency for a seed set under the lens, `fields`-filtered, returning
 * oriented links: `seedId` is the doc in the seed set, `otherId` the neighbor.
 * For "both", out- and in-adjacency are unioned.
 */
async function adjacencyFor(
  internal: Internal,
  seedIds: readonly number[],
): Promise<OrientedLink[]> {
  const oriented: OrientedLink[] = [];
  const passesField = (field: string): boolean =>
    internal.fieldSet === null || internal.fieldSet.has(field);

  if (internal.direction === "out" || internal.direction === "both") {
    const rows = await internal.storage.links_adjacent_out(internal.repo.id, seedIds);
    for (const r of rows) {
      if (passesField(r.field)) {
        oriented.push({ seedId: r.source_id, otherId: r.target_id, field: r.field });
      }
    }
  }
  if (internal.direction === "in" || internal.direction === "both") {
    const rows = await internal.storage.links_adjacent_in(internal.repo.id, seedIds);
    for (const r of rows) {
      if (passesField(r.field)) {
        oriented.push({ seedId: r.target_id, otherId: r.source_id, field: r.field });
      }
    }
  }
  return oriented;
}

// -----------------------------------------------------------------------------
// Frontier (§4.5) — behavioral: admitted docs with ≥1 effective link to a
// document not in the result.
// -----------------------------------------------------------------------------

async function computeFrontier(internal: Internal, bfs: BfsState): Promise<string[]> {
  if (bfs.boundaryIds.length === 0) return [];
  const boundary = [...new Set(bfs.boundaryIds)];
  const oriented = await adjacencyFor(internal, boundary);

  // Candidate neighbor ids not already in the result.
  const neighborIds = new Set<number>();
  for (const o of oriented) {
    if (!bfs.admitted.has(o.otherId)) neighborIds.add(o.otherId);
  }
  if (neighborIds.size === 0) return [];

  // Cheap visibility (§8 "start cheap"): a neighbor counts as potentially-new
  // if it is scope+sigil visible (filter-unknown neighbors treated as
  // potentially-new). This keeps the peek to one batched call.
  const visibleNeighbors = await scopeVisible(internal, [...neighborIds]);
  if (visibleNeighbors.size === 0) return [];

  const frontierDocIds = new Set<number>();
  for (const o of oriented) {
    if (!bfs.admitted.has(o.otherId) && visibleNeighbors.has(o.otherId)) {
      frontierDocIds.add(o.seedId);
    }
  }
  const paths = [...frontierDocIds]
    .map((id) => (bfs.admitted.get(id) as { version: VersionRow }).version.path)
    .sort(cmpPath);
  return paths;
}

// -----------------------------------------------------------------------------
// Induced links (§4.6) — distinct (source, target, field) over admitted docs.
// -----------------------------------------------------------------------------

async function inducedLinks(
  internal: Internal,
  admittedIds: readonly number[],
): Promise<{ links: GraphLink[]; linksTruncated: boolean }> {
  if (admittedIds.length === 0) return { links: [], linksTruncated: false };
  const admittedSet = new Set(admittedIds);
  // One outbound pass over admitted sources; keep edges whose target is also
  // admitted and whose field passes `fields`. Directional lens does not narrow
  // the induced set — it is the complete picture over the shown documents.
  const rows = await internal.storage.links_adjacent_out(internal.repo.id, admittedIds);
  const passesField = (field: string): boolean =>
    internal.fieldSet === null || internal.fieldSet.has(field);

  // Map document_id → path for the admitted set.
  const pathById = await pathsForAdmitted(internal, admittedIds);

  const seen = new Set<string>();
  const links: GraphLink[] = [];
  for (const r of rows) {
    if (!admittedSet.has(r.target_id)) continue;
    if (!passesField(r.field)) continue;
    const source = pathById.get(r.source_id);
    const target = pathById.get(r.target_id);
    if (source === undefined || target === undefined) continue;
    const field = r.field === BODY_FIELD ? BODY_FIELD : r.field;
    const key = `${source} ${target} ${field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source, target, field });
  }
  links.sort(
    (a, b) =>
      cmpPath(a.source, b.source) ||
      cmpPath(a.target, b.target) ||
      (a.field < b.field ? -1 : a.field > b.field ? 1 : 0),
  );
  if (links.length > LINKS_CEILING) {
    return { links: links.slice(0, LINKS_CEILING), linksTruncated: true };
  }
  return { links, linksTruncated: false };
}

// Cache of admitted-doc paths keyed by the concrete BfsState.admitted map is
// awkward to thread; recompute once here from storage in a single batch.
async function pathsForAdmitted(
  internal: Internal,
  admittedIds: readonly number[],
): Promise<Map<number, string>> {
  const rows = await internal.storage.versions_current_by_documents(internal.repo.id, admittedIds);
  const map = new Map<number, string>();
  for (const r of rows) map.set(r.document_id, r.path);
  return map;
}

// -----------------------------------------------------------------------------
// Degree counts (§4.7) — scope-visible distinct in/out neighbor counts,
// independent of filter/fields/degrees.
// -----------------------------------------------------------------------------

type DegreeCounts = { links: number; backlinks: number };

async function degreeCountsFor(
  internal: Internal,
  admittedIds: readonly number[],
): Promise<Map<number, DegreeCounts>> {
  const result = new Map<number, DegreeCounts>();
  for (const id of admittedIds) result.set(id, { links: 0, backlinks: 0 });
  if (admittedIds.length === 0) return result;

  // All outbound + inbound adjacency of the admitted docs, unfiltered by
  // `fields`/`filter`/`degrees` (decision 7). Collect the neighbor ids so we
  // can apply scope-only visibility in one batch.
  const outRows = await internal.storage.links_adjacent_out(internal.repo.id, admittedIds);
  const inRows = await internal.storage.links_adjacent_in(internal.repo.id, admittedIds);
  const neighborIds = new Set<number>();
  for (const r of outRows) neighborIds.add(r.target_id);
  for (const r of inRows) neighborIds.add(r.source_id);
  const visible = await scopeVisible(internal, [...neighborIds]);

  // Distinct visible neighbor documents per admitted doc.
  const outSets = new Map<number, Set<number>>();
  const inSets = new Map<number, Set<number>>();
  for (const id of admittedIds) {
    outSets.set(id, new Set());
    inSets.set(id, new Set());
  }
  for (const r of outRows) {
    if (visible.has(r.target_id)) outSets.get(r.source_id)?.add(r.target_id);
  }
  for (const r of inRows) {
    if (visible.has(r.source_id)) inSets.get(r.target_id)?.add(r.source_id);
  }
  for (const id of admittedIds) {
    result.set(id, {
      links: outSets.get(id)?.size ?? 0,
      backlinks: inSets.get(id)?.size ?? 0,
    });
  }
  return result;
}

// -----------------------------------------------------------------------------
// Assembly (§4.8)
// -----------------------------------------------------------------------------

function assembleDocuments(
  internal: Internal,
  bfs: BfsState,
  degreeCounts: Map<number, DegreeCounts>,
): GraphDocument[] {
  const docs: GraphDocument[] = [];
  for (const [docId, { degrees, version }] of bfs.admitted) {
    const counts = degreeCounts.get(docId) ?? { links: 0, backlinks: 0 };
    const doc: GraphDocument = {
      $path: version.path,
      $degrees: degrees,
      $links: counts.links,
      $backlinks: counts.backlinks,
    };
    for (const key of internal.select) {
      const value = version.frontmatter[key];
      if (value !== undefined) doc[key] = value;
    }
    docs.push(doc);
  }
  docs.sort((a, b) => a.$degrees - b.$degrees || cmpPath(a.$path, b.$path));
  return docs;
}

// -----------------------------------------------------------------------------
// Ordering — stable, byte-for-byte deterministic (§2.2 "Ordering").
// -----------------------------------------------------------------------------

function cmpPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
