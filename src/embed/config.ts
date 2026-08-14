/**
 * Embed hook configuration resolution — shared between `mrplex serve`
 * and the local `mrplex embed` commands (m4-plan WS3).
 *
 * Precedence: CLI flag → env var → CLI config file (JSON) → unset.
 * `--embed-url` and `--embed-cmd` are mutually exclusive (same rule
 * as --database / --server).
 */

import { type CliConfig, loadConfig } from "../cli/config.js";
import { createCmdEmbedHook } from "./cmd-hook.js";
import type { EmbedHook } from "./hook.js";
import { createHttpEmbedHook } from "./http-hook.js";

export type EmbedFlagInputs = {
  embed_url?: string;
  embed_cmd?: string;
};

export type EmbedConfig =
  | { kind: "http"; url: string }
  | { kind: "cmd"; command: string }
  | { kind: "none" };

export function resolveEmbedConfig(inputs: EmbedFlagInputs): EmbedConfig {
  const cfg: CliConfig & { embed_url?: string; embed_cmd?: string } =
    loadConfig() as CliConfig & { embed_url?: string; embed_cmd?: string };
  const url = inputs.embed_url ?? process.env.MRPLEX_EMBED_URL ?? cfg.embed_url;
  const cmd = inputs.embed_cmd ?? process.env.MRPLEX_EMBED_CMD ?? cfg.embed_cmd;
  if (url && cmd) {
    throw new Error("--embed-url and --embed-cmd are mutually exclusive; pick one");
  }
  if (url) return { kind: "http", url };
  if (cmd) return { kind: "cmd", command: cmd };
  return { kind: "none" };
}

export function describeEmbedConfig(c: EmbedConfig): string {
  switch (c.kind) {
    case "http":
      return `http ${c.url}`;
    case "cmd":
      return `cmd ${c.command}`;
    case "none":
      return "off";
  }
}

/**
 * Instantiate a hook from a resolved config. Returns null if the
 * config is `none` — callers decide whether that is fatal.
 */
export function createHookFromConfig(c: EmbedConfig): EmbedHook | null {
  switch (c.kind) {
    case "http":
      return createHttpEmbedHook({ url: c.url });
    case "cmd":
      // The command string is split on whitespace (shell-lite). If a
      // user needs quoted args they can point --embed-cmd at a wrapper
      // script — same rule production sidecar deployments already use.
      {
        const parts = c.command.split(/\s+/).filter((p) => p.length > 0);
        const [command, ...args] = parts;
        if (!command) throw new Error("--embed-cmd is empty");
        return createCmdEmbedHook({ command, args });
      }
    case "none":
      return null;
  }
}
