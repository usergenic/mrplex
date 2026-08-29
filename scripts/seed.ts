/**
 * Seed a fresh mrplex database from ./fixtures. Uses adapter-level writes only
 * (design §M0 seed script — no kernel write surface exists yet), then runs the
 * links backfill so graph queries resolve against the seeded corpus.
 *
 * The per-repo `seedRepo` helper lives in src/seed/fixture-seed.ts and is also
 * used by integration tests and `npm run seed`.
 *
 * Usage:
 *   npm run seed -- --database ./demo.db
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSeedClock,
  seedRepo,
} from "../src/seed/fixture-seed.js";
import { normalizeDatabaseUrl, openStorage } from "../src/storage/registry.js";
import type { Storage } from "../src/storage/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures");

/** The fixture folders `main()` seeds, in order. */
const FIXTURE_REPOS: { fixtureDir: string; repoSlug: string }[] = [
  { fixtureDir: "notes", repoSlug: "notes" },
  { fixtureDir: "starship", repoSlug: "starship" },
];

export type { SeedRepoOptions, SeedRepoResult } from "../src/seed/fixture-seed.js";
export { seedRepo } from "../src/seed/fixture-seed.js";

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
    const clock = defaultSeedClock();
    for (const { fixtureDir, repoSlug } of FIXTURE_REPOS) {
      const r = await seedRepo(storage, {
        fixtureDir,
        repoSlug,
        clock,
        fixturesRoot: FIXTURES_ROOT,
      });
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
