/**
 * The gap-aware forward walk — the brain of the change feed (sync/history
 * plan §3.2). Pure logic shared by both storage adapters so SQLite and
 * Postgres compute an identical safe frontier.
 *
 * `versions.id` is an exact cursor iff writes are serialized. Always true on
 * SQLite (single writer). On Postgres, concurrent writers create
 * commit-visibility skew and `nextval` burns ids on rollback, so gaps are
 * routine — each is either *pending* (in-flight, will appear) or *burned*
 * (never will), indistinguishable except by age.
 *
 * The feed therefore returns the longest safe contiguous run after the cursor,
 * not "everything since." Gap rule, keyed on the **successor's** age: if id 100
 * is missing and its successor 101 has been visible longer than the window,
 * 100 is burned → cross it; if 101 is younger than the window, 100 may be a
 * sibling still committing → truncate the page before 101. The page ends at
 * the first hot gap, the scan boundary (treated as a safe tip), or the output
 * limit — whichever comes first.
 *
 * Gaps are only meaningful on the **global** id sequence: a repo filter
 * naturally skips ids taken by other repos, so the walk runs over global rows
 * (id + repo + age) and the repo filter is applied to the output only.
 */

/**
 * Upper bound on the lightweight global scan per poll. Large enough that a
 * repo-filtered `limit` page is almost always satisfied in one scan, bounded
 * so a cold `after_id=0` poll over a huge log stays cheap. Truncating the scan
 * never crosses a gap — it only under-delivers, and the next poll continues
 * from the returned cursor.
 */
export const GLOBAL_SCAN_CAP = 10000;

/** A lightweight row for the frontier walk — no body/frontmatter needed. */
export type FrontierRow = {
  id: number;
  repo_id: number;
  created_at_ms: number;
};

export type FrontierResult = {
  /**
   * Inclusive upper-bound id for the page: every id in `(after_id, upper_id]`
   * is settled and final. Also the resume cursor (`next_since`). Equals
   * `after_id` when nothing is safe to deliver yet, so a caught-up or
   * hot-gap-stalled poll simply doesn't advance.
   */
  upper_id: number;
};

/**
 * Walk `light` (global rows with id > after_id, ascending) and return the
 * inclusive `upper_id` through which the feed is gap-free. Rows matching
 * `repo_id` (or all rows when it is undefined) are counted toward `limit`; the
 * page caps at the id of the `limit`-th match when a further match exists
 * within the safe region, otherwise at the safe frontier so an empty tail is
 * skipped and the cursor keeps advancing.
 */
export function safeFrontier(
  light: readonly FrontierRow[],
  after_id: number,
  repo_id: number | undefined,
  limit: number,
  now_ms: number,
  window_ms: number,
): FrontierResult {
  let expected = after_id + 1;
  let frontier = after_id; // last globally-contiguous, settled id
  let cutoff = after_id; // id of the last matching row we admit
  let matched = 0;
  let capped = false;

  for (const r of light) {
    if (r.id > expected) {
      // A gap precedes r; r is the successor. Young successor → the missing
      // ids may still be committing → stop before r (hot gap). Old successor
      // → the gap is burned → cross it.
      if (now_ms - r.created_at_ms < window_ms) break;
    }
    const matches = repo_id === undefined || r.repo_id === repo_id;
    if (matches && matched === limit) {
      // A (limit+1)-th deliverable row sits within the safe region: cap the
      // page at the limit-th match so the client fetches the rest next poll.
      capped = true;
      break;
    }
    frontier = r.id;
    expected = r.id + 1;
    if (matches) {
      matched++;
      cutoff = r.id;
    }
  }

  return { upper_id: capped ? cutoff : frontier };
}
