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
  it("mints a root admin token on a fresh database", async () => {
    const result = await bootstrap(`sqlite:${dbPath}`);
    expect(result.token).toMatch(/^mrplex_[A-Za-z0-9_-]+$/);
    expect(result.user).toBe("system");
    expect(result.token_id).toMatch(/^t\d+$/);
  });

  it("issued root token resolves to an admin actor with '*' scopes", async () => {
    const { token } = await bootstrap(`sqlite:${dbPath}`);
    const storage = await sqliteAdapter.open({ database: `sqlite:${dbPath}` });
    try {
      const actor = await resolveActor(token, storage);
      expect(actor).not.toBeNull();
      expect(actor?.admin).toBe(true);
      expect(actor?.scopes[0]?.repos).toBe("*");
      expect(actor?.scopes[0]?.read).toEqual(["**"]);
      expect(actor?.scopes[0]?.write).toEqual(["**"]);
    } finally {
      await storage.close();
    }
  });

  it("refuses when any user already exists", async () => {
    await bootstrap(`sqlite:${dbPath}`);
    await expect(bootstrap(`sqlite:${dbPath}`)).rejects.toBeInstanceOf(BootstrapError);
    await expect(bootstrap(`sqlite:${dbPath}`)).rejects.toThrow(/not empty/);
  });

  it("system user is created with the exact slug 'system'", async () => {
    await bootstrap(`sqlite:${dbPath}`);
    const storage = await sqliteAdapter.open({ database: `sqlite:${dbPath}` });
    try {
      const user = await storage.users_by_slug("system");
      expect(user).not.toBeNull();
    } finally {
      await storage.close();
    }
  });
});
