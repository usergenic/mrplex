/**
 * Gitignore-style glob matching (design §8.2).
 *
 * Semantics:
 *   `**`      matches any sequence of characters (including `/`) — any subtree
 *   `*`       matches within a path segment (no `/`)
 *   `?`       matches a single character (no `/`)
 *   `!glob`   negates — handled at the LIST level, not the individual glob
 *   literals  everything else, including `.`, is a literal char
 *
 * Kept small on purpose: no `[abc]` character classes (not in the design),
 * no advanced features. Verifiable against the design's examples end-to-end.
 */

/**
 * Compile a single glob (WITHOUT leading `!`) to an anchored RegExp.
 * Callers strip `!` before calling and track the negation flag themselves.
 */
export function compileGlob(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    // Escape regex special chars — critically `.`, which we want to be a
    // literal dot in path globs, not "any char".
    if ("[](){}+^$.|\\".includes(ch)) {
      source += `\\${ch}`;
      continue;
    }
    source += ch;
  }
  return new RegExp(`^${source}$`);
}

/**
 * Does `path` match any of `globs`, honoring gitignore's "last-match-wins"
 * negation semantics? Returns true iff the last matching pattern is a
 * positive one; false if no pattern matches or the last match was negated.
 *
 * An empty `globs` array yields false (no capability).
 */
export function pathMatchesGlobs(globs: readonly string[], path: string): boolean {
  let allowed = false;
  for (const g of globs) {
    const negated = g.startsWith("!");
    const pat = negated ? g.slice(1) : g;
    if (compileGlob(pat).test(path)) {
      allowed = !negated;
    }
  }
  return allowed;
}

/**
 * Repo-slug pattern matching (§8.2 — "Since slugs contain no `/`, `*` is the
 * canonical wildcard at the repo level"). Uses the same compileGlob so the
 * `*`/`?` semantics stay consistent, but slug patterns don't need `**` or
 * negation.
 */
export function slugMatchesPattern(pattern: string, slug: string): boolean {
  return compileGlob(pattern).test(slug);
}
