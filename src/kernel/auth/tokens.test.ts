import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAdapter } from "../../storage-sqlite/adapter.js";
import type { Storage } from "../../storage/types.js";
import type { StoredScope } from "./actor.js";
import {
  generateSecret,
  hashSecret,
  hashesEqual,
  parseStoredScopes,
  resolveActor,
  serializeStoredScopes,
} from "./tokens.js";

describe("generateSecret", () => {
  it("returns a mrplex_-prefixed base64url string", async () => {
    const s = generateSecret();
    expect(s).toMatch(/^mrplex_[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 chars of unpadded base64url.
    expect(s.length).toBe("mrplex_".length + 43);
  });

  it("produces unique secrets across calls", async () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 1000; i++) secrets.add(generateSecret());
    expect(secrets.size).toBe(1000);
  });
});

describe("hashSecret", () => {
  it("is deterministic (same input → same digest)", async () => {
    expect(hashSecret("mrplex_abc")).toBe(hashSecret("mrplex_abc"));
  });

  it("produces a hex-encoded 64-char digest", async () => {
    expect(hashSecret("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinct secrets → distinct digests", async () => {
    expect(hashSecret("a")).not.toBe(hashSecret("b"));
  });
});

describe("hashesEqual", () => {
  it("equal for equal hex digests", async () => {
    const h = hashSecret("x");
    expect(hashesEqual(h, h)).toBe(true);
  });
  it("not equal for different digests", async () => {
    expect(hashesEqual(hashSecret("a"), hashSecret("b"))).toBe(false);
  });
  it("not equal for different-length strings", async () => {
    expect(hashesEqual("aa", "aabb")).toBe(false);
  });
});

describe("parseStoredScopes / serializeStoredScopes", () => {
  it("round-trips a typical scopes array", async () => {
    const scopes: StoredScope[] = [
      { repos: [1, 2], read: ["**"], write: ["inbox/**"] },
      { repos: "*", read: ["**"] },
    ];
    expect(parseStoredScopes(serializeStoredScopes(scopes))).toEqual(scopes);
  });

  it("round-trips an empty array", async () => {
    expect(parseStoredScopes(serializeStoredScopes([]))).toEqual([]);
  });

  it("rejects non-array JSON", async () => {
    expect(() => parseStoredScopes(JSON.stringify({ nope: true }))).toThrow(/array/);
  });

  it("rejects entries whose repos is not '*' or number[]", async () => {
    expect(() => parseStoredScopes(JSON.stringify([{ repos: "notes", read: ["**"] }]))).toThrow(
      /repos/,
    );
  });
});

describe("resolveActor (SQLite backed)", () => {
  let storage: Storage;

  beforeEach(async () => {
    const path = join(tmpdir(), `mrplex-tokens-${Date.now()}-${Math.random()}.db`);
    storage = await sqliteAdapter.open({ database: `sqlite:${path}` });
  });

  afterEach(async () => {
    await storage.close();
  });

  async function issueToken(
    input: {
      admin?: boolean;
      scopes?: StoredScope[];
      expires_at?: string | null;
    } = {},
  ) {
    const user = await storage.users_create({ slug: "alice", created_at: "2026-08-14T00:00:00Z" });
    const secret = generateSecret();
    const row = await storage.tokens_create({
      user_id: user.id,
      secret_hash: hashSecret(secret),
      label: "test",
      scopes: serializeStoredScopes(input.scopes ?? [{ repos: "*", read: ["**"] }]),
      admin: input.admin ?? false,
      expires_at: input.expires_at ?? null,
      created_at: "2026-08-14T00:00:01Z",
    });
    return { user, secret, row };
  }

  it("resolves a valid token to an Actor", async () => {
    const { user, secret } = await issueToken({ admin: true });
    const actor = await resolveActor(secret, storage);
    expect(actor).not.toBeNull();
    expect(actor?.user_id).toBe(user.id);
    expect(actor?.admin).toBe(true);
    expect(actor?.scopes).toEqual([{ repos: "*", read: ["**"] }]);
    expect(actor?.token_id).toBeDefined();
  });

  it("returns null for an unknown secret", async () => {
    expect(await resolveActor(generateSecret(), storage)).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    const { secret, row } = await issueToken();
    await storage.tokens_revoke(row.id, "2026-08-14T00:00:02Z");
    expect(await resolveActor(secret, storage)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const { secret } = await issueToken({ expires_at: "2020-01-01T00:00:00Z" });
    expect(await resolveActor(secret, storage)).toBeNull();
  });

  it("touches last_used_at on a successful resolve", async () => {
    const { secret, row } = await issueToken();
    expect((await storage.tokens_by_id(row.id))?.last_used_at).toBeNull();
    await resolveActor(secret, storage);
    const after = await storage.tokens_by_id(row.id);
    expect(after?.last_used_at).not.toBeNull();
  });

  it("users_delete precondition: tokens_revoke_by_user takes them all out", async () => {
    const { user, secret } = await issueToken();
    expect(await resolveActor(secret, storage)).not.toBeNull();
    await storage.tokens_revoke_by_user(user.id, "2026-08-14T00:00:02Z");
    expect(await resolveActor(secret, storage)).toBeNull();
  });
});
