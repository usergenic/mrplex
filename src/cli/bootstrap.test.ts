import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveActor } from "../kernel/auth/tokens.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";
import { BootstrapError, bootstrap } from "./bootstrap.js";

let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `mrplex-bootstrap-${Date.now()}-${Math.random()}.db`);
});

afterEach(() => {
  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe("bootstrap", () => {
  it("mints a root admin token on a fresh database", () => {
    const result = bootstrap(`sqlite:${dbPath}`);
    expect(result.token).toMatch(/^mrplex_[A-Za-z0-9_-]+$/);
    expect(result.user).toBe("system");
    expect(result.token_id).toMatch(/^t\d+$/);
  });

  it("issued root token resolves to an admin actor with '*' scopes", () => {
    const { token } = bootstrap(`sqlite:${dbPath}`);
    const storage = sqliteAdapter.open({ database: `sqlite:${dbPath}` });
    try {
      const actor = resolveActor(token, storage);
      expect(actor).not.toBeNull();
      expect(actor?.admin).toBe(true);
      expect(actor?.scopes[0]?.repos).toBe("*");
      expect(actor?.scopes[0]?.read).toEqual(["**"]);
      expect(actor?.scopes[0]?.write).toEqual(["**"]);
    } finally {
      storage.close();
    }
  });

  it("refuses when any user already exists", () => {
    // First bootstrap succeeds; second should fail.
    bootstrap(`sqlite:${dbPath}`);
    expect(() => bootstrap(`sqlite:${dbPath}`)).toThrow(BootstrapError);
    expect(() => bootstrap(`sqlite:${dbPath}`)).toThrow(/not empty/);
  });

  it("system user is created with the exact slug 'system'", () => {
    bootstrap(`sqlite:${dbPath}`);
    const storage = sqliteAdapter.open({ database: `sqlite:${dbPath}` });
    try {
      const user = storage.users_by_slug("system");
      expect(user).not.toBeNull();
    } finally {
      storage.close();
    }
  });
});
