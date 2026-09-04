/**
 * Embed hook configuration resolution — shared between `mrplex serve`
 * and the local `mrplex embed` commands (m4-plan WS3).
 *
 * One unified provider knob, `--embedder`, resolved: CLI flag → `MRPLEX_EMBEDDER`
 * env var → CLI config file → unset. An `http(s)://` value selects the HTTP
 * hook; anything else is a subprocess command.
 */

import { loadConfig } from "../cli/config.js";
import { createCmdEmbedHook } from "./cmd-hook.js";
import type { EmbedHook } from "./hook.js";
import { createHttpEmbedHook } from "./http-hook.js";

export type EmbedFlagInputs = {
  /** Unified provider: subprocess command, or http(s):// URL. */
  embedder?: string;
};

export type EmbedConfig =
  | { kind: "http"; url: string }
  | { kind: "cmd"; command: string }
  | { kind: "none" };

/**
 * Parse a unified `--embedder` value. Only `http://` and `https://` select
 * the HTTP hook; everything else is a subprocess command string.
 */
export function parseEmbedderSpec(value: string): EmbedConfig {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("--embedder is empty");
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { kind: "http", url: trimmed };
  }
  return { kind: "cmd", command: trimmed };
}

export function resolveEmbedConfig(inputs: EmbedFlagInputs = {}): EmbedConfig {
  const embedder = inputs.embedder ?? process.env.MRPLEX_EMBEDDER ?? loadConfig().embedder;
  if (embedder) return parseEmbedderSpec(embedder);
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
    case "cmd": {
      // The command string is split on whitespace (shell-lite). If a
      // user needs quoted args they can point --embedder at a wrapper
      // script — same rule production sidecar deployments already use.
      const parts = c.command.split(/\s+/).filter((p) => p.length > 0);
      const [command, ...args] = parts;
      if (!command) throw new Error("--embedder command is empty");
      return createCmdEmbedHook({ command, args });
    }
    case "none":
      return null;
  }
}

/** Commander option bundle for commands that accept an embedding provider. */
export const EMBED_CLI_OPTIONS = {
  embedder: {
    flags: "--embedder <spec>",
    description: "embedding provider: command, or http(s):// URL",
  },
} as const;

export type EmbedCliOpts = {
  embedder?: string;
};

export function embedFlagInputsFromCli(opts: EmbedCliOpts): EmbedFlagInputs {
  return { embedder: opts.embedder };
}

import type { Command } from "commander";

export function addEmbedCliOptions(cmd: Command): Command {
  return cmd.option(EMBED_CLI_OPTIONS.embedder.flags, EMBED_CLI_OPTIONS.embedder.description);
}