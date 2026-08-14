#!/usr/bin/env node
/**
 * mrplex CLI (M1 — reads + writes + tokens + bootstrap + config).
 *
 * Design §7.3 says the CLI is a thin client over MCP; in M1 it talks to the
 * in-process kernel against a local SQLite file. --server support arrives
 * in M3 with the MCP surface.
 */

import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import type { Actor } from "../kernel/auth/actor.js";
import type { ScopeInput } from "../kernel/auth/scope.js";
import { KernelError } from "../kernel/errors.js";
import { createKernel } from "../kernel/kernel.js";
import type { Kernel } from "../kernel/kernel.js";
import { split as splitFrontmatter } from "../markdown/frontmatter.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";
import { resolveCliActor } from "./auth.js";
import { type BootstrapError, bootstrap } from "./bootstrap.js";
import { type CliConfig, loadConfig, saveConfig } from "./config.js";
import { exitCodeForKernelError } from "./exit-codes.js";
import {
  renderHistoryTable,
  renderReposTable,
  renderUsersTable,
  renderVersionAsMarkdown,
} from "./format.js";

// -----------------------------------------------------------------------------
// Utility parsers + helpers
// -----------------------------------------------------------------------------

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
 * Parse a --scope value into a ScopeInput.
 *
 *   <slug-or-glob>:read=<glob>[,<glob>...],write=<glob>[,<glob>...]
 *
 * e.g. `notes:read=**,write=inbox/**`
 *      `team-*:read=**`
 *      `*:read=**,write=**`
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

type GlobalOpts = { database?: string; json?: boolean; token?: string };

function resolveDatabase(opts: GlobalOpts): string {
  const cfg = loadConfig();
  const value =
    opts.database ?? process.env.MRPLEX_DATABASE ?? cfg.database ?? "sqlite:./mrplex.db";
  return value.startsWith("sqlite:") || value.startsWith("postgres:") ? value : `sqlite:${value}`;
}

function openStorage(opts: GlobalOpts): Storage {
  return sqliteAdapter.open({ database: resolveDatabase(opts) });
}

/**
 * Run a callback with an open storage + kernel + resolved Actor. Handles
 * the whole lifecycle including close-on-throw. Kernel commands go
 * through this.
 */
function withActorAndKernel<T>(
  cmd: Command,
  fn: (kernel: Kernel, actor: Actor, opts: GlobalOpts) => T,
): T {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  const storage = openStorage(opts);
  try {
    const actor = resolveCliActor(opts.token, storage);
    const kernel = createKernel(storage);
    return fn(kernel, actor, opts);
  } finally {
    storage.close();
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
  // CLI-side unauthorized (bearer resolve failed) → exit family 3.
  const code = (err as { code?: string }).code;
  if (code === "unauthorized") {
    process.stderr.write(`${JSON.stringify({ code, data: {} })}\n`);
    process.exit(3);
  }
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

/**
 * Read the content of --from-file, or stdin if the arg is "-".
 * Returns the raw file bytes as a UTF-8 string.
 */
function readFromFile(pathOrDash: string): string {
  if (pathOrDash === "-") {
    return readFileSync(0, "utf8"); // fd 0 = stdin
  }
  return readFileSync(pathOrDash, "utf8");
}

/**
 * Split a markdown file (from disk or stdin) into { frontmatter_raw, body }.
 * Kept CLI-side so submissions travel over the wire byte-verbatim (§3.2).
 */
function readDocumentInput(fromFile: string | undefined): {
  frontmatter_raw: string;
  body: string;
} {
  if (!fromFile) {
    return { frontmatter_raw: "", body: "" };
  }
  return splitFrontmatter(readFromFile(fromFile));
}

/**
 * Print the write result — new version_id on stdout for scripting, envelope
 * summary on stderr for humans. --json overrides to full envelope on stdout.
 */
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
    .description("Markdown Repos, plexed — CLI (M1)")
    .version("0.0.0")
    .addOption(
      new Option("--database <url>", "sqlite:./path.db or postgres://…").env("MRPLEX_DATABASE"),
    )
    .addOption(new Option("--token <token>", "bearer token").env("MRPLEX_TOKEN"))
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
      try {
        const result = bootstrap(resolveDatabase(opts));
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
    .command("show")
    .description("print the current CLI config")
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<GlobalOpts>();
      const c = loadConfig();
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(c, null, 2)}\n`);
      } else {
        process.stdout.write(
          `database: ${c.database ?? "(unset)"}\ntoken:    ${c.token ? "(set)" : "(unset)"}\n`,
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
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.repos.list(actor, { include_system: localOpts.includeSystem }),
        );
        emit(result, this.optsWithGlobals(), renderReposTable(result));
      } catch (err) {
        reportError(err);
      }
    });

  repos
    .command("get <slug>")
    .description("show a repo")
    .action(function (this: Command, slug: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) => kernel.repos.get(actor, slug));
        emit(
          result,
          this.optsWithGlobals(),
          `${result.repo}  ${result.path_config ? "(custom path_config)" : "(default path_config)"}`,
        );
      } catch (err) {
        reportError(err);
      }
    });

  repos
    .command("create <slug>")
    .description("create a new repo (admin)")
    .action(function (this: Command, slug: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.repos.create(actor, slug),
        );
        emit(result, this.optsWithGlobals(), `created repo ${result.repo}`);
      } catch (err) {
        reportError(err);
      }
    });

  repos
    .command("rename <slug> <new-slug>")
    .description("rename a repo (admin)")
    .action(function (this: Command, slug: string, newSlug: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.repos.rename(actor, slug, newSlug),
        );
        emit(result, this.optsWithGlobals(), `renamed ${slug} → ${result.repo}`);
      } catch (err) {
        reportError(err);
      }
    });

  repos
    .command("delete <slug>")
    .description("delete a repo — renames slug into the system namespace (admin)")
    .action(function (this: Command, slug: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.repos.delete(actor, slug),
        );
        emit(result, this.optsWithGlobals(), `deleted (now ${result.repo})`);
      } catch (err) {
        reportError(err);
      }
    });

  repos
    .command("set-path-config <slug>")
    .description("set the per-repo path config override (§3.5)")
    .option("--from-file <file>", "read JSON override from file (- for stdin)")
    .option("--clear", "clear the override — inherit from server config", false)
    .action(function (this: Command, slug: string) {
      const localOpts = this.opts<{ fromFile?: string; clear: boolean }>();
      try {
        const config = localOpts.clear
          ? null
          : (JSON.parse(readFromFile(localOpts.fromFile ?? "-")) as never);
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.repos.set_path_config(actor, slug, config),
        );
        emit(
          result,
          this.optsWithGlobals(),
          `updated ${slug}\nwarnings: ${result.warnings.length}`,
        );
      } catch (err) {
        reportError(err);
      }
    });

  // -------- users --------
  const users = program.command("users").description("user management");
  users
    .command("list")
    .description("list users")
    .action(function (this: Command) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) => kernel.users.list(actor));
        emit(result, this.optsWithGlobals(), renderUsersTable(result));
      } catch (err) {
        reportError(err);
      }
    });

  users
    .command("create <slug>")
    .description("create a user (admin)")
    .action(function (this: Command, slug: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.users.create(actor, slug),
        );
        emit(result, this.optsWithGlobals(), `created user ${result.user}`);
      } catch (err) {
        reportError(err);
      }
    });

  users
    .command("rename <slug> <new-slug>")
    .description("rename a user (admin)")
    .action(function (this: Command, slug: string, newSlug: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.users.rename(actor, slug, newSlug),
        );
        emit(result, this.optsWithGlobals(), `renamed ${slug} → ${result.user}`);
      } catch (err) {
        reportError(err);
      }
    });

  users
    .command("delete <slug>")
    .description("delete a user — system-namespace rename + revoke tokens (admin)")
    .action(function (this: Command, slug: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.users.delete(actor, slug),
        );
        emit(result, this.optsWithGlobals(), `deleted (now ${result.user})`);
      } catch (err) {
        reportError(err);
      }
    });

  // -------- docs --------
  const docs = program.command("docs").description("document ops");
  docs
    .command("get <repo> <path>")
    .description("read the current version at <path>")
    .action(function (this: Command, repo: string, path: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.docs.get(actor, repo, path),
        );
        emit(result, this.optsWithGlobals(), renderVersionAsMarkdown(result));
      } catch (err) {
        reportError(err);
      }
    });

  docs
    .command("get-version <repo> <version-id>")
    .description("read a specific version by id")
    .action(function (this: Command, repo: string, versionId: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.docs.get_version(actor, repo, versionId),
        );
        emit(result, this.optsWithGlobals(), renderVersionAsMarkdown(result));
      } catch (err) {
        reportError(err);
      }
    });

  docs
    .command("history <repo> <path>")
    .description("list versions of a document newest-first")
    .option("--limit <n>", "limit to N most-recent (positive integer)", parsePositiveInt)
    .option("--before <ts>", "only versions with created_at < <ts>")
    .action(function (this: Command, repo: string, path: string) {
      const localOpts = this.opts<{ limit?: number; before?: string }>();
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.docs.history(actor, repo, path, {
            limit: localOpts.limit,
            before: localOpts.before,
          }),
        );
        emit(result, this.optsWithGlobals(), renderHistoryTable(result));
      } catch (err) {
        reportError(err);
      }
    });

  docs
    .command("create <repo> <path>")
    .description("create a new document (fails if the path is taken)")
    .option("--from-file <file>", "read the markdown from a file or '-' for stdin")
    .action(function (this: Command, repo: string, path: string) {
      const localOpts = this.opts<{ fromFile?: string }>();
      try {
        const { frontmatter_raw, body } = readDocumentInput(localOpts.fromFile);
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.docs.create(actor, repo, path, { frontmatter_raw, body }),
        );
        emitVersionWrite(result, this.optsWithGlobals());
      } catch (err) {
        reportError(err);
      }
    });

  docs
    .command("put <repo> <path>")
    .description("update or move a document — path may differ from prev's path")
    .requiredOption("--prev <version-id>", "current version id (from get / history)")
    .option("--from-file <file>", "read the markdown from a file or '-' for stdin")
    .action(function (this: Command, repo: string, path: string) {
      const localOpts = this.opts<{ prev: string; fromFile?: string }>();
      try {
        const input: {
          frontmatter_raw?: string;
          body?: string;
        } = {};
        if (localOpts.fromFile) {
          const parsed = readDocumentInput(localOpts.fromFile);
          input.frontmatter_raw = parsed.frontmatter_raw;
          input.body = parsed.body;
        }
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.docs.put(actor, repo, localOpts.prev, path, input),
        );
        emitVersionWrite(result, this.optsWithGlobals());
      } catch (err) {
        reportError(err);
      }
    });

  docs
    .command("delete <repo> <path>")
    .description("delete a document — moves to :deleted/… (idempotent)")
    .requiredOption("--prev <version-id>", "current version id (from get / history)")
    .action(function (this: Command, _repo: string, _path: string) {
      const localOpts = this.opts<{ prev: string }>();
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.docs.delete(actor, _repo, localOpts.prev),
        );
        emitVersionWrite(result, this.optsWithGlobals());
      } catch (err) {
        reportError(err);
      }
    });

  docs
    .command("mv <repo> <from-path> <to-path>")
    .description("move a document — sugar for put at <to-path> with body unchanged")
    .requiredOption("--prev <version-id>", "current version id (from get / history)")
    .action(function (this: Command, repo: string, _fromPath: string, toPath: string) {
      const localOpts = this.opts<{ prev: string }>();
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.docs.put(actor, repo, localOpts.prev, toPath, {}),
        );
        emitVersionWrite(result, this.optsWithGlobals());
      } catch (err) {
        reportError(err);
      }
    });

  // -------- tokens --------
  const tokens = program.command("tokens").description("bearer tokens");
  tokens
    .command("list")
    .description("list your tokens")
    .action(function (this: Command) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) => kernel.tokens.list(actor));
        // Pretty output: id / label / admin / expires_at
        const pretty =
          result.length === 0
            ? "(no tokens)"
            : result
                .map(
                  (t) =>
                    `${t.id}  ${t.admin ? "[admin] " : "        "}${t.label ?? ""}${t.expires_at ? `  expires: ${t.expires_at}` : ""}`,
                )
                .join("\n");
        emit(result, this.optsWithGlobals(), pretty);
      } catch (err) {
        reportError(err);
      }
    });

  tokens
    .command("create")
    .description("mint a new token; plaintext secret printed once on stdout")
    .requiredOption("--label <label>", "human-readable label (e.g. 'obsidian-plugin')")
    .option("--scope <spec>", "repo-scoped capability, repeatable — see help", parseScope, [])
    .option("--admin", "mint an admin token (requires the caller to be admin)", false)
    .option("--expires <ts>", "ISO 8601 expiry")
    .action(function (this: Command) {
      const localOpts = this.opts<{
        label: string;
        scope: ScopeInput[];
        admin: boolean;
        expires?: string;
      }>();
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.tokens.create(actor, localOpts.label, localOpts.scope, {
            admin: localOpts.admin,
            expires_at: localOpts.expires ?? null,
          }),
        );
        const opts = this.optsWithGlobals<GlobalOpts>();
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          // Plaintext secret on stdout (scriptable); meta on stderr.
          process.stdout.write(`${result.token}\n`);
          process.stderr.write(
            `created token ${result.meta.id} (${result.meta.label})${result.meta.admin ? " [admin]" : ""}\n`,
          );
        }
      } catch (err) {
        reportError(err);
      }
    });

  tokens
    .command("revoke <token-id>")
    .description("revoke a token (self, or any if admin)")
    .action(function (this: Command, tokenId: string) {
      try {
        const result = withActorAndKernel(this, (kernel, actor) =>
          kernel.tokens.revoke(actor, tokenId),
        );
        emit(result, this.optsWithGlobals(), `revoked ${result.id}`);
      } catch (err) {
        reportError(err);
      }
    });

  return program;
}

const program = buildProgram();
try {
  program.parse(process.argv);
} catch (err) {
  reportError(err);
}
