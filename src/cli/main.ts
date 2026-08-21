#!/usr/bin/env node
/**
 * mrplex CLI — reads + writes + config + serve + remote mode.
 *
 * The CLI is a thin client over the MCP surface (§7.3). When `--server` is
 * set, commands drive `tools/call` against `<server>/mcp`; otherwise the CLI
 * opens the local SQLite file and calls the kernel in-process. The
 * transport seam is `KernelClient` (`src/client/*`).
 *
 * No-auth (noauth plan): there is no bootstrap / tokens / users. Identity is
 * one opaque `author` string (--author → MRPLEX_AUTHOR → config → "mrplex");
 * `--scope <json>` narrows read visibility. In remote mode an optional --token
 * is forwarded verbatim as a bearer for a shell fronting the server; mrplex
 * itself ignores it. serve deliberately bypasses the seam — it IS the server.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import { parseDocument as parseYamlDocument } from "yaml";
import type { KernelClient } from "../client/kernel-client.js";
import { openLocalClient } from "../client/local.js";
import { openRemoteClient } from "../client/remote-mcp.js";
import { backfillRepo } from "../embed/backfill.js";
import { createHookFromConfig, resolveEmbedConfig } from "../embed/config.js";
import { createWorker } from "../embed/worker.js";
import { globToRegexSource } from "../kernel/auth/glob.js";
import { type CallContext, type ScopeClaim, parseScopeClaims } from "../kernel/context.js";
import { KernelError } from "../kernel/errors.js";
import { createKernel } from "../kernel/kernel.js";
import { extractSystemProperties, split as splitFrontmatter } from "../markdown/frontmatter.js";
import { startMcpStdio } from "../mcp/server.js";
import { startServer } from "../server/serve.js";
import { fileAuditSink } from "../shell/audit.js";
import { mintKey } from "../shell/keys.js";
import { type Entitlement, PolicyError, compile, loadPolicyFile } from "../shell/policy.js";
import { startProxyServer } from "../shell/proxy.js";
import { startShellServer } from "../shell/serve.js";
import { type StdioCredential, startShellStdio } from "../shell/stdio.js";
import { normalizeDatabaseUrl, openStorage } from "../storage/registry.js";
import { type CliConfig, loadConfig, saveConfig } from "./config.js";
import { exitCodeForKernelError } from "./exit-codes.js";
import {
  renderHistoryTable,
  renderQueryTable,
  renderReposTable,
  renderVersionAsMarkdown,
} from "./format.js";

// -----------------------------------------------------------------------------
// Utility parsers + helpers
// -----------------------------------------------------------------------------

// Emit `s` as a double-quoted CEL string literal. globToRegexSource output is
// a regex source, so the characters we can encounter that need escaping in a
// CEL "..." literal are `\` (regex escape marker) and `"` (literal terminator);
// glob syntax has no way to produce a raw newline. If globToRegexSource ever
// starts emitting new escapables, extend this set.
function celStringLiteral(s: string): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Compile a --path glob arg into a CEL $path.matches() expression and AND
// it with --filter (if any). Glob semantics match design §8.2.
function combinePathAndFilter(
  pathGlob: string | undefined,
  filter: string | undefined,
): string | undefined {
  if (!pathGlob) return filter;
  const rx = `^${globToRegexSource(pathGlob)}$`;
  const pathExpr = `$path.matches(${celStringLiteral(rx)})`;
  return filter ? `(${pathExpr}) && (${filter})` : pathExpr;
}

function parsePositiveInt(value: string, _prev: unknown): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return n;
}

/**
 * Parse a --scope value (JSON ScopeClaim[]) into claims. The whole flag is one
 * JSON array — the read-scope grammar is just the wire ScopeClaim shape.
 */
function parseScopeArg(value: string): ScopeClaim[] {
  try {
    return parseScopeClaims(value);
  } catch (err) {
    // parseScopeClaims throws KernelError("filter_invalid") with the human
    // reason in .data.reason (its .message is just the code).
    const reason =
      err instanceof KernelError
        ? String((err.data as { reason?: unknown }).reason)
        : err instanceof Error
          ? err.message
          : String(err);
    throw new InvalidArgumentError(`--scope must be a JSON ScopeClaim array: ${reason}`);
  }
}

type GlobalOpts = {
  database?: string;
  json?: boolean;
  token?: string;
  server?: string;
  repo?: string;
  author?: string;
  scope?: ScopeClaim[];
};

/**
 * Resolve the write author, git-style precedence: --author → MRPLEX_AUTHOR →
 * config `author` → engine default (undefined = kernel stamps "mrplex").
 */
function resolveAuthor(opts: GlobalOpts): string | undefined {
  const cfg = loadConfig();
  return opts.author ?? process.env.MRPLEX_AUTHOR ?? cfg.author;
}

/** Build the CallContext (author + scope) the client forwards on every call. */
function resolveContext(opts: GlobalOpts): CallContext {
  const ctx: CallContext = {};
  const author = resolveAuthor(opts);
  if (author !== undefined) ctx.author = author;
  if (opts.scope !== undefined) ctx.scope = opts.scope;
  return ctx;
}

function resolveDatabase(opts: GlobalOpts): string {
  const cfg = loadConfig();
  const value =
    opts.database ?? process.env.MRPLEX_DATABASE ?? cfg.database ?? "sqlite:./mrplex.db";
  return normalizeDatabaseUrl(value);
}

function resolveServer(opts: GlobalOpts): string | undefined {
  const cfg = loadConfig();
  const value = opts.server ?? process.env.MRPLEX_SERVER ?? cfg.server;
  return value;
}

/**
 * The policy|unsafe gate (auth-shell plan decision 11). A server-starting
 * command demands EXACTLY ONE of --policy or --unsafe. Throws a cli_usage
 * error otherwise so the CLI exits non-zero with a clear message — the raw
 * kernel is a choice you spell out, never a default you fall into.
 */
function assertServeGate(policy: string | undefined, unsafe: boolean): void {
  const hasPolicy = policy !== undefined;
  if (hasPolicy === unsafe) {
    const err = new Error(
      hasPolicy
        ? "--policy and --unsafe are mutually exclusive; pick one"
        : "refusing to start: pass --policy <file> (authenticated) or --unsafe (full-trust, no auth)",
    );
    (err as unknown as { code: string }).code = "cli_usage";
    throw err;
  }
}

/**
 * Resolve a stdio credential from the launcher flags: --principal (trust-by-
 * spawn) or --key / MRPLEX_SHELL_KEY (an API key). Exactly one must be present.
 */
function resolveStdioCredential(
  principal: string | undefined,
  key: string | undefined,
): StdioCredential {
  if (principal !== undefined && key !== undefined) {
    const err = new Error("--principal and --key are mutually exclusive");
    (err as unknown as { code: string }).code = "cli_conflict";
    throw err;
  }
  if (principal !== undefined) return { kind: "principal", id: principal };
  if (key !== undefined) return { kind: "key", key };
  const err = new Error("mcp-stdio --policy needs a credential: --principal <id> or --key <key>");
  (err as unknown as { code: string }).code = "cli_usage";
  throw err;
}

/** Wire SIGINT/SIGTERM to close a stdio mount + storage, then exit. */
function wireStdioShutdown(
  closeMount: () => Promise<void>,
  closeStorage: () => Promise<void>,
): void {
  const shutdown = async () => {
    await closeMount().catch(() => {});
    await closeStorage().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/**
 * Resolve the target repo slug for `docs *` commands — flag → env → config.
 * Throws a friendly cli-usage error if none is set; the CLI turns that into
 * a non-zero exit.
 */
function resolveRepoSlug(opts: GlobalOpts): string {
  const cfg = loadConfig();
  const value = opts.repo ?? process.env.MRPLEX_REPO ?? cfg.repo;
  if (!value) {
    const err = new Error(
      "no repo — set MRPLEX_REPO, use -r/--repo, or `mrplex config set-repo <slug>`",
    );
    (err as unknown as { code: string }).code = "cli_usage";
    throw err;
  }
  return value;
}

/**
 * Open the right KernelClient — remote if `--server` (or MRPLEX_SERVER / config
 * `server`) is set, otherwise the local in-process client. Enforces the
 * m3-plan decision that --database and --server are mutually exclusive.
 *
 * In local mode we also resolve an embed hook (from --embed-url/--embed-cmd
 * or env/config) — needed for CLI-local rank queries and for backlog
 * enqueue on writes done through the CLI.
 */
async function openClient(opts: GlobalOpts): Promise<KernelClient> {
  const server = resolveServer(opts);
  const hasExplicitDatabase =
    opts.database !== undefined || process.env.MRPLEX_DATABASE !== undefined;
  if (server && hasExplicitDatabase) {
    const err = new Error("--database and --server are mutually exclusive; pick one");
    (err as unknown as { code: string }).code = "cli_conflict";
    throw err;
  }
  const context = resolveContext(opts);
  if (server) {
    // --token is an optional bearer forwarded verbatim for a shell fronting the
    // remote server (noauth plan §1); mrplex itself ignores it.
    return openRemoteClient({
      server,
      context,
      token: resolveTokenString(opts.token) ?? undefined,
    });
  }
  const embedCfg = resolveEmbedConfig({});
  const embed = createHookFromConfig(embedCfg);
  return openLocalClient({ database: resolveDatabase(opts), context, embed });
}

/** Optional bearer for remote pass-through: --token → MRPLEX_TOKEN → config. */
function resolveTokenString(cliFlag: string | undefined): string | null {
  if (cliFlag) return cliFlag;
  if (process.env.MRPLEX_TOKEN) return process.env.MRPLEX_TOKEN;
  return loadConfig().token ?? null;
}

async function withClient<T>(
  cmd: Command,
  fn: (client: KernelClient, opts: GlobalOpts) => Promise<T>,
): Promise<T> {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  const client = await openClient(opts);
  try {
    return await fn(client, opts);
  } finally {
    await client.close();
  }
}

function emit(result: unknown, opts: GlobalOpts, prettyText: string): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const text = prettyText.endsWith("\n") ? prettyText : `${prettyText}\n`;
  process.stdout.write(text);
}

function reportError(err: unknown): never {
  if (err instanceof KernelError) {
    const payload = { code: err.code, data: err.data };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exit(exitCodeForKernelError(err.code));
  }
  const code = (err as { code?: string }).code;
  if (code === "unauthorized") {
    process.stderr.write(`${JSON.stringify({ code, data: {} })}\n`);
    process.exit(3);
  }
  if (code === "network") {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(10);
  }
  if (code === "cli_conflict" || code === "cli_usage") {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

/**
 * Append a minted key's hash under `principals.<id>.keys` in a policy file,
 * preserving comments and formatting via the yaml Document API (issuance is a
 * diff, auth-shell decision 3). Throws if the principal isn't present — mint
 * doesn't invent principals.
 */
function appendKeyToPolicy(policyPath: string, principalId: string, hash: string): void {
  const text = readFileSync(policyPath, "utf8");
  const doc = parseYamlDocument(text);
  const principals = doc.getIn(["principals"]);
  if (!principals || !doc.hasIn(["principals", principalId])) {
    const err = new Error(`policy: principal "${principalId}" not found in ${policyPath}`);
    (err as unknown as { code: string }).code = "cli_usage";
    throw err;
  }
  if (!doc.hasIn(["principals", principalId, "keys"])) {
    doc.setIn(["principals", principalId, "keys"], doc.createNode([hash]));
  } else {
    const keys = doc.getIn(["principals", principalId, "keys"]) as {
      add?: (v: unknown) => void;
    };
    if (typeof keys.add !== "function") {
      const err = new Error(`policy: principals.${principalId}.keys is not a list`);
      (err as unknown as { code: string }).code = "cli_usage";
      throw err;
    }
    keys.add(hash);
  }
  writeFileSync(policyPath, String(doc));
}

/** Human-readable dump of an effective entitlement — the operator's "why can't
 * X read Y" answer. */
function renderEntitlement(principalId: string, e: Entitlement): string {
  const claims = (list: Entitlement["read"]): string =>
    list.length === 0
      ? "    (none)\n"
      : list
          .map((c) => `    repo=${JSON.stringify(c.repo)} paths=${JSON.stringify(c.paths)}\n`)
          .join("");
  return (
    `principal: ${principalId}\n` +
    `author:    ${e.author}\n` +
    `destructive: ${e.destructive}   impersonate: ${e.impersonate}\n` +
    `read:\n${claims(e.read)}` +
    `write:\n${claims(e.write)}`
  );
}

function readFromFile(pathOrDash: string): string {
  if (pathOrDash === "-") {
    return readFileSync(0, "utf8"); // fd 0 = stdin
  }
  return readFileSync(pathOrDash, "utf8");
}

function readDocumentInput(fromFile: string | undefined): {
  frontmatter_raw: string;
  body: string;
} {
  if (!fromFile) {
    return { frontmatter_raw: "", body: "" };
  }
  return splitFrontmatter(readFromFile(fromFile));
}

function emitVersionWrite(
  result: { version_id: string; repo: string; path: string; author: string },
  opts: GlobalOpts,
): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.version_id}\n`);
  process.stderr.write(
    `wrote ${result.repo}/${result.path} @ ${result.version_id} (author: ${result.author})\n`,
  );
}

// -----------------------------------------------------------------------------
// Program construction
// -----------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command()
    .name("mrplex")
    .description("Markdown Repos, plexed — CLI (M3)")
    .version("0.0.0")
    .addOption(
      new Option("--database <url>", "sqlite:./path.db or postgres://…").env("MRPLEX_DATABASE"),
    )
    .addOption(
      new Option(
        "--token <token>",
        "optional bearer forwarded verbatim in remote mode (mrplex ignores it; for a fronting shell)",
      ).env("MRPLEX_TOKEN"),
    )
    .addOption(
      new Option("--server <url>", "talk to a remote mrplex server (mutex with --database)").env(
        "MRPLEX_SERVER",
      ),
    )
    .addOption(
      new Option("-r, --repo <slug>", "target repo for `docs *` commands").env("MRPLEX_REPO"),
    )
    .addOption(
      new Option("--author <s>", "opaque author string stamped on writes").env("MRPLEX_AUTHOR"),
    )
    .option(
      "--scope <json>",
      "read-visibility claims as a JSON ScopeClaim array (narrows what reads see)",
      parseScopeArg,
    )
    .option("--json", "emit raw JSON instead of pretty output", false)
    .exitOverride((err) => {
      if (err.exitCode === 0) process.exit(0);
      process.exit(err.exitCode || 1);
    });

  // -------- serve --------
  // The policy|unsafe gate (auth-shell plan decision 11): a command that starts
  // a server over a local database must spell out exactly one of --policy (run
  // the authenticating shell) or --unsafe (raw full-trust kernel). Neither →
  // refuse; both → refuse. Full trust is never the result of a forgotten flag.
  program
    .command("serve")
    .description("start HTTP surfaces (REST + MCP Streamable HTTP) — §7.3")
    .option("--policy <file>", "YAML policy file — run the authenticating shell (auth-shell plan)")
    .option("--unsafe", "serve the raw full-trust kernel with NO auth (say what it is)", false)
    .option("--audit <file>", "append a JSONL audit line per authenticated call (--policy only)")
    .option("--port <n>", "TCP port (default 8321)", parsePositiveInt)
    .option("--host <h>", "bind host (default 127.0.0.1)")
    .option("--mcp-stdio", "also expose MCP over STDIO for the launch token (--unsafe only)", false)
    .option("--embed-url <url>", "HTTP embedding endpoint (§5.3)")
    .option("--embed-cmd <cmd>", "subprocess embedding command (JSON-lines over stdio)")
    .action(function (this: Command) {
      const gopts = this.optsWithGlobals<GlobalOpts>();
      const localOpts = this.opts<{
        policy?: string;
        unsafe: boolean;
        audit?: string;
        port?: number;
        host?: string;
        mcpStdio: boolean;
        embedUrl?: string;
        embedCmd?: string;
      }>();
      (async () => {
        try {
          assertServeGate(localOpts.policy, localOpts.unsafe);
          const database = resolveDatabase(gopts);
          const embedCfg = resolveEmbedConfig({
            embed_url: localOpts.embedUrl,
            embed_cmd: localOpts.embedCmd,
          });

          // Authenticated shell mode.
          if (localOpts.policy !== undefined) {
            if (localOpts.mcpStdio) {
              const err = new Error(
                "--mcp-stdio is unsafe-mode only; use `mrplex mcp-stdio` instead",
              );
              (err as unknown as { code: string }).code = "cli_conflict";
              throw err;
            }
            const shellHandle = await startShellServer({
              database,
              policyPath: localOpts.policy,
              host: localOpts.host,
              port: localOpts.port,
              embed: embedCfg,
              auditPath: localOpts.audit,
              auditSinkFor: localOpts.audit
                ? (principal) => fileAuditSink(localOpts.audit as string, principal)
                : undefined,
            });
            process.on("SIGHUP", () => shellHandle.reloadPolicy());
            const shutdown = async () => {
              await shellHandle.close();
              process.exit(0);
            };
            process.on("SIGINT", () => void shutdown());
            process.on("SIGTERM", () => void shutdown());
            return;
          }

          // Unsafe raw-kernel mode.
          if (localOpts.audit !== undefined) {
            const err = new Error("--audit requires --policy (nothing to attribute without auth)");
            (err as unknown as { code: string }).code = "cli_conflict";
            throw err;
          }
          const handle = await startServer({
            database,
            host: localOpts.host,
            port: localOpts.port,
            embed: embedCfg,
          });

          // Optional STDIO — the launch process IS the shell (noauth plan §2),
          // so --author / --scope pin the session's CallContext.
          if (localOpts.mcpStdio) {
            try {
              await startMcpStdio({
                kernel: handle.kernel,
                context: resolveContext(gopts),
              });
            } catch (err) {
              process.stderr.write(`mrplex: --mcp-stdio failed: ${(err as Error).message}\n`);
              await handle.close();
              process.exit(3);
            }
          }

          const shutdown = async () => {
            await handle.close();
            process.exit(0);
          };
          process.on("SIGINT", () => void shutdown());
          process.on("SIGTERM", () => void shutdown());
        } catch (err) {
          reportError(err);
        }
      })();
    });

  // -------- mcp-stdio --------
  // Guarded stdio MCP over a local database (auth-shell plan §1 launcher mode).
  // Under the same policy|unsafe gate as serve: a server over a local database
  // spells out its trust posture. The credential arrives via --principal or
  // MRPLEX_SHELL_KEY / --key (the OAuth token front lands with WS5).
  program
    .command("mcp-stdio")
    .description("run an MCP session over STDIO against a local database")
    .option("--policy <file>", "YAML policy file — resolve a guarded principal")
    .option("--unsafe", "raw full-trust kernel over stdio, NO auth", false)
    .option("--principal <id>", "trust-by-spawn: run as this policy principal (no credential)")
    .addOption(new Option("--key <key>", "API key to resolve a principal").env("MRPLEX_SHELL_KEY"))
    .option("--audit <file>", "append a JSONL audit line per call (--policy only)")
    .action(function (this: Command) {
      const gopts = this.optsWithGlobals<GlobalOpts>();
      const localOpts = this.opts<{
        policy?: string;
        unsafe: boolean;
        principal?: string;
        key?: string;
        audit?: string;
      }>();
      (async () => {
        try {
          assertServeGate(localOpts.policy, localOpts.unsafe);
          const database = resolveDatabase(gopts);
          const storage = await openStorage(database);

          if (localOpts.policy === undefined) {
            // Unsafe: raw kernel, launch-time --author/--scope pin the context.
            const kernel = createKernel(storage);
            const mount = await startMcpStdio({ kernel, context: resolveContext(gopts) });
            wireStdioShutdown(mount.close, storage.close.bind(storage));
            return;
          }

          const policy = loadPolicyFile(localOpts.policy);
          const kernel = createKernel(storage);
          const credential = resolveStdioCredential(localOpts.principal, localOpts.key);
          const mount = await startShellStdio({
            kernel,
            policy,
            credential,
            auditSinkFor: localOpts.audit
              ? (principal) => fileAuditSink(localOpts.audit as string, principal)
              : undefined,
          });
          wireStdioShutdown(mount.close, storage.close.bind(storage));
        } catch (err) {
          reportError(err);
        }
      })();
    });

  // -------- proxy --------
  // Fronting proxy: authenticate + enforce REST route policy, strip inbound
  // X-Mrplex-* and inject the entitlement's, forward to a raw engine upstream.
  // --policy is always required (an unsafe proxy is meaningless).
  program
    .command("proxy")
    .description("authenticating reverse proxy in front of a raw engine upstream")
    .requiredOption("--policy <file>", "YAML policy file")
    .requiredOption("--upstream <target>", "unix:<socket-path> or http://<loopback:port>")
    .option("--port <n>", "TCP port (default 8321)", parsePositiveInt)
    .option("--host <h>", "bind host (default 127.0.0.1)")
    .action(function (this: Command) {
      const localOpts = this.opts<{
        policy: string;
        upstream: string;
        port?: number;
        host?: string;
      }>();
      (async () => {
        try {
          const handle = await startProxyServer({
            policyPath: localOpts.policy,
            upstream: localOpts.upstream,
            host: localOpts.host,
            port: localOpts.port,
          });
          process.on("SIGHUP", () => handle.reloadPolicy());
          const shutdown = async () => {
            await handle.close();
            process.exit(0);
          };
          process.on("SIGINT", () => void shutdown());
          process.on("SIGTERM", () => void shutdown());
        } catch (err) {
          reportError(err);
        }
      })();
    });

  // -------- config --------
  const cfg = program.command("config").description("local CLI config");
  cfg
    .command("set-database <url>")
    .description("write the default --database URL to the CLI config")
    .action((url: string) => {
      const c: CliConfig = { ...loadConfig(), database: url };
      saveConfig(c);
      process.stderr.write("config: database set\n");
    });
  cfg
    .command("set-token <token>")
    .description("write the default --token to the CLI config (mode 600)")
    .action((token: string) => {
      const c: CliConfig = { ...loadConfig(), token };
      saveConfig(c);
      process.stderr.write("config: token set (chmod 600)\n");
    });
  cfg
    .command("set-server <url>")
    .description("write the default --server URL to the CLI config")
    .action((url: string) => {
      const c: CliConfig = { ...loadConfig(), server: url };
      saveConfig(c);
      process.stderr.write("config: server set\n");
    });
  cfg
    .command("set-repo <slug>")
    .description("write the default -r/--repo slug to the CLI config")
    .action((slug: string) => {
      const c: CliConfig = { ...loadConfig(), repo: slug };
      saveConfig(c);
      process.stderr.write("config: repo set\n");
    });
  cfg
    .command("set-author <author>")
    .description('write the default --author to the CLI config (e.g. "Full Name <email@addr>")')
    .action((author: string) => {
      const c: CliConfig = { ...loadConfig(), author };
      saveConfig(c);
      process.stderr.write("config: author set\n");
    });
  cfg
    .command("show")
    .description("print the current CLI config")
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<GlobalOpts>();
      const c = loadConfig();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(c, null, 2)}\n`);
      } else {
        process.stdout.write(
          `database: ${c.database ?? "(unset)"}\nserver:   ${c.server ?? "(unset)"}\nrepo:     ${c.repo ?? "(unset)"}\nauthor:   ${c.author ?? "(unset)"}\ntoken:    ${c.token ? "(set)" : "(unset)"}\n`,
        );
      }
    });

  // -------- key (policy tooling) --------
  // `key mint` and `policy check` read/edit the policy file by definition, so
  // they take --policy directly and never touch the serve gate (auth-shell §1
  // "Policy tooling").
  const key = program.command("key").description("API-key tooling for the auth shell");
  key
    .command("mint <principal>")
    .description("generate a new API key; print the plaintext ONCE and the sha256 hash to store")
    .option("--policy <file>", "append the hash under the principal's `keys:` in this policy file")
    .action(function (this: Command, principal: string) {
      const localOpts = this.opts<{ policy?: string }>();
      try {
        const { plaintext, hash } = mintKey();
        if (localOpts.policy !== undefined) {
          appendKeyToPolicy(localOpts.policy, principal, hash);
          process.stderr.write(`key: appended hash under principals.${principal}.keys\n`);
        } else {
          process.stderr.write(
            `key: add this line under principals.${principal}.keys in your policy file:\n  - ${hash}\n`,
          );
        }
        // The plaintext is shown ONCE, on stdout, so it can be piped/captured;
        // it is never stored — only the hash lives in the policy file.
        process.stdout.write(`${plaintext}\n`);
      } catch (err) {
        reportError(err);
      }
    });

  // -------- policy --------
  const policy = program.command("policy").description("policy-file tooling for the auth shell");
  policy
    .command("check [principal]")
    .description("validate a policy file; with a principal, print its effective entitlement")
    .requiredOption("--policy <file>", "policy file to load")
    .action(function (this: Command, principal: string | undefined) {
      const localOpts = this.opts<{ policy: string }>();
      const gopts = this.optsWithGlobals<GlobalOpts>();
      try {
        const loaded = loadPolicyFile(localOpts.policy);
        if (principal === undefined) {
          const nP = Object.keys(loaded.principals).length;
          const nR = Object.keys(loaded.roles).length;
          process.stderr.write(`policy OK: ${nR} role(s), ${nP} principal(s)\n`);
          return;
        }
        const entitlement = compile(loaded, principal);
        if (gopts.json) {
          process.stdout.write(`${JSON.stringify(entitlement, null, 2)}\n`);
        } else {
          process.stdout.write(renderEntitlement(principal, entitlement));
        }
      } catch (err) {
        if (err instanceof PolicyError) {
          process.stderr.write(`policy: ${err.message}\n`);
          process.exit(1);
        }
        reportError(err);
      }
    });

  // -------- repos --------
  const repos = program.command("repos").description("repo management");
  repos
    .command("list")
    .description("list repos")
    .option("--include-system", "include system-namespaced repos (§3.4)", false)
    .action(function (this: Command) {
      const localOpts = this.opts<{ includeSystem: boolean }>();
      withClient(this, async (client, opts) => {
        const result = await client.repos.list({ include_system: localOpts.includeSystem });
        emit(result, opts, renderReposTable(result));
      }).catch(reportError);
    });

  repos
    .command("get <slug>")
    .description("show a repo")
    .action(function (this: Command, slug: string) {
      withClient(this, async (client, opts) => {
        const result = await client.repos.get(slug);
        emit(
          result,
          opts,
          `${result.repo}  ${result.path_config ? "(custom path_config)" : "(default path_config)"}`,
        );
      }).catch(reportError);
    });

  repos
    .command("create <slug>")
    .description("create a new repo (admin)")
    .action(function (this: Command, slug: string) {
      withClient(this, async (client, opts) => {
        const result = await client.repos.create(slug);
        emit(result, opts, `created repo ${result.repo}`);
      }).catch(reportError);
    });

  repos
    .command("rename <slug> <new-slug>")
    .description("rename a repo (admin)")
    .action(function (this: Command, slug: string, newSlug: string) {
      withClient(this, async (client, opts) => {
        const result = await client.repos.rename(slug, newSlug);
        emit(result, opts, `renamed ${slug} → ${result.repo}`);
      }).catch(reportError);
    });

  repos
    .command("delete <slug>")
    .description("delete a repo — renames slug into the system namespace (admin)")
    .action(function (this: Command, slug: string) {
      withClient(this, async (client, opts) => {
        const result = await client.repos.delete(slug);
        emit(result, opts, `deleted (now ${result.repo})`);
      }).catch(reportError);
    });

  repos
    .command("set-path-config <slug>")
    .description("set the per-repo path config override (§3.5)")
    .option("--from-file <file>", "read JSON override from file (- for stdin)")
    .option("--clear", "clear the override — inherit from server config", false)
    .action(function (this: Command, slug: string) {
      const localOpts = this.opts<{ fromFile?: string; clear: boolean }>();
      withClient(this, async (client, opts) => {
        const config = localOpts.clear
          ? null
          : (JSON.parse(readFromFile(localOpts.fromFile ?? "-")) as never);
        const result = await client.repos.set_path_config(slug, config);
        emit(result, opts, `updated ${slug}\nwarnings: ${result.warnings.length}`);
      }).catch(reportError);
    });

  repos
    .command("set-link-config <slug>")
    .description("set the per-repo link-extraction config override (§11.2); re-extracts the repo")
    .option("--from-file <file>", "read JSON override from file (- for stdin)")
    .option("--clear", "clear the override — inherit from server config", false)
    .action(function (this: Command, slug: string) {
      const localOpts = this.opts<{ fromFile?: string; clear: boolean }>();
      withClient(this, async (client, opts) => {
        const config = localOpts.clear
          ? null
          : (JSON.parse(readFromFile(localOpts.fromFile ?? "-")) as never);
        const result = await client.repos.set_link_config(slug, config);
        emit(
          result,
          opts,
          `updated ${slug}\nreindexed ${result.reindexed.documents} doc(s), ${result.reindexed.edges} edge(s)`,
        );
      }).catch(reportError);
    });

  // -------- docs --------
  // The target repo is a global (-r/--repo, MRPLEX_REPO, or config `repo`);
  // `docs *` commands take only <path> because most sessions live inside one repo.
  // Each action resolves the repo BEFORE `withClient` opens a connection — in
  // remote mode that avoids a wasted network round-trip when the slug is unset.
  const docs = program.command("docs").description("document ops");
  docs
    .command("get <path>")
    .description("read the current version at <path>")
    .option(
      "--raw",
      "suppress server-injected $version (and other $* system properties) in the output",
      false,
    )
    .action(function (this: Command, path: string) {
      const localOpts = this.opts<{ raw?: boolean }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const result = await client.docs.get(repo, path, { raw: localOpts.raw === true });
        emit(result, opts, renderVersionAsMarkdown(result));
      }).catch(reportError);
    });

  docs
    .command("get-version <version-id>")
    .description("read a specific version by id")
    .option(
      "--raw",
      "suppress server-injected $version (and other $* system properties) in the output",
      false,
    )
    .action(function (this: Command, versionId: string) {
      const localOpts = this.opts<{ raw?: boolean }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const result = await client.docs.get_version(repo, versionId, {
          raw: localOpts.raw === true,
        });
        emit(result, opts, renderVersionAsMarkdown(result));
      }).catch(reportError);
    });

  docs
    .command("history <path>")
    .description("list versions of a document newest-first")
    .option("--limit <n>", "limit to N most-recent (positive integer)", parsePositiveInt)
    .option("--before <ts>", "only versions with created_at < <ts>")
    .action(function (this: Command, path: string) {
      const localOpts = this.opts<{ limit?: number; before?: string }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const result = await client.docs.history(repo, path, {
          limit: localOpts.limit,
          before: localOpts.before,
        });
        emit(result, opts, renderHistoryTable(result));
      }).catch(reportError);
    });

  docs
    .command("diff <path>")
    .description("unified diff between two versions of a document (§4.3)")
    .requiredOption("--from <version-id>", "source version id")
    .requiredOption("--to <version-id>", "target version id")
    .action(function (this: Command, path: string) {
      const localOpts = this.opts<{ from: string; to: string }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const result = await client.docs.diff(repo, path, localOpts.from, localOpts.to);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          // Raw patch on stdout for `patch -p0`-friendly piping.
          process.stdout.write(result.patch.endsWith("\n") ? result.patch : `${result.patch}\n`);
        }
      }).catch(reportError);
    });

  docs
    .command("create <path>")
    .description("create a new document (fails if the path is taken)")
    .option("--from-file <file>", "read the markdown from a file or '-' for stdin")
    .action(function (this: Command, path: string) {
      const localOpts = this.opts<{ fromFile?: string }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const { frontmatter_raw, body } = readDocumentInput(localOpts.fromFile);
        const result = await client.docs.create(repo, path, { frontmatter_raw, body });
        emitVersionWrite(result, opts);
      }).catch(reportError);
    });

  docs
    .command("put <path>")
    .description("update or move a document — path may differ from prev's path")
    .option(
      "--prev <version-id>",
      "current version id (from get / history) — optional if the input's frontmatter carries `$version: <id>`",
    )
    .option("--from-file <file>", "read the markdown from a file or '-' for stdin")
    .action(function (this: Command, path: string) {
      const localOpts = this.opts<{ prev?: string; fromFile?: string }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const input: { frontmatter_raw?: string; body?: string } = {};
        let embeddedVersion: string | undefined;
        if (localOpts.fromFile) {
          const parsed = readDocumentInput(localOpts.fromFile);
          const { raw: cleaned, props } = extractSystemProperties(parsed.frontmatter_raw);
          input.frontmatter_raw = cleaned;
          input.body = parsed.body;
          if (typeof props.version === "string" && props.version.length > 0) {
            embeddedVersion = props.version;
          }
        }
        const prev = localOpts.prev ?? embeddedVersion;
        if (prev === undefined) {
          const err = new Error(
            "no prev version — pass --prev, or provide `$version: <id>` in the input frontmatter",
          );
          (err as unknown as { code: string }).code = "cli_usage";
          throw err;
        }
        const result = await client.docs.put(repo, prev, path, input);
        emitVersionWrite(result, opts);
      }).catch(reportError);
    });

  docs
    .command("delete")
    .description("delete a document — moves to :deleted/… (idempotent)")
    .requiredOption("--prev <version-id>", "current version id (from get / history)")
    .action(function (this: Command) {
      const localOpts = this.opts<{ prev: string }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const result = await client.docs.delete(repo, localOpts.prev);
        emitVersionWrite(result, opts);
      }).catch(reportError);
    });

  docs
    .command("mv <to-path>")
    .description("move a document — sugar for put at <to-path> with body unchanged")
    .requiredOption("--prev <version-id>", "current version id (from get / history)")
    .action(function (this: Command, toPath: string) {
      const localOpts = this.opts<{ prev: string }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      let repo: string;
      try {
        repo = resolveRepoSlug(globals);
      } catch (err) {
        reportError(err);
      }
      withClient(this, async (client, opts) => {
        const result = await client.docs.put(repo, localOpts.prev, toPath, {});
        emitVersionWrite(result, opts);
      }).catch(reportError);
    });

  // -------- query --------
  program
    .command("query")
    .description("search documents — CEL filter + FTS text + rank (design §5)")
    .option(
      "-r, --repo <slug-or-glob>",
      "repo slug or glob; repeat the flag to query multiple (default: all in scope)",
      (value: string, prev: string[] | undefined) => [...(prev ?? []), value],
    )
    .option("--filter <expr>", "CEL filter expression")
    .option(
      "--path <glob>",
      "gitignore-style path glob (bare name → any depth, leading `/` → root)",
    )
    .option("--text <query>", "FTS5 query over body")
    .option("--rank <query>", "semantic rank via embeddings (§5.1); requires an embed hook")
    .option("--limit <n>", "max results (positive integer; default 50)", parsePositiveInt)
    .option("--include-hidden", "surface .-prefixed paths", false)
    .option("--include-system", "surface :-prefixed (deleted, etc.) paths", false)
    .action(function (this: Command) {
      const localOpts = this.opts<{
        repo?: string[];
        filter?: string;
        path?: string;
        text?: string;
        rank?: string;
        limit?: number;
        includeHidden: boolean;
        includeSystem: boolean;
      }>();
      withClient(this, async (client, opts) => {
        const result = await client.query({
          repo: localOpts.repo,
          filter: combinePathAndFilter(localOpts.path, localOpts.filter),
          text: localOpts.text,
          rank: localOpts.rank,
          limit: localOpts.limit,
          include_hidden: localOpts.includeHidden,
          include_system: localOpts.includeSystem,
        });
        emit(result, opts, renderQueryTable(result));
      }).catch(reportError);
    });

  // -------- links (§11.2) --------
  const links = program.command("links").description("link index — backfill / stale / repair");

  // Repo comes from the global -r/--repo (or MRPLEX_REPO / config), the same
  // source `docs *` commands use — so `mrplex -r notes links stale`.
  links
    .command("backfill")
    .description("rebuild the link index for a repo (backfill / after a link-config change)")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOpts>();
      const repo = resolveRepoSlug(globals);
      withClient(this, async (client, opts) => {
        const result = await client.links.backfill(repo);
        emit(result, opts, `backfill ${repo}: documents=${result.documents} edges=${result.edges}`);
      }).catch(reportError);
    });

  links
    .command("stale")
    .description("list live docs whose written link text no longer matches the target's path")
    .action(function (this: Command) {
      const globals = this.optsWithGlobals<GlobalOpts>();
      const repo = resolveRepoSlug(globals);
      withClient(this, async (client, opts) => {
        const result = await client.links.stale(repo);
        const text = result.length
          ? result.map((r) => `${r.source_path}: "${r.written}" → "${r.current}"`).join("\n")
          : "no stale links";
        emit(result, opts, text);
      }).catch(reportError);
    });

  links
    .command("repair")
    .description("rewrite stale link text as optimistic docs.put (conflicts skipped)")
    .option("--dry-run", "report what would change without writing", false)
    .action(function (this: Command) {
      const localOpts = this.opts<{ dryRun: boolean }>();
      const globals = this.optsWithGlobals<GlobalOpts>();
      const repo = resolveRepoSlug(globals);
      withClient(this, async (client, opts) => {
        const result = await client.links.repair(repo, { dry_run: localOpts.dryRun });
        const prefix = result.dry_run ? "[dry-run] " : "";
        const lines = [
          `${prefix}repaired ${result.repaired.length} doc(s), skipped ${result.skipped.length}`,
          ...result.repaired.map((r) => `  ~ ${r.path} (${r.edges} link(s))`),
          ...result.skipped.map((s) => `  ! ${s.path}: ${s.reason}`),
        ];
        emit(result, opts, lines.join("\n"));
      }).catch(reportError);
    });

  // -------- embed --------
  // Embed commands are LOCAL-mode only (bypass the client seam like
  // `bootstrap` and `serve`): backfill drives the worker directly
  // against storage, and status reads backlog+chunks tables. Running
  // against a remote server means running these commands on that host
  // — same as bootstrap.
  const embed = program.command("embed").description("embedding worker + backlog");

  embed
    .command("backfill")
    .description("re-chunk + re-embed current versions missing chunks (§5.3)")
    .requiredOption("-r, --repo <slug>", "repo to backfill")
    .option("--embed-url <url>", "HTTP embedding endpoint")
    .option("--embed-cmd <cmd>", "subprocess embedding command (JSON-lines over stdio)")
    .action(function (this: Command) {
      const localOpts = this.opts<{ repo: string; embedUrl?: string; embedCmd?: string }>();
      const gopts = this.optsWithGlobals<GlobalOpts>();
      (async () => {
        try {
          const embedCfg = resolveEmbedConfig({
            embed_url: localOpts.embedUrl,
            embed_cmd: localOpts.embedCmd,
          });
          if (embedCfg.kind === "none") {
            process.stderr.write(
              "embed backfill: no hook configured — set --embed-url or --embed-cmd\n",
            );
            process.exit(1);
          }
          const hook = createHookFromConfig(embedCfg);
          if (!hook) {
            process.stderr.write("embed backfill: unreachable — missing hook\n");
            process.exit(1);
            return;
          }
          const storage = await openStorage(resolveDatabase(gopts));
          const worker = createWorker({ storage, hook });
          try {
            const report = await backfillRepo(storage, localOpts.repo, worker, (m) =>
              process.stderr.write(`${m}\n`),
            );
            if (gopts.json) {
              process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            } else {
              process.stdout.write(
                `backfill ${localOpts.repo}: enqueued=${report.enqueued} processed=${report.processed} failed=${report.failed} skipped=${report.skipped}\n`,
              );
            }
            if (report.failed > 0) process.exit(1);
          } finally {
            await worker.stop();
            await storage.close();
          }
        } catch (err) {
          reportError(err);
        }
      })();
    });

  embed
    .command("status")
    .description("inspect the embedding backlog (m4-plan §5 decision 6)")
    .action(function (this: Command) {
      const gopts = this.optsWithGlobals<GlobalOpts>();
      (async () => {
        try {
          const storage = await openStorage(resolveDatabase(gopts));
          try {
            const now = new Date().toISOString();
            const status = await storage.backlog_status(now);
            if (gopts.json) {
              process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
            } else {
              process.stdout.write(
                `pending: ${status.pending}\ndue:     ${status.due}\nfailing: ${status.failing}\n`,
              );
              if (status.oldest_next_retry_at) {
                process.stdout.write(`oldest retry: ${status.oldest_next_retry_at}\n`);
              }
              if (status.models.length > 0) {
                process.stdout.write("models:\n");
                for (const m of status.models) {
                  process.stdout.write(`  ${m.model}  chunks=${m.chunk_count}\n`);
                }
              }
              if (status.recent_errors.length > 0) {
                process.stdout.write("recent errors:\n");
                for (const e of status.recent_errors) {
                  process.stdout.write(`  v${e.version_id}: ${e.last_error}\n`);
                }
              }
            }
          } finally {
            await storage.close();
          }
        } catch (err) {
          reportError(err);
        }
      })();
    });

  return program;
}

const program = buildProgram();
try {
  program.parse(process.argv);
} catch (err) {
  reportError(err);
}
