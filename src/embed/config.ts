/**
 * Embed hook configuration resolution — shared between `mrplex serve`
 * and the local `mrplex embed` commands (m4-plan WS3).
 *
 * Precedence per source kind: CLI flag → env var → CLI config file → unset.
 * Only one source kind may be configured at a time (`--embedder`, legacy
 * `--embed-url`, or legacy `--embed-cmd` / their env/config equivalents).
 */

import { loadConfig } from "../cli/config.js";
import { createCmdEmbedHook } from "./cmd-hook.js";
import type { EmbedHook } from "./hook.js";
import { createHttpEmbedHook } from "./http-hook.js";

export type EmbedFlagInputs = {
  /** Unified provider: subprocess command, or http(s):// URL. */
  embedder?: string;
  /** @deprecated Use `embedder` with an http(s):// URL. */
  embed_url?: string;
  /** @deprecated Use `embedder` with a command. */
  embed_cmd?: string;
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
  const cfg = loadConfig();

  const embedder = inputs.embedder ?? process.env.MRPLEX_EMBEDDER ?? cfg.embedder;
  const url = inputs.embed_url ?? process.env.MRPLEX_EMBED_URL ?? cfg.embed_url;
  const cmd = inputs.embed_cmd ?? process.env.MRPLEX_EMBED_CMD ?? cfg.embed_cmd;

  const sources: string[] = [];
  if (embedder) sources.push("--embedder");
  if (url) sources.push("--embed-url");
  if (cmd) sources.push("--embed-cmd");
  if (sources.length > 1) {
    throw new Error(
      `${sources.join(", ")} are mutually exclusive — use --embedder only (http(s):// URL or command)`,
    );
  }

  if (embedder) return parseEmbedderSpec(embedder);
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
  embedUrl: {
    flags: "--embed-url <url>",
    description: "(deprecated) use --embedder with an http(s):// URL",
  },
  embedCmd: {
    flags: "--embed-cmd <cmd>",
    description: "(deprecated) use --embedder with a command",
  },
} as const;

export type EmbedCliOpts = {
  embedder?: string;
  embedUrl?: string;
  embedCmd?: string;
};

export function embedFlagInputsFromCli(opts: EmbedCliOpts): EmbedFlagInputs {
  return {
    embedder: opts.embedder,
    embed_url: opts.embedUrl,
    embed_cmd: opts.embedCmd,
  };
}

import type { Command } from "commander";

export function addEmbedCliOptions(cmd: Command): Command {
  return cmd
    .option(EMBED_CLI_OPTIONS.embedder.flags, EMBED_CLI_OPTIONS.embedder.description)
    .option(EMBED_CLI_OPTIONS.embedUrl.flags, EMBED_CLI_OPTIONS.embedUrl.description)
    .option(EMBED_CLI_OPTIONS.embedCmd.flags, EMBED_CLI_OPTIONS.embedCmd.description);
}