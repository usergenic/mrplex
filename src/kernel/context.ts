/**
 * CallContext — the uniform first parameter to every kernel op (design §8,
 * noauth plan §1).
 *
 * mrplex is a full-trust kernel: any caller that can reach it can do anything.
 * There is no resolved identity, no token, no admin bit. What a caller supplies
 * per call is:
 *
 *   • `author` — an opaque string stamped on the versions it writes. The engine
 *     attaches no semantics (the `Full Name <email>` convention is caller-side).
 *     Defaults to "mrplex". Sanity-validated only (non-empty, no control chars,
 *     length-capped) — never parsed.
 *   • `scope` — optional read-visibility narrowing. Absent = everything visible.
 *     Present = the call sees only what the claims grant (silent filtering on
 *     `query`; `forbidden` on a targeted read outside the claim). This is the
 *     one enforcement seam a fronting shell cannot replicate from outside, so
 *     it stays in the engine — exposed as a plain input, not derived from a
 *     token.
 */

/**
 * A read-visibility claim. `repo` is a slug, glob, or "*" — evaluated against
 * the repos existing at call time, every call (no issuance snapshot, no id
 * binding). `read` is a gitignore-style path glob list (§8.2 semantics).
 */
export type ScopeClaim = {
  repo: string | string[];
  read?: string | string[];
};

export type CallContext = {
  /** Writes: opaque author string. Default "mrplex". */
  author?: string;
  /** Reads: visibility claims. Absent = everything visible. */
  scope?: ScopeClaim[];
};

/** Identity stamped on a write when the caller supplies no author. */
export const DEFAULT_AUTHOR = "mrplex";

const MAX_AUTHOR_LENGTH = 512;

/** True if `s` contains any C0/C1 control character (incl. tab/newline). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Parse a JSON string into `ScopeClaim[]`, with structural sanity checks.
 * Used by surfaces to decode the `X-Mrplex-Scope` header / `--scope` flag /
 * `scope` body field. Throws on malformed input so a bad claim is a loud
 * client error, not a silent full-access fallback.
 */
export function parseScopeClaims(json: string): ScopeClaim[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("scope must be valid JSON (a ScopeClaim array)");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("scope must be a JSON array of claims");
  }
  const isStrOrStrList = (v: unknown): boolean =>
    typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("scope claim must be an object");
    }
    const e = entry as { repo?: unknown; read?: unknown };
    if (!isStrOrStrList(e.repo)) {
      throw new Error("scope claim `repo` must be a string or string[]");
    }
    if (e.read !== undefined && !isStrOrStrList(e.read)) {
      throw new Error("scope claim `read` must be a string or string[]");
    }
  }
  return parsed as ScopeClaim[];
}

/**
 * Resolve + validate the author for a write. Opaque: we sanity-check only
 * (non-empty, no control characters, length-capped) and never parse the value.
 * An empty/absent author yields the default "mrplex".
 */
export function resolveAuthor(ctx: CallContext): string {
  const raw = ctx.author;
  if (raw === undefined || raw === "") return DEFAULT_AUTHOR;
  if (typeof raw !== "string") {
    throw new Error("author must be a string");
  }
  if (raw.length > MAX_AUTHOR_LENGTH) {
    throw new Error(`author exceeds ${MAX_AUTHOR_LENGTH} characters`);
  }
  if (hasControlChar(raw)) {
    throw new Error("author must not contain control characters");
  }
  return raw;
}
