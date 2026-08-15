/**
 * Seed a fresh mrplex database from ./fixtures. Uses adapter-level writes only
 * (design §M0 seed script — no kernel write surface exists yet). Idempotent-ish:
 * refuses to run against a non-empty database to keep behavior predictable.
 *
 * Usage:
 *   npm run seed -- --database ./demo.db
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { split } from "../src/markdown/frontmatter.js";
import { parse as parseFrontmatter } from "../src/markdown/frontmatter.js";
import { normalizeDatabaseUrl, openStorage } from "../src/storage/registry.js";
import type { Storage } from "../src/storage/types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures");

function parseArgs(argv: string[]): { database: string } {
  const idx = argv.indexOf("--database");
  const value = idx !== -1 ? argv[idx + 1] : undefined;
  const database = value ?? process.env.MRPLEX_DATABASE ?? "sqlite:./mrplex.db";
  return { database: normalizeDatabaseUrl(database) };
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

async function assertSeedable(storage: Storage): Promise<void> {
  const users = (await storage.users_list()).filter((u) => u.slug !== "system");
  const repos = await storage.repos_list();
  if (users.length > 0 || repos.length > 0) {
    throw new Error("seed: database already has non-system users or any repos — refusing to run.");
  }
}

function isoAt(offsetSec: number): string {
  return new Date(Date.UTC(2026, 7, 13, 0, 0, offsetSec)).toISOString();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.error(`seed: opening ${args.database}`);
  const storage = await openStorage(args.database);
  try {
    await assertSeedable(storage);
    let clock = 0;

    const alice = await storage.users_create({ slug: "alice", created_at: isoAt(clock++) });
    const notes = await storage.repos_create({ slug: "notes", created_at: isoAt(clock++) });

    // Walk the notes fixture directory.
    const notesRoot = join(FIXTURES_ROOT, "notes");
    const files = walkMarkdown(notesRoot).sort();
    const paths = new Map<string, { docId: number; firstVersion: number }>();

    for (const file of files) {
      const rel = relative(notesRoot, file).split("\\").join("/");
      const raw = readFileSync(file, "utf8");
      const { frontmatter_raw, body } = split(raw);
      const frontmatter = parseFrontmatter(frontmatter_raw);
      const doc = await storage.documents_create(notes.id);
      const v = await storage.version_insert({
        document_id: doc.id,
        repo_id: notes.id,
        prev_id: null,
        path: rel,
        frontmatter_raw,
        frontmatter,
        body,
        author_id: alice.id,
        created_at: isoAt(clock++),
      });
      paths.set(rel, { docId: doc.id, firstVersion: v.id });
      console.error(`seed: wrote ${rel} @ v${v.id}`);
    }

    const welcome = paths.get("welcome.md");
    if (welcome) {
      const editedRaw = readFileSync(join(notesRoot, "welcome.md"), "utf8");
      const { frontmatter_raw, body } = split(editedRaw);
      const frontmatter = parseFrontmatter(frontmatter_raw);
      const v2 = await storage.version_insert({
        document_id: welcome.docId,
        repo_id: notes.id,
        prev_id: welcome.firstVersion,
        path: "welcome.md",
        frontmatter_raw,
        frontmatter,
        body: `${body}\n<!-- seeded revision two -->\n`,
        author_id: alice.id,
        created_at: isoAt(clock++),
      });
      console.error(`seed: wrote welcome.md @ v${v2.id} (second revision)`);
    }

    console.error(
      `seed: done — 1 user, 1 repo, ${files.length} documents, ${files.length + 1} versions.`,
    );
  } finally {
    await storage.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
