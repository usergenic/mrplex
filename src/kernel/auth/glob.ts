/**
 * Gitignore-style glob matching (design §8.2).
 *
 * Semantics — faithful to git's gitignore(5):
 *   `**`         matches any sequence of characters (including `/`)
 *   `**\/`       zero or more path segments (including none)
 *   `/**` (end)  everything strictly inside the preceding directory
 *   `*`          matches within a path segment (no `/`)
 *   `?`          matches a single character (no `/`)
 *   leading `/`  anchors the pattern to the root; the `/` is not part
 *                of the matched string
 *   no `/` in    pattern is a basename — matches at any depth
 *     pattern
 *   `!glob`      negates — handled at the LIST level, not the individual glob
 *   literals     everything else, including `.`, is a literal char
 *
 * Kept small on purpose: no `[abc]` character classes.
 */

/**
 * Compile a single glob (WITHOUT leading `!`) to a regex source string.
 * Returns the raw pattern (no leading/trailing anchor); wrap in `^...$`
 * for full-string matching. Kept separate from compileGlob so callers
 * that need the source (e.g. to hand to a SQL regexp() UDF) don't have
 * to re-derive it from RegExp.source.
 */
export function globToRegexSource(glob: string): string {
  const hasLeadingSlash = glob.startsWith("/");
  const rest = hasLeadingSlash ? glob.slice(1) : glob;
  const isBareBasename = !rest.includes("/");
  // Bare `**` already expands to `.*`, which subsumes `(?:.*/)?` — skip the
  // redundant prefix rather than emitting dead regex text.
  const anyDepthPrefix = isBareBasename && !hasLeadingSlash && rest !== "**" ? "(?:.*/)?" : "";

  let source = "";
  let i = 0;
  while (i < rest.length) {
    // `**/` — zero or more path segments (including none)
    if (rest.slice(i, i + 3) === "**/") {
      source += "(?:.*/)?";
      i += 3;
      continue;
    }
    // Trailing `/**` — everything strictly inside the preceding dir
    if (rest.slice(i, i + 3) === "/**" && i + 3 === rest.length) {
      source += "/.*";
      i += 3;
      continue;
    }
    // Bare `**` — any run of characters, including `/`
    if (rest[i] === "*" && rest[i + 1] === "*") {
      source += ".*";
      i += 2;
      continue;
    }
    // `*` — within a segment
    if (rest[i] === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    // `?` — single char, not `/`
    if (rest[i] === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    const ch = rest[i] as string;
    // Escape regex specials — critically `.`, which is a literal in globs.
    if ("[](){}+^$.|\\".includes(ch)) {
      source += `\\${ch}`;
      i += 1;
      continue;
    }
    source += ch;
    i += 1;
  }
  return anyDepthPrefix + source;
}

/**
 * Compile a single glob (WITHOUT leading `!`) to an anchored RegExp.
 * Callers strip `!` before calling and track the negation flag themselves.
 */
export function compileGlob(glob: string): RegExp {
  return new RegExp(`^${globToRegexSource(glob)}$`);
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
