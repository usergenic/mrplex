/**
 * Content negotiation — design §6.3.
 *
 * Document GET honors `Accept`:
 *   • application/json (or absent) → Version envelope
 *   • text/markdown                → raw byte-exact document (frontmatter.join)
 *
 * Document PUT honors `Content-Type`:
 *   • application/json (or absent) → { frontmatter | frontmatter_raw, body }
 *   • text/markdown                → raw file; server splits on `---` per §3.2
 *
 * The exactly-one frontmatter rule stays kernel-side; this module just
 * shapes the payload before delegation.
 */

import { join as joinFrontmatter, split as splitFrontmatter } from "../markdown/frontmatter.js";

export type Accept = "json" | "markdown";

/**
 * Choose the effective Accept for a document read. Extremely small parser
 * — no q-values, no wildcards beyond the catch-all. If the header names a
 * markdown media type at all, we serve markdown; otherwise JSON.
 */
export function chooseDocReadAccept(headerValue: string | undefined): Accept {
  if (!headerValue) return "json";
  const v = headerValue.toLowerCase();
  // application/json wins if explicitly requested (and it's the default).
  if (v.includes("application/json")) return "json";
  if (v.includes("text/markdown") || v.includes("text/*")) return "markdown";
  return "json";
}

export type ContentType = "json" | "markdown";

export function chooseDocWriteContentType(headerValue: string | undefined): ContentType {
  if (!headerValue) return "json";
  const v = headerValue.toLowerCase();
  if (v.startsWith("text/markdown")) return "markdown";
  if (v.startsWith("application/json")) return "json";
  // Unknown → JSON. The kernel will still validate the body shape.
  return "json";
}

/**
 * Turn the parsed `{ frontmatter_raw, body }` view into the exact bytes
 * `Accept: text/markdown` returns — round-trip byte-exact per §3.2.
 */
export function renderMarkdown(frontmatterRaw: string, body: string): string {
  return joinFrontmatter({ frontmatter_raw: frontmatterRaw, body });
}

/** Inverse — used when a PUT arrives with `Content-Type: text/markdown`. */
export function parseMarkdown(raw: string): { frontmatter_raw: string; body: string } {
  return splitFrontmatter(raw);
}
