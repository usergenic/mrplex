#!/usr/bin/env node
/**
 * mrplex CLI (M3 — reads + writes + tokens + bootstrap + config + serve +
 * remote mode).
 *
 * The CLI is a thin client over the MCP surface (§7.3). When `--server` is
 * set, commands drive `tools/call` against `<server>/mcp`; otherwise the CLI
 * opens the local SQLite file and calls the kernel in-process. The
 * transport seam is `KernelClient` (`src/client/*`).
 *
 * Bootstrap and serve deliberately bypass the seam — bootstrap creates the
 * first token before any auth exists, and serve IS the server.
 */

import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import type { KernelClient } from "../client/kernel-client.js";
import { openLocalClient } from "../client/local.js";
import { openRemoteClient } from "../client/remote-mcp.js";
import { backfillRepo } from "../embed/backfill.js";
import { createHookFromConfig, resolveEmbedConfig } from "../embed/config.js";
import { createWorker } from "../embed/worker.js";
import { globToRegexSource } from "../kernel/auth/glob.js";
import type { ScopeInput } from "../kernel/auth/scope.js";
import { KernelError } from "../kernel/errors.js";
import { extractSystemProperties, split as splitFrontmatter } from "../markdown/frontmatter.js";
import { startMcpStdio } from "../mcp/server.js";
import { startServer } from "../server/serve.js";
import { normalizeDatabaseUrl, openStorage } from "../storage/registry.js";
import { resolveTokenString } from "./auth.js";
import { type BootstrapError, bootstrap } from "./bootstrap.js";
import { type CliConfig, loadConfig, saveConfig } from "./config.js";
import { exitCodeForKernelError } from "./exit-codes.js";
import {
  renderHistoryTable,
  renderQueryTable,
  renderReposTable,
  renderUsersTable,
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
 * Parse a --scope value into a ScopeInput. See M1 for the grammar.
 */
function parseScope(value: string, prev: ScopeInput[] | undefined): ScopeInput[] {
  const [repoPart, ...capParts] = value.split(":");
  if (!repoPart) {
    throw new InvalidArgumentError(`--scope missing repo pattern: "${value}"`);
  }
  const capString = capParts.join(":");
  const scope: ScopeInput = { repo: repoPart };
  if (capString) {
    for (const cap of capString.split(",")) {
      const [action, globs] = cap.split("=");
      if (!action || !globs) {
        throw new InvalidArgumentError(
          `--scope malformed capability "${cap}" (expected read=<glob> or write=<glob>)`,
        );
      }
      const list = globs.split("|");
      if (action === "read") scope.read = list;
      else if (action === "write") scope.write = list;
      else {
        throw new InvalidArgumentError(
          `--scope unknown action "${action}" (expected read or write)`,
        );
      }
    }
  }
  return [...(prev ?? []), scope];
}

type GlobalOpts = {
  database?: string;
  json?: boolean;
  token?: string;
  server?: string;
  repo?: string;
};

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
  const secret = resolveTokenString(opts.token);
  if (secret === null) {
    throw makeUnauthorized(
      "no token — set MRPLEX_TOKEN, use --token, or `mrplex config set-token`",
    );
  }
  if (server) {
    return openRemoteClient({ server, token: secret });
  }
  const embedCfg = resolveEmbedConfig({});
  const embed = createHookFromConfig(embedCfg);
  return openLocalClient({ database: resolveDatabase(opts), token: secret, embed });
}

function makeUnauthorized(reason: string): Error {
  const err = new Error(`unauthorized: ${reason}`);
  (err as unknown as { code: string }).code = "unauthorized";
  return err;
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
  result: { version_id: string; repo: string; path: string; author: { user: string } },
  opts: GlobalOpts,
): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.version_id}\n`);
  process.stderr.write(
    `wrote ${result.repo}/${result.path} @ ${result.version_id} (author: ${result.author.user})\n`,
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
    .addOption(new Option("--token <token>", "bearer token").env("MRPLEX_TOKEN"))
    .addOption(
      new Option("--server <url>", "talk to a remote mrplex server (mutex with --database)").env(
        "MRPLEX_SERVER",
      ),
    )
    .addOption(
      new Option("-r, --repo <slug>", "target repo for `docs *` commands").env("MRPLEX_REPO"),
    )
    .option("--json", "emit raw JSON instead of pretty output", false)
    .exitOverride((err) => {
      if (err.exitCode === 0) process.exit(0);
      process.exit(err.exitCode || 1);
    });

  // -------- bootstrap --------
  program
    .command("bootstrap")
    .description("mint the root admin token on a FRESH database (design §8.3)")
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<GlobalOpts>();
      (async () => {
        try {
          const result = await bootstrap(resolveDatabase(opts));
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            process.stdout.write(`${result.token}\n`);
            process.stderr.write(
              `This is your root admin token. Store it now — it will not be shown again.\n  user:     ${result.user}\n  token_id: ${result.token_id}\n`,
            );
          }
        } catch (err) {
          if ((err as BootstrapError).name === "BootstrapError") {
            process.stderr.write(`${(err as Error).message}\n`);
            process.exit(1);
          }
          reportError(err);
        }
      })();
    });

  // -------- serve --------
  program
    .command("serve")
    .description("start HTTP surfaces (REST + MCP Streamable HTTP) — §7.3")
    .option("--port <n>", "TCP port (default 8321)", parsePositiveInt)
    .option("--host <h>", "bind host (default 127.0.0.1)")
    .option("--mcp-stdio", "also expose MCP over STDIO for the launch token", false)
    .option("--embed-url <url>", "HTTP embedding endpoint (§5.3)")
    .option("--embed-cmd <cmd>", "subprocess embedding command (JSON-lines over stdio)")
    .action(function (this: Command) {
      const gopts = this.optsWithGlobals<GlobalOpts>();
      const localOpts = this.opts<{
        port?: number;
        host?: string;
        mcpStdio: boolean;
        embedUrl?: string;
        embedCmd?: string;
      }>();
      (async () => {
        try {
          const database = resolveDatabase(gopts);
          const embedCfg = resolveEmbedConfig({
            embed_url: localOpts.embedUrl,
            embed_cmd: localOpts.embedCmd,
          });
          const handle = await startServer({
            database,
            host: localOpts.host,
            port: localOpts.port,
            embed: embedCfg,
          });

          // Optional STDIO — bound to the launch-time token per §6.2.
          if (localOpts.mcpStdio) {
            const secret = resolveTokenString(gopts.token);
            if (secret === null) {
              process.stderr.write(
                "mrplex: --mcp-stdio requires a token (--token / MRPLEX_TOKEN / config)\n",
              );
              await handle.close();
              process.exit(3);
            }
            try {
              await startMcpStdio({
                kernel: handle.kernel,
                storage: handle.storage,
                token: secret,
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
    .command("show")
    .description("print the current CLI config")
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<GlobalOpts>();
      const c = loadConfig();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(c, null, 2)}\n`);
      } else {
        process.stdout.write(
          `database: ${c.database ?? "(unset)"}\nserver:   ${c.server ?? "(unset)"}\nrepo:     ${c.repo ?? "(unset)"}\ntoken:    ${c.token ? "(set)" : "(unset)"}\n`,
        );
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

  // -------- users --------
  const users = program.command("users").description("user management");
  users
    .command("list")
    .description("list users")
    .action(function (this: Command) {
      withClient(this, async (client, opts) => {
        const result = await client.users.list();
        emit(result, opts, renderUsersTable(result));
      }).catch(reportError);
    });

  users
    .command("create <slug>")
    .description("create a user (admin)")
    .action(function (this: Command, slug: string) {
      withClient(this, async (client, opts) => {
        const result = await client.users.create(slug);
        emit(result, opts, `created user ${result.user}`);
      }).catch(reportError);
    });

  users
    .command("rename <slug> <new-slug>")
    .description("rename a user (admin)")
    .action(function (this: Command, slug: string, newSlug: string) {
      withClient(this, async (client, opts) => {
        const result = await client.users.rename(slug, newSlug);
        emit(result, opts, `renamed ${slug} → ${result.user}`);
      }).catch(reportError);
    });

  users
    .command("delete <slug>")
    .description("delete a user — system-namespace rename + revoke tokens (admin)")
    .action(function (this: Command, slug: string) {
      withClient(this, async (client, opts) => {
        const result = await client.users.delete(slug);
        emit(result, opts, `deleted (now ${result.user})`);
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

  // -------- tokens --------
  const tokens = program.command("tokens").description("bearer tokens");
  tokens
    .command("list")
    .description("list your tokens")
    .action(function (this: Command) {
      withClient(this, async (client, opts) => {
        const result = await client.tokens.list();
        const pretty =
          result.length === 0
            ? "(no tokens)"
            : result
                .map(
                  (t) =>
                    `${t.id}  ${t.admin ? "[admin] " : "        "}${t.label ?? ""}${t.expires_at ? `  expires: ${t.expires_at}` : ""}`,
                )
                .join("\n");
        emit(result, opts, pretty);
      }).catch(reportError);
    });

  tokens
    .command("create")
    .description("mint a new token; plaintext secret printed once on stdout")
    .requiredOption("--label <label>", "human-readable label (e.g. 'obsidian-plugin')")
    .option("--scope <spec>", "repo-scoped capability, repeatable — see help", parseScope, [])
    .option("--admin", "mint an admin token (requires the caller to be admin)", false)
    .option("--expires <ts>", "ISO 8601 expiry")
    .option("--for-user <slug>", "mint on behalf of this user (admin only)")
    .action(function (this: Command) {
      const localOpts = this.opts<{
        label: string;
        scope: ScopeInput[];
        admin: boolean;
        expires?: string;
        forUser?: string;
      }>();
      withClient(this, async (client, opts) => {
        const result = await client.tokens.create(localOpts.label, localOpts.scope, {
          admin: localOpts.admin,
          expires_at: localOpts.expires ?? null,
          for_user: localOpts.forUser ?? null,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${result.token}\n`);
          process.stderr.write(
            `created token ${result.meta.id} (${result.meta.label ?? ""})${result.meta.admin ? " [admin]" : ""}\n`,
          );
        }
      }).catch(reportError);
    });

  tokens
    .command("revoke <token-id>")
    .description("revoke a token (self, or any if admin)")
    .action(function (this: Command, tokenId: string) {
      withClient(this, async (client, opts) => {
        const result = await client.tokens.revoke(tokenId);
        emit(result, opts, `revoked ${result.id}`);
      }).catch(reportError);
    });

  return program;
}

const program = buildProgram();
try {
  program.parse(process.argv);
} catch (err) {
  reportError(err);
}
