/**
 * Load markdown fixture folders into a repo — shared by the dev seed script,
 * integration tests, and `npm run seed`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillRepoLinks } from "../links/backfill.js";
import {
  HARDCODED_DEFAULTS as LINK_DEFAULTS,
  type LinkConfigOverride,
  effectiveLinkConfig,
} from "../links/link-config.js";
import { parse as parseFrontmatter, split } from "../markdown/frontmatter.js";
import type { Storage } from "../storage/types.js";

export type SeedRepoOptions = {
  /** Fixture folder name under fixtures/ (e.g. "starship"). */
  fixtureDir: string;
  /** Repo slug to create and seed into. */
  repoSlug: string;
  /** Root directory containing fixture subfolders. Defaults via {@link defaultFixturesRoot}. */
  fixturesRoot?: string;
  /** Opaque author string stamped on seeded versions. Defaults to "alice". */
  author?: string;
  /** Per-repo link-config override; sets link_config before backfill. */
  linkConfig?: LinkConfigOverride | null;
  /** Deterministic clock — returns an ISO timestamp per call. */
  clock?: () => string;
};

export type SeedRepoResult = {
  repoId: number;
  documents: number;
  edges: number;
};

/** Resolve fixtures/ from source (src/seed) or compiled (dist/seed → dist/fixtures). */
export function defaultFixturesRoot(fromModuleUrl: string): string {
  const here = dirname(fileURLToPath(fromModuleUrl));
  const distFixtures = join(here, "..", "fixtures");
  if (existsSync(distFixtures)) return distFixtures;
  return join(here, "..", "..", "fixtures");
}

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walkMarkdown(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

export function defaultSeedClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 7, 13, 0, 0, n++)).toISOString();
}

/**
 * Seed one fixture folder into one repo, then backfill its link index.
 *
 * Adapter-level writes bypass the kernel's in-transaction link maintenance;
 * the closing backfill rebuilds the derived index.
 */
export async function seedRepo(storage: Storage, opts: SeedRepoOptions): Promise<SeedRepoResult> {
  const author = opts.author ?? "alice";
  const clock = opts.clock ?? defaultSeedClock();
  const fixturesRoot =
    opts.fixturesRoot ?? defaultFixturesRoot(import.meta.url);

  if (await storage.repos_by_slug(opts.repoSlug)) {
    throw new Error(`seed: repo "${opts.repoSlug}" already exists — refusing to seed over it.`);
  }

  const repo = await storage.repos_create({ slug: opts.repoSlug, created_at: clock() });

  if (opts.linkConfig != null) {
    await storage.repos_set_link_config(repo.id, JSON.stringify(opts.linkConfig));
  }

  const root = join(fixturesRoot, opts.fixtureDir);
  const files = walkMarkdown(root).sort();
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    const raw = readFileSync(file, "utf8");
    const { frontmatter_raw, body } = split(raw);
    const frontmatter = parseFrontmatter(frontmatter_raw);
    const doc = await storage.documents_create(repo.id);
    await storage.version_insert({
      document_id: doc.id,
      repo_id: repo.id,
      prev_id: null,
      path: rel,
      frontmatter_raw,
      frontmatter,
      body,
      author,
      created_at: clock(),
    });
  }

  const config = effectiveLinkConfig(LINK_DEFAULTS, opts.linkConfig ?? null);
  const { edges } = await backfillRepoLinks(storage, repo.id, config);

  return { repoId: repo.id, documents: files.length, edges };
}
