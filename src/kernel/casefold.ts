/**
 * Case & Unicode folding for path/slug IDENTITY — design §3.5.1 amendment
 * (case-folding-plan.md WS1).
 *
 * `normalizeKey` computes the derived key that drives case-insensitive,
 * Unicode-normalized uniqueness and by-key lookups. Storage stays
 * case- and form-preserving (we store the author's exact bytes); this
 * key is an index artifact, never surfaced on the wire (§3.3-style
 * internal-only, decision 7).
 *
 * THE ONE AUTHORITY. Both storage adapters receive the pre-computed key
 * from the kernel — neither calls SQL `lower()`, `COLLATE NOCASE`, or
 * `citext`. That is deliberate: SQLite's `lower()` is ASCII-only without
 * ICU, while Postgres's is locale-aware, so a functional index would
 * silently diverge on non-ASCII input and break the §7.2 adapter-parity
 * guarantee. Folding in JS, here, keeps the two engines identical.
 *
 * Strength (decision 4): **NFC + locale-invariant lowercase.** This folds
 * all accented Latin/Greek/Cyrillic and the common case, and makes NFC/NFD
 * spellings of the same text compare equal. It deliberately does NOT fold
 * the German ß→ss, ligatures (ﬁ→fi), or Greek final-sigma — those need the
 * full Unicode default case-fold table, an additive upgrade later (the key
 * is recomputed by a backfill, so strengthening it is non-breaking beyond a
 * re-index). casefold.test.ts pins the exact boundary.
 *
 * `toLowerCase()` (NOT `toLocaleLowerCase()`) is used on purpose: a locale
 * fold would map Turkish `I`→`ı`, making document identity depend on the
 * server's locale. Identity must be locale-independent.
 */

/**
 * Fold a path or slug to its identity key. Idempotent, total, pure.
 *
 *   normalizeKey("Alice.md")        === "alice.md"
 *   normalizeKey("café.md" as NFD)  === normalizeKey("café.md" as NFC)
 *   normalizeKey(normalizeKey(x))   === normalizeKey(x)
 */
export function normalizeKey(s: string): string {
  // Fold case, then re-normalize: `toLowerCase()` can, for a few code
  // points, emit a sequence that isn't NFC, which would break the
  // idempotency contract (normalizeKey∘normalizeKey === normalizeKey).
  // The trailing NFC pass makes the output a stable fixed point.
  return s.normalize("NFC").toLowerCase().normalize("NFC");
}
