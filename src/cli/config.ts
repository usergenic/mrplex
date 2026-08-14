/**
 * CLI config loading + saving — `~/.config/mrplex/config.json` (m1-plan §5
 * said toml; we ship JSON in M1 for zero deps, and the format is trivial
 * to migrate to toml later without breaking existing files).
 *
 * The config holds:
 *   • database  — the URL used when --database is absent
 *   • token     — the bearer token used when --token / MRPLEX_TOKEN absent
 *
 * File is chmod 600 on save (best-effort — Windows doesn't honor POSIX
 * modes; the file will simply be user-readable there).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CliConfig = {
  database?: string;
  token?: string;
};

export function configPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "mrplex", "config.json");
}

export function loadConfig(): CliConfig {
  const path = configPath();
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as CliConfig;
  } catch (err) {
    // File missing or malformed → empty config; the CLI treats this as normal.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {};
  }
}

export function saveConfig(next: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // POSIX mode unsupported on this platform — best-effort.
  }
}
