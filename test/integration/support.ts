/**
 * Integration-session support. A "session" loads one fixture folder into a
 * fresh SQLite database and hands back a small query surface, so a test can
 * read like an interactive walk through a real repo (see *.itest.ts).
 *
 * Unlike the unit suite's programmatic fixtures, these sessions seed the
 * on-disk fixture corpus verbatim via seedRepo — the same path `npm run seed`
 * takes — so the tests double as living documentation of what the shipped
 * fixtures can do. Each session owns its own throwaway db; a session is the
 * unit of isolation, and its steps are intentionally ordered.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SeedRepoOptions, seedRepo } from "../../scripts/seed.js";
import type { CallContext } from "../../src/kernel/context.js";
import { type Kernel, createKernel } from "../../src/kernel/kernel.js";
import { sqliteAdapter } from "../../src/storage-sqlite/adapter.js";
import type { Storage } from "../../src/storage/types.js";

/** Link config the shipped starship fixture opts into (see fixtures/starship/readme.md). */
export const STARSHIP_LINK_CONFIG = {
  fields: ["reports_to", "commander", "crew", "author", "mission", "maintainer", "related"],
};

export type Session = {
  kernel: Kernel;
  storage: Storage;
  /** Full-access context — sessions read the whole graph without scope friction. */
  actor: CallContext;
  repo: string;
  /** Run a CEL filter; return matching paths, sorted. */
  query(filter: string): Promise<string[]>;
  /** Full-text search; return matching paths, sorted. */
  textSearch(text: string): Promise<string[]>;
  /** Close storage and remove the throwaway db. */
  cleanup(): Promise<void>;
};

/**
 * Open a fresh db, seed one fixture folder into `repoSlug`, and return a
 * ready-to-query session. Call `cleanup()` in an afterEach.
 */
export async function seededSession(
  repoSlug: string,
  opts: Partial<SeedRepoOptions> = {},
): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), `mrplex-${repoSlug}-`));
  const storage = await sqliteAdapter.open({ database: `sqlite:${join(dir, "session.db")}` });
  const kernel = createKernel(storage);

  await seedRepo(storage, {
    fixtureDir: opts.fixtureDir ?? repoSlug,
    repoSlug,
    linkConfig: opts.linkConfig,
    ...opts,
  });

  const actor: CallContext = {};

  return {
    kernel,
    storage,
    actor,
    repo: repoSlug,
    async query(filter) {
      const rows = await kernel.query(actor, { repo: repoSlug, filter, limit: 1000 });
      return rows.map((r) => r.path).sort();
    },
    async textSearch(text) {
      const rows = await kernel.query(actor, { repo: repoSlug, text, limit: 1000 });
      return rows.map((r) => r.path).sort();
    },
    async cleanup() {
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Convenience: a starship session with the fixture's link config applied. */
export function starshipSession(): Promise<Session> {
  return seededSession("starship", { linkConfig: STARSHIP_LINK_CONFIG });
}
