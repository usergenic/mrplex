/**
 * Post-build copy step. `tsc` does not copy non-TS assets, but the migration
 * loader reads .sql files relative to its own compiled location, so an
 * installed/compiled CLI would find zero migrations without this.
 *
 * Kept as a tiny .mjs script (no build-time deps) so the build works from a
 * clean `npm ci` install.
 */

import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

/** @type {{ from: string; to: string; extensions: string[]; recursive?: boolean }[]} */
const ASSETS = [
  {
    from: "src/storage-sqlite/migrations",
    to: "dist/storage-sqlite/migrations",
    extensions: [".sql"],
  },
  {
    from: "src/storage-postgres/migrations",
    to: "dist/storage-postgres/migrations",
    extensions: [".sql"],
  },
];

/**
 * @param {string} dir
 * @param {string[]} extensions
 * @param {string[]} out
 */
function walkMatchingFiles(dir, extensions, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const s = statSync(path);
    if (s.isDirectory()) {
      walkMatchingFiles(path, extensions, out);
      continue;
    }
    if (extensions.some((ext) => name.endsWith(ext))) out.push(path);
  }
  return out;
}

for (const asset of ASSETS) {
  const src = join(REPO_ROOT, asset.from);
  const dst = join(REPO_ROOT, asset.to);
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  if (asset.recursive) {
    for (const file of walkMatchingFiles(src, asset.extensions)) {
      const rel = relative(src, file);
      const target = join(dst, rel);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
      copied++;
    }
  } else {
    for (const name of readdirSync(src)) {
      if (!asset.extensions.some((ext) => name.endsWith(ext))) continue;
      const s = statSync(join(src, name));
      if (!s.isFile()) continue;
      cpSync(join(src, name), join(dst, name));
      copied++;
    }
  }
  console.log(
    `copy-assets: ${asset.from} → ${asset.to} (${copied} file${copied === 1 ? "" : "s"})`,
  );
}
