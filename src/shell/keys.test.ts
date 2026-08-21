/**
 * API keys — auth-shell plan WS3. Minting, hashing, principal resolution,
 * bearer parsing.
 */

import { describe, expect, it } from "vitest";
import { bearerToken, hashKey, mintKey, principalForKey } from "./keys.js";
import type { Policy } from "./policy.js";

function policyWith(keysByPrincipal: Record<string, string[]>): Policy {
  const principals: Policy["principals"] = {};
  for (const [id, keys] of Object.entries(keysByPrincipal)) {
    principals[id] = { author: id, roles: [], keys };
  }
  return { roles: {}, principals };
}

describe("mintKey + hashKey", () => {
  it("produces a plaintext whose hash matches hashKey", () => {
    const { plaintext, hash } = mintKey();
    expect(hash).toBe(hashKey(plaintext));
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("mints distinct keys each call", () => {
    const a = mintKey();
    const b = mintKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it("is deterministic — same plaintext hashes the same", () => {
    expect(hashKey("hello")).toBe(hashKey("hello"));
  });
});

describe("principalForKey", () => {
  it("resolves a key to its principal", () => {
    const { plaintext, hash } = mintKey();
    const policy = policyWith({ alice: [hash] });
    expect(principalForKey(policy, plaintext)).toBe("alice");
  });

  it("returns null for an unknown key", () => {
    const policy = policyWith({ alice: [mintKey().hash] });
    expect(principalForKey(policy, mintKey().plaintext)).toBeNull();
  });

  it("distinguishes among multiple principals", () => {
    const a = mintKey();
    const b = mintKey();
    const policy = policyWith({ alice: [a.hash], bob: [b.hash] });
    expect(principalForKey(policy, a.plaintext)).toBe("alice");
    expect(principalForKey(policy, b.plaintext)).toBe("bob");
  });

  it("matches any of a principal's multiple keys", () => {
    const a1 = mintKey();
    const a2 = mintKey();
    const policy = policyWith({ alice: [a1.hash, a2.hash] });
    expect(principalForKey(policy, a1.plaintext)).toBe("alice");
    expect(principalForKey(policy, a2.plaintext)).toBe("alice");
  });
});

describe("bearerToken", () => {
  it("extracts a bearer token", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
  });

  it("is case-insensitive on the scheme", () => {
    expect(bearerToken("bearer xyz")).toBe("xyz");
    expect(bearerToken("BEARER xyz")).toBe("xyz");
  });

  it("returns null for a missing or non-bearer header", () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
