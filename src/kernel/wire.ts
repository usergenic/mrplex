/**
 * Kernel wire types — the shapes returned to surfaces (design §6.4).
 * Integer ids never appear here; version_ids are opaque strings.
 */

export type User = {
  user: string; // slug
};

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
  author: User;
  created_at: string; // ISO 8601 UTC
};

/**
 * Wire form of a scope entry (design §6.4). Uses repo SLUGS, not ids —
 * the internal StoredScope has repo ids; the kernel translates on return.
 */
export type Scope = {
  repos: "*" | string[];
  read?: string[];
  write?: string[];
};

/**
 * Wire form of a Token — design §6.4. Plaintext secret only appears in the
 * response to tokens.create; every other API returns metadata only.
 */
export type Token = {
  id: string; // opaque, `t<integer>`
  label: string | null;
  admin: boolean;
  scopes: Scope[];
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type PathWarning = {
  version_id: string;
  path: string;
  reason: string;
};
