#!/usr/bin/env node
/**
 * mrplex CLI (M0 read-only slice).
 *
 * Design §7.3 says the CLI is a thin client over MCP; in M0 it talks to the
 * in-process kernel against a local SQLite file. --server support arrives in
 * M3 with the MCP surface.
 */

import { Command, InvalidArgumentError, Option } from "commander";
import { SYSTEM_ACTOR } from "../kernel/auth/actor.js";
import { KernelError } from "../kernel/errors.js";
import { createKernel } from "../kernel/kernel.js";
import type { Kernel } from "../kernel/kernel.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import type { Storage } from "../storage/types.js";
import { exitCodeForKernelError } from "./exit-codes.js";
import {
  renderHistoryTable,
  renderReposTable,
  renderUsersTable,
  renderVersionAsMarkdown,
} from "./format.js";

/** Strict positive-integer parser for numeric CLI options. */
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

type GlobalOpts = { database?: string; json?: boolean };

function resolveDatabase(opts: GlobalOpts): string {
  const value = opts.database ?? process.env.MRPLEX_DATABASE ?? "sqlite:./mrplex.db";
  return value.startsWith("sqlite:") || value.startsWith("postgres:") ? value : `sqlite:${value}`;
}

function openStorage(opts: GlobalOpts): Storage {
  return sqliteAdapter.open({ database: resolveDatabase(opts) });
}

function withKernel<T>(cmd: Command, fn: (kernel: Kernel, opts: GlobalOpts) => T): T {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  const storage = openStorage(opts);
  try {
    const kernel = createKernel(storage);
    return fn(kernel, opts);
  } finally {
    storage.close();
  }
}

function emit(result: unknown, opts: GlobalOpts, prettyText: string): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  // Table output ends without a newline; markdown output usually ends WITH
  // one (bodies typically terminate in \n). Ensure exactly one trailing
  // newline either way — otherwise `docs get` on a newline-terminated doc
  // paints an extra blank line.
  const text = prettyText.endsWith("\n") ? prettyText : `${prettyText}\n`;
  process.stdout.write(text);
}

function reportError(err: unknown): never {
  if (err instanceof KernelError) {
    const payload = { code: err.code, data: err.data };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exit(exitCodeForKernelError(err.code));
  }
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

function buildProgram(): Command {
  const program = new Command()
    .name("mrplex")
    .description("Markdown Repos, plexed — CLI (M0)")
    .version("0.0.0")
    .addOption(
      new Option("--database <url>", "sqlite:./path.db or postgres://…").env("MRPLEX_DATABASE"),
    )
    .option("--json", "emit raw JSON instead of pretty output", false)
    .exitOverride((err) => {
      if (err.exitCode === 0) process.exit(0);
      process.exit(err.exitCode || 1);
    });

  // repos
  const repos = program.command("repos").description("repo management (M0: reads)");
  repos
    .command("list")
    .description("list repos")
    .option("--include-system", "include system-namespaced repos (§3.4)", false)
    .action(function (this: Command) {
      const localOpts = this.opts<{ includeSystem: boolean }>();
      try {
        const result = withKernel(this, (kernel) =>
          kernel.repos.list(SYSTEM_ACTOR, { include_system: localOpts.includeSystem }),
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
        const result = withKernel(this, (kernel) => kernel.repos.get(SYSTEM_ACTOR, slug));
        emit(
          result,
          this.optsWithGlobals(),
          `${result.repo}  ${result.path_config ? "(custom path_config)" : "(default path_config)"}`,
        );
      } catch (err) {
        reportError(err);
      }
    });

  // users
  const users = program.command("users").description("user management (M0: reads)");
  users
    .command("list")
    .description("list users")
    .action(function (this: Command) {
      try {
        const result = withKernel(this, (kernel) => kernel.users.list(SYSTEM_ACTOR));
        emit(result, this.optsWithGlobals(), renderUsersTable(result));
      } catch (err) {
        reportError(err);
      }
    });

  // docs
  const docs = program.command("docs").description("document reads (M0)");
  docs
    .command("get <repo> <path>")
    .description("read the current version at <path>")
    .action(function (this: Command, repo: string, path: string) {
      try {
        const result = withKernel(this, (kernel) => kernel.docs.get(SYSTEM_ACTOR, repo, path));
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
        const result = withKernel(this, (kernel) =>
          kernel.docs.get_version(SYSTEM_ACTOR, repo, versionId),
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
        const result = withKernel(this, (kernel) =>
          kernel.docs.history(SYSTEM_ACTOR, repo, path, {
            limit: localOpts.limit,
            before: localOpts.before,
          }),
        );
        emit(result, this.optsWithGlobals(), renderHistoryTable(result));
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
