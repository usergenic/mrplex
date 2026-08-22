/**
 * Policy parse + compile — auth-shell plan WS1. compile() is pure, so these
 * are plain unit tests with no I/O. The grant→claim split and role-union
 * semantics are the load-bearing behaviors; the engine's glob dialect is
 * tested separately (kernel/auth/glob), so here we assert the SHAPE compile
 * produces, not glob matching.
 */

import { describe, expect, it } from "vitest";
import { PolicyError, compile, parsePolicy } from "./policy.js";

const SAMPLE = `
roles:
  reader:
    grants:
      - { repo: "*", read: "**" }
  editor:
    grants:
      - repo: notes
        read: "**"
        write: ["drafts/**", "inbox/**"]
  operator:
    grants:
      - { repo: "*", read: "**", write: "**" }
    destructive: true

principals:
  brendan:
    author: Brendan Baldwin <brendan@example.com>
    roles: [operator]
    keys:
      - sha256:0000000000000000000000000000000000000000000000000000000000000000
  ingest-bot:
    author: ingest-bot <bots@example.com>
    roles: [editor]
  alice:
    author: Alice <alice@example.com>
    roles: [reader, editor]
`;

describe("parsePolicy", () => {
  it("parses a well-formed policy", () => {
    const p = parsePolicy(SAMPLE);
    expect(Object.keys(p.roles).sort()).toEqual(["editor", "operator", "reader"]);
    expect(Object.keys(p.principals).sort()).toEqual(["alice", "brendan", "ingest-bot"]);
    expect(p.roles.operator?.destructive).toBe(true);
  });

  it("rejects non-YAML", () => {
    expect(() => parsePolicy(":\n:")).toThrow(PolicyError);
  });

  it("rejects a top-level scalar", () => {
    expect(() => parsePolicy("hello")).toThrow(/mapping/);
  });

  it("rejects a grant with no repo", () => {
    const t = `
roles:
  r:
    grants:
      - { read: "**" }
principals:
  a: { author: a, roles: [r] }
`;
    expect(() => parsePolicy(t)).toThrow(/grants\[0\]\.repo/);
  });

  it("rejects a principal referencing an unknown role", () => {
    const t = `
roles: {}
principals:
  a: { author: a, roles: [ghost] }
`;
    expect(() => parsePolicy(t)).toThrow(/unknown role "ghost"/);
  });

  it("rejects a malformed key hash", () => {
    const t = `
roles:
  r: { grants: [] }
principals:
  a:
    author: a
    roles: [r]
    keys: [sha256:xyz]
`;
    expect(() => parsePolicy(t)).toThrow(/sha256:<64 hex/);
  });

  it("rejects a principal with neither author nor oidc", () => {
    const t = `
roles:
  r: { grants: [] }
principals:
  a: { roles: [r] }
`;
    expect(() => parsePolicy(t)).toThrow(/author.*oidc/);
  });

  it("accepts an author-less principal with an oidc binding", () => {
    const t = `
roles:
  r: { grants: [] }
principals:
  a:
    roles: [r]
    oidc: { email: a@example.com }
`;
    const p = parsePolicy(t);
    expect(p.principals.a?.oidc?.email).toBe("a@example.com");
    expect(p.principals.a?.author).toBeUndefined();
  });

  it("rejects a non-boolean destructive", () => {
    const t = `
roles:
  r: { grants: [], destructive: yes-please }
principals:
  a: { author: a, roles: [r] }
`;
    expect(() => parsePolicy(t)).toThrow(/destructive must be a boolean/);
  });
});

describe("compile", () => {
  const policy = parsePolicy(SAMPLE);

  it("splits grants into direction-neutral read/write claim lists", () => {
    const e = compile(policy, "ingest-bot");
    expect(e.author).toBe("ingest-bot <bots@example.com>");
    expect(e.read).toEqual([{ repo: "notes", paths: "**" }]);
    expect(e.write).toEqual([{ repo: "notes", paths: ["drafts/**", "inbox/**"] }]);
    expect(e.destructive).toBe(false);
    expect(e.impersonate).toBe(false);
  });

  it("carries destructive from the operator role", () => {
    const e = compile(policy, "brendan");
    expect(e.destructive).toBe(true);
    expect(e.read).toEqual([{ repo: "*", paths: "**" }]);
    expect(e.write).toEqual([{ repo: "*", paths: "**" }]);
  });

  it("unions grants across multiple roles", () => {
    const e = compile(policy, "alice");
    // reader contributes { *, ** } read; editor contributes { notes, ** } read
    // and { notes, [drafts,inbox] } write.
    expect(e.read).toEqual([
      { repo: "*", paths: "**" },
      { repo: "notes", paths: "**" },
    ]);
    expect(e.write).toEqual([{ repo: "notes", paths: ["drafts/**", "inbox/**"] }]);
  });

  it("omits a direction the grant did not name", () => {
    // reader has read but no write → empty write list.
    const readerOnly = parsePolicy(`
roles:
  reader: { grants: [ { repo: "*", read: "**" } ] }
principals:
  r: { author: R, roles: [reader] }
`);
    const e = compile(readerOnly, "r");
    expect(e.write).toEqual([]);
    expect(e.read).toEqual([{ repo: "*", paths: "**" }]);
  });

  it("throws on an unknown principal", () => {
    expect(() => compile(policy, "nobody")).toThrow(/unknown principal/);
  });

  it("uses the derived author for an author-less OIDC principal", () => {
    const oidcPolicy = parsePolicy(`
roles:
  reader: { grants: [ { repo: "*", read: "**" } ] }
principals:
  a:
    roles: [reader]
    oidc: { email: a@example.com }
`);
    const e = compile(oidcPolicy, "a", "Ann <a@example.com>");
    expect(e.author).toBe("Ann <a@example.com>");
  });

  it("prefers a static author over a derived one", () => {
    const e = compile(policy, "brendan", "Someone Else <x@y>");
    expect(e.author).toBe("Brendan Baldwin <brendan@example.com>");
  });

  it("throws when no author can be resolved", () => {
    const oidcPolicy = parsePolicy(`
roles:
  reader: { grants: [ { repo: "*", read: "**" } ] }
principals:
  a:
    roles: [reader]
    oidc: { email: a@example.com }
`);
    expect(() => compile(oidcPolicy, "a")).toThrow(/no static author/);
  });
});
