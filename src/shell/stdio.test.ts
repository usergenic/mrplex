/**
 * stdio launcher credential resolution — auth-shell plan WS4. The guarded
 * session itself is guardKernel (tested in guard.test.ts) composed with the
 * shared stdio transport; here we test the credential→principal step that is
 * unique to this front.
 */

import { describe, expect, it } from "vitest";
import { mintKey } from "./keys.js";
import { parsePolicy } from "./policy.js";
import { resolveCredential } from "./stdio.js";

const key = mintKey();
const policy = parsePolicy(`
roles:
  reader:
    grants:
      - { repo: "*", read: "**" }
principals:
  alice:
    author: Alice <alice@example.com>
    roles: [reader]
    keys:
      - ${key.hash}
  bob:
    author: Bob <bob@example.com>
    roles: [reader]
`);

describe("resolveCredential", () => {
  it("resolves --principal trust-by-spawn when the id exists", async () => {
    expect(await resolveCredential(policy, { kind: "principal", id: "bob" })).toEqual({
      principalId: "bob",
    });
  });

  it("rejects an unknown --principal", async () => {
    await expect(resolveCredential(policy, { kind: "principal", id: "ghost" })).rejects.toThrow(
      /not defined/,
    );
  });

  it("resolves a valid key to its principal", async () => {
    expect(await resolveCredential(policy, { kind: "key", key: key.plaintext })).toEqual({
      principalId: "alice",
    });
  });

  it("rejects an unknown key", async () => {
    await expect(
      resolveCredential(policy, { kind: "key", key: mintKey().plaintext }),
    ).rejects.toThrow(/does not match/);
  });

  it("rejects a token credential without an OIDC verifier", async () => {
    await expect(resolveCredential(policy, { kind: "token", token: "x.y.z" })).rejects.toThrow(
      /requires OIDC/,
    );
  });
});
