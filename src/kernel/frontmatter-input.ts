/**
 * Canonicalize the two frontmatter input forms into the pair stored on
 * `versions`. Design §3.2:
 *
 *   Writes supply exactly ONE of:
 *     • frontmatter_raw  — verbatim YAML source; parsed → JSON for the index
 *     • frontmatter      — structured JSON; serialized → canonical YAML
 *   The other is derived. Supplying both → `frontmatter_invalid`.
 *
 * On read, the raw form is what `Accept: text/markdown` returns — so a
 * write via `frontmatter_raw` round-trips byte-exact. A write via
 * `frontmatter` (structured) does NOT preserve comments/key order from any
 * prior version; the caller opted into that by choosing the structured form.
 */

import { stringify as stringifyYaml } from "yaml";
import { type FrontmatterJson, parse as parseFrontmatter } from "../markdown/frontmatter.js";
import { KernelError } from "./errors.js";

export type FrontmatterInput = {
  frontmatter?: FrontmatterJson;
  frontmatter_raw?: string;
};

export type CanonicalFrontmatter = {
  frontmatter: FrontmatterJson;
  frontmatter_raw: string;
};

/**
 * Take a write's frontmatter input and produce the canonical (raw, parsed)
 * pair. Enforces the §3.2 "exactly one" rule and surfaces YAML errors as
 * `frontmatter_invalid`.
 *
 * If neither is supplied, throws `frontmatter_invalid` (callers that want
 * "carry over from prev" should pass prev's frontmatter_raw explicitly).
 */
export function canonicalizeFrontmatter(input: FrontmatterInput): CanonicalFrontmatter {
  const hasRaw = input.frontmatter_raw !== undefined;
  const hasStruct = input.frontmatter !== undefined;

  if (hasRaw && hasStruct) {
    throw new KernelError("frontmatter_invalid", {
      reason: "supply exactly one of frontmatter | frontmatter_raw, not both",
    });
  }
  if (!hasRaw && !hasStruct) {
    throw new KernelError("frontmatter_invalid", {
      reason: "one of frontmatter | frontmatter_raw is required",
    });
  }

  if (hasRaw) {
    const raw = input.frontmatter_raw as string;
    try {
      const parsed = parseFrontmatter(raw);
      return { frontmatter: parsed, frontmatter_raw: raw };
    } catch (err) {
      throw new KernelError("frontmatter_invalid", {
        reason: (err as Error).message,
      });
    }
  }

  // Structured branch — serialize to canonical YAML.
  const structured = input.frontmatter as FrontmatterJson;
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) {
    throw new KernelError("frontmatter_invalid", {
      reason: "structured frontmatter must be a map",
    });
  }
  // Empty map → empty raw (round-trips as "no frontmatter block" via the
  // markdown/frontmatter.split rule).
  if (Object.keys(structured).length === 0) {
    return { frontmatter: structured, frontmatter_raw: "" };
  }
  const rawFromStructured = stringifyYaml(structured);
  return { frontmatter: structured, frontmatter_raw: rawFromStructured };
}
