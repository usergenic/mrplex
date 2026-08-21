/**
 * Route-aware REST policy classification for proxy mode — auth-shell plan §1
 * "Serve mode: fronting proxy", WS4.
 *
 * The fronting proxy is mrplex-aware (not a generic reverse proxy): it parses
 * the known REST routes to decide what an entitlement must permit. Crucially,
 * on the REST surface the URL path is *authoritative* for writes — a
 * `PUT /repos/notes/docs/drafts/x.md` names its target path directly, and a
 * MOVE carries source (URL) + destination (`Destination` header). So the proxy
 * can replay the guard's §8.2 rules (both-endpoints on move, sigil paths
 * skipped, write ≠ read) WITHOUT a kernel handle — unlike the opaque MCP tool
 * args, which is why MCP writes stay in embedded mode.
 *
 * This module is pure request classification — no I/O, no forwarding — so it is
 * unit-testable and the proxy transport composes it.
 */

/** What an incoming REST request requires of the caller's entitlement. */
export type RouteRequirement =
  | { kind: "read" }
  | { kind: "write"; repo: string; paths: string[] } // must satisfy write scope on every path
  | { kind: "destructive" }
  | { kind: "unknown" }; // route the proxy doesn't recognize — refuse rather than pass blind

/**
 * Classify a REST request into its policy requirement. `pathname` is the raw
 * URL path (no query); `destination` is the `Destination` header value, needed
 * for MOVE both-endpoints. Percent-encoded segments are decoded per-segment.
 */
export function classifyRestRequest(
  method: string,
  pathname: string,
  destination: string | undefined,
): RouteRequirement {
  const segments = splitPath(pathname);
  const m = method.toUpperCase();

  // Root liveness ping, /query.
  if (segments.length === 0) return { kind: "read" };
  if (segments[0] === "query") return { kind: "read" };

  if (segments[0] !== "repos") return { kind: "unknown" };

  // /repos  (GET list, POST create)
  if (segments.length === 1) {
    if (m === "GET") return { kind: "read" };
    if (m === "POST") return { kind: "destructive" }; // repos.create
    return { kind: "unknown" };
  }

  const repo = segments[1] as string;

  // /repos/{repo}  (GET, MOVE rename, DELETE)
  if (segments.length === 2) {
    if (m === "GET") return { kind: "read" };
    if (m === "MOVE" || m === "DELETE") return { kind: "destructive" }; // rename / delete
    return { kind: "unknown" };
  }

  // /repos/{repo}/config  and  /repos/{repo}/link-config  (PUT → set_*_config)
  if (segments.length === 3 && (segments[2] === "config" || segments[2] === "link-config")) {
    if (m === "PUT") return { kind: "destructive" };
    return { kind: "unknown" };
  }

  // /repos/{repo}/versions | history | diff  — all reads
  if (segments.length >= 3 && ["versions", "history", "diff"].includes(segments[2] as string)) {
    return { kind: "read" };
  }

  // /repos/{repo}/docs/{...path}
  if (segments.length >= 4 && segments[2] === "docs") {
    const path = segments.slice(3).join("/");
    if (m === "GET") return { kind: "read" };
    if (m === "PUT") return { kind: "write", repo, paths: [path] }; // create or update
    if (m === "DELETE") return { kind: "write", repo, paths: [path] };
    if (m === "MOVE") {
      // Both endpoints: source (URL path) + destination. A cross-repo or
      // malformed destination is caught downstream by the engine; for policy
      // we require write on both the source and whatever dest we can parse.
      const destPath = parseDocDestinationPath(destination, repo);
      const paths = destPath === null ? [path] : [path, destPath];
      return { kind: "write", repo, paths };
    }
    return { kind: "unknown" };
  }

  return { kind: "unknown" };
}

function splitPath(pathname: string): string[] {
  const raw = pathname.replace(/^\//, "").replace(/\/$/, "");
  if (raw === "") return [];
  return raw.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/**
 * Extract the destination document path from a `Destination` header of the form
 * `/repos/{repo}/docs/{...path}` (mirrors the REST surface's own parser). Returns
 * null when absent/unparseable; the engine remains the authority on validity.
 */
function parseDocDestinationPath(headerValue: string | undefined, repo: string): string | null {
  if (headerValue === undefined) return null;
  let pathname: string;
  try {
    pathname = new URL(headerValue, "http://x").pathname;
  } catch {
    // Not an absolute URL — treat as a bare path.
    pathname = headerValue;
  }
  const decoded = splitPath(pathname);
  if (decoded.length < 4) return null;
  if (decoded[0] !== "repos" || decoded[2] !== "docs") return null;
  if (decoded[1] !== repo) return null; // cross-repo move — engine rejects; policy ignores dest
  return decoded.slice(3).join("/");
}
