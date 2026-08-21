/**
 * Seed a fresh mrplex database from ./fixtures. Uses adapter-level writes only
 * (design §M0 seed script — no kernel write surface exists yet), then runs the
 * links backfill so graph queries resolve against the seeded corpus.
 *
 * The per-repo `seedRepo` helper is exported so the integration tests can load
 * exactly one fixture folder into one repo (a session reseeds only the repo it
 * exercises). The CLI `main()` seeds every fixture folder.
 *
 * Usage:
 *   npm run seed -- --database ./demo.db
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillRepoLinks } from "../src/links/backfill.js";
import {
  HARDCODED_DEFAULTS as LINK_DEFAULTS,
  type LinkConfigOverride,
  effectiveLinkConfig,
} from "../src/links/link-config.js";
import { parse as parseFrontmatter, split } from "../src/markdown/frontmatter.js";
import { normalizeDatabaseUrl, openStorage } from "../src/storage/registry.js";
import type { Storage } from "../src/storage/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures");

/** Frontmatter fields the starship fixture opts into the link graph. */
const STARSHIP_LINK_CONFIG: LinkConfigOverride = {
  fields: ["reports_to", "commander", "crew", "author", "mission", "maintainer", "related"],
};

/** The fixture folders `main()` seeds, in order, with their repo config. */
const FIXTURE_REPOS: { fixtureDir: string; repoSlug: string; linkConfig?: LinkConfigOverride }[] = [
  { fixtureDir: "notes", repoSlug: "notes" },
  { fixtureDir: "starship", repoSlug: "starship", linkConfig: STARSHIP_LINK_CONFIG },
];

export type SeedRepoOptions = {
  /** Fixture folder name under fixtures/ (e.g. "starship"). */
  fixtureDir: string;
  /** Repo slug to create and seed into. */
  repoSlug: string;
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

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walkMarkdown(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function defaultClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 7, 13, 0, 0, n++)).toISOString();
}

/**
 * Seed one fixture folder into one repo, then backfill its link index.
 *
 * Adapter-level writes (version_insert) mirror the seed script's original
 * approach — fast and kernel-free. Because those writes bypass the kernel's
 * in-transaction link maintenance, the derived index starts empty; the closing
 * `backfillRepoLinks` rebuilds it under the repo's effective link config so
 * `$in` / `$has` / `$backlinks` / `$links` resolve. Refuses to seed a repo slug
 * that already exists, so re-running against a live db is a clear error rather
 * than silent duplication.
 */
export async function seedRepo(storage: Storage, opts: SeedRepoOptions): Promise<SeedRepoResult> {
  const author = opts.author ?? "alice";
  const clock = opts.clock ?? defaultClock();

  if (await storage.repos_by_slug(opts.repoSlug)) {
    throw new Error(`seed: repo "${opts.repoSlug}" already exists — refusing to seed over it.`);
  }

  const repo = await storage.repos_create({ slug: opts.repoSlug, created_at: clock() });

  if (opts.linkConfig != null) {
    await storage.repos_set_link_config(repo.id, JSON.stringify(opts.linkConfig));
  }

  const root = join(FIXTURES_ROOT, opts.fixtureDir);
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

function parseArgs(argv: string[]): { database: string } {
  const idx = argv.indexOf("--database");
  const value = idx !== -1 ? argv[idx + 1] : undefined;
  const database = value ?? process.env.MRPLEX_DATABASE ?? "sqlite:./mrplex.db";
  return { database: normalizeDatabaseUrl(database) };
}

async function assertSeedable(storage: Storage): Promise<void> {
  const repos = await storage.repos_list();
  if (repos.length > 0) {
    throw new Error("seed: database already has repos — refusing to run.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.error(`seed: opening ${args.database}`);
  const storage = await openStorage(args.database);
  try {
    await assertSeedable(storage);
    const clock = defaultClock();
    for (const { fixtureDir, repoSlug, linkConfig } of FIXTURE_REPOS) {
      const r = await seedRepo(storage, { fixtureDir, repoSlug, linkConfig, clock });
      console.error(`seed: ${repoSlug} — ${r.documents} documents, ${r.edges} link edges.`);
    }
    console.error("seed: done.");
  } finally {
    await storage.close();
  }
}

// Only run the CLI when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
