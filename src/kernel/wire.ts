/**
 * Kernel wire types — the shapes returned to surfaces (design §6.4).
 * Integer ids never appear here; version_ids are opaque strings.
 */

export type PathConfig = {
  disallowed_chars?: string[];
  system_sigils?: string[];
  hidden_sigils?: string[];
};

export type Repo = {
  repo: string; // slug
  path_config: PathConfig | null;
};

export type Version = {
  version_id: string;
  prev_version_id: string | null;
  next_version_id: string | null;
  repo: string; // slug
  path: string;
  frontmatter: Record<string, unknown>;
  frontmatter_raw: string;
  body: string;
  author: string; // opaque caller-supplied string (noauth plan §1)
  created_at: string; // ISO 8601 UTC
};

export type PathWarning = {
  version_id: string;
  path: string;
  reason: string;
};
