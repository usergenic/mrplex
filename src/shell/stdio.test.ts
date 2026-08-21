/**
 * stdio launcher credential resolution — auth-shell plan WS4. The guarded
 * session itself is guardKernel (tested in guard.test.ts) composed with the
 * shared stdio transport; here we test the credential→principal step that is
 * unique to this front.
 */

import { describe, expect, it } from "vitest";
import { mintKey } from "./keys.js";
import { parsePolicy } from "./policy.js";
import { principalForCredential } from "./stdio.js";

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

describe("principalForCredential", () => {
  it("resolves --principal trust-by-spawn when the id exists", () => {
    expect(principalForCredential(policy, { kind: "principal", id: "bob" })).toBe("bob");
  });

  it("rejects an unknown --principal", () => {
    expect(() => principalForCredential(policy, { kind: "principal", id: "ghost" })).toThrow(
      /not defined/,
    );
  });

  it("resolves a valid key to its principal", () => {
    expect(principalForCredential(policy, { kind: "key", key: key.plaintext })).toBe("alice");
  });

  it("rejects an unknown key", () => {
    expect(() => principalForCredential(policy, { kind: "key", key: mintKey().plaintext })).toThrow(
      /does not match/,
    );
  });
});
