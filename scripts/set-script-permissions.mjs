/**
 * Post-build permissions step. `tsc` rewrites dist/cli/main.js on every build
 * and drops its executable bit, which breaks a `npm link`ed `mrplex` (the bin
 * shim execs the file directly, relying on the shebang + exec bit). Restore it
 * here.
 *
 * `chmodSync` is cross-platform: on Windows Node only honors the read-only bit
 * and treats the exec bits as a no-op, so this is safe there (unlike a shell
 * `chmod +x`, which doesn't exist on Windows and would fail the build).
 *
 * Kept as a tiny .mjs script (no build-time deps) so the build works from a
 * clean `npm ci` install.
 */

import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

/** Files that must be executable after a build. */
const EXECUTABLES = ["dist/cli/main.js"];

for (const rel of EXECUTABLES) {
  const path = join(REPO_ROOT, rel);
  chmodSync(path, 0o755);
  console.log(`set-script-permissions: chmod 0755 ${rel}`);
}
