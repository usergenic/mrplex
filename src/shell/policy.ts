/**
 * Policy + entitlement — auth-shell plan §1, §3, WS1.
 *
 * The shell's one stable internal seam is the compiled `Entitlement`: every
 * authn front, whatever its mechanism (API key today, OIDC tomorrow, capability
 * token someday), resolves a credential to a principal id and then to this
 * tuple, and the guard consumes *only* this tuple. Neither side knows the other
 * exists.
 *
 * A declarative YAML policy file names principals, roles, and grants. A
 * **grant** — `{ repo, read?, write? }` — is the human-facing vocabulary: it
 * pairs a repo pattern with path globs per direction. `compile()` splits each
 * grant into the entitlement's two `ScopeClaim` lists — read globs feed
 * `Entitlement.read` (forwarded to the engine as `ctx.scope`), write globs feed
 * `Entitlement.write` (enforced BY THE SHELL against write-op paths). One glob
 * dialect throughout (the engine's `kernel/auth/glob.ts`), no deny rules beyond
 * `!` negation inside a list.
 *
 * `compile(policy, principalId)` is a pure function — no I/O — so it is trivially
 * unit-testable and so a future policy store (SQLite, an IdP's groups, capability
 * tokens) can replace the loader behind it without the guard or the fronts
 * noticing (plan decision 3).
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ScopeClaim } from "../kernel/context.js";

/**
 * The compiled contract the guard consumes. Fronts compile *to* it; the guard
 * reads *only* it. Stable across authn mechanisms (plan decision 2).
 */
export type Entitlement = {
  /** Identity the shell stamps on writes (`ctx.author`), derived from the credential. */
  author: string;
  /** Read visibility — forwarded verbatim as `ctx.scope`. */
  read: ScopeClaim[];
  /** Enforced BY THE SHELL against write-op target paths. */
  write: ScopeClaim[];
  /** May run repos.create/rename/delete/set_path_config/set_link_config + link mutations. */
  destructive: boolean;
  /** May supply a caller-chosen author instead of the derived one. */
  impersonate: boolean;
};

// -----------------------------------------------------------------------------
// Policy file shape (the parsed + validated YAML).
// -----------------------------------------------------------------------------

/**
 * A grant names both directions together: a repo pattern plus optional read
 * and write path globs. Omitting a direction grants nothing in it.
 */
export type Grant = {
  repo: string | string[];
  read?: string | string[];
  write?: string | string[];
};

/** A role is a grant bundle plus the two op-level booleans. */
export type Role = {
  grants: Grant[];
  destructive?: boolean;
  impersonate?: boolean;
};

/** OIDC binding — how a verified token's claims match this principal. */
export type OidcBinding = {
  email?: string;
  sub?: string;
};

export type Principal = {
  /** Static author. Required unless `oidc` is present (then derived at login). */
  author?: string;
  roles: string[];
  /** `sha256:<hex>` API-key hashes. Issuance/revocation is a diff to this file. */
  keys?: string[];
  oidc?: OidcBinding;
};

export type Policy = {
  roles: Record<string, Role>;
  principals: Record<string, Principal>;
};

/**
 * A policy-file or compile error. Distinct from `KernelError` — this is a
 * startup/config fault (or an operator's `policy check`), not a per-call
 * outcome handed back to an untrusted client.
 */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

// -----------------------------------------------------------------------------
// Parse + validate.
// -----------------------------------------------------------------------------

const isString = (v: unknown): v is string => typeof v === "string";
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isStrOrStrList = (v: unknown): v is string | string[] => isString(v) || isStringList(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse YAML policy text into a validated `Policy`. Uses the `yaml` package's
 * default core-schema parse (YAML 1.2 — no 1.1 implicit-typing footguns), then
 * checks structure with precise, path-prefixed errors. Throws `PolicyError`.
 */
export function parsePolicy(text: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new PolicyError(`policy is not valid YAML: ${(err as Error).message}`);
  }
  if (!isObject(raw)) {
    throw new PolicyError("policy must be a mapping with `roles` and `principals`");
  }
  const roles = validateRoles(raw.roles);
  const principals = validatePrincipals(raw.principals, roles);
  return { roles, principals };
}

/** Read + parse + validate a policy file. Throws `PolicyError` on any fault. */
export function loadPolicyFile(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new PolicyError(`cannot read policy file ${path}: ${(err as Error).message}`);
  }
  return parsePolicy(text);
}

function validateGrant(g: unknown, where: string): Grant {
  if (!isObject(g)) throw new PolicyError(`${where} must be a mapping`);
  if (!isStrOrStrList(g.repo)) {
    throw new PolicyError(`${where}.repo must be a string or string[]`);
  }
  if (g.read !== undefined && !isStrOrStrList(g.read)) {
    throw new PolicyError(`${where}.read must be a string or string[]`);
  }
  if (g.write !== undefined && !isStrOrStrList(g.write)) {
    throw new PolicyError(`${where}.write must be a string or string[]`);
  }
  const grant: Grant = { repo: g.repo };
  if (g.read !== undefined) grant.read = g.read;
  if (g.write !== undefined) grant.write = g.write;
  return grant;
}

function validateRoles(raw: unknown): Record<string, Role> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new PolicyError("`roles` must be a mapping of role name → role");
  const roles: Record<string, Role> = {};
  for (const [name, value] of Object.entries(raw)) {
    const where = `roles.${name}`;
    if (!isObject(value)) throw new PolicyError(`${where} must be a mapping`);
    if (value.grants !== undefined && !Array.isArray(value.grants)) {
      throw new PolicyError(`${where}.grants must be a list`);
    }
    const grantsRaw = (value.grants ?? []) as unknown[];
    const grants = grantsRaw.map((g, i) => validateGrant(g, `${where}.grants[${i}]`));
    if (value.destructive !== undefined && typeof value.destructive !== "boolean") {
      throw new PolicyError(`${where}.destructive must be a boolean`);
    }
    if (value.impersonate !== undefined && typeof value.impersonate !== "boolean") {
      throw new PolicyError(`${where}.impersonate must be a boolean`);
    }
    const role: Role = { grants };
    if (value.destructive !== undefined) role.destructive = value.destructive;
    if (value.impersonate !== undefined) role.impersonate = value.impersonate;
    roles[name] = role;
  }
  return roles;
}

function validatePrincipals(raw: unknown, roles: Record<string, Role>): Record<string, Principal> {
  if (!isObject(raw)) {
    throw new PolicyError("`principals` must be a mapping of principal id → principal");
  }
  const principals: Record<string, Principal> = {};
  for (const [id, value] of Object.entries(raw)) {
    const where = `principals.${id}`;
    if (!isObject(value)) throw new PolicyError(`${where} must be a mapping`);
    if (value.author !== undefined && !isString(value.author)) {
      throw new PolicyError(`${where}.author must be a string`);
    }
    if (!isStringList(value.roles)) {
      throw new PolicyError(`${where}.roles must be a list of role names`);
    }
    for (const r of value.roles) {
      if (!(r in roles)) {
        throw new PolicyError(`${where}.roles references unknown role "${r}"`);
      }
    }
    if (value.keys !== undefined && !isStringList(value.keys)) {
      throw new PolicyError(`${where}.keys must be a list of "sha256:<hex>" strings`);
    }
    for (const k of value.keys ?? []) {
      if (!/^sha256:[0-9a-f]{64}$/.test(k)) {
        throw new PolicyError(`${where}.keys entry "${k}" must be "sha256:<64 hex chars>"`);
      }
    }
    let oidc: OidcBinding | undefined;
    if (value.oidc !== undefined) {
      if (!isObject(value.oidc)) throw new PolicyError(`${where}.oidc must be a mapping`);
      if (value.oidc.email !== undefined && !isString(value.oidc.email)) {
        throw new PolicyError(`${where}.oidc.email must be a string`);
      }
      if (value.oidc.sub !== undefined && !isString(value.oidc.sub)) {
        throw new PolicyError(`${where}.oidc.sub must be a string`);
      }
      oidc = {};
      if (value.oidc.email !== undefined) oidc.email = value.oidc.email;
      if (value.oidc.sub !== undefined) oidc.sub = value.oidc.sub;
    }
    // A principal must have an author to stamp writes with, OR an OIDC binding
    // that lets one be derived from claims at login (plan §3). A key-only
    // principal with no author has no identity to attribute — reject it here,
    // where the operator can see it, rather than stamping the engine default.
    if (value.author === undefined && oidc === undefined) {
      throw new PolicyError(`${where} needs an \`author\` or an \`oidc\` binding to derive one`);
    }
    const principal: Principal = { roles: value.roles };
    if (value.author !== undefined) principal.author = value.author;
    if (value.keys !== undefined) principal.keys = value.keys;
    if (oidc !== undefined) principal.oidc = oidc;
    principals[id] = principal;
  }
  return principals;
}

// -----------------------------------------------------------------------------
// Compile — the pure policy-evaluation function.
// -----------------------------------------------------------------------------

/**
 * Resolve a principal to its `Entitlement` — the union of its roles' grants and
 * op booleans. Pure: no I/O, no clock, no globals. A principal's read/write
 * claim lists are the concatenation of every role's grants (union semantics,
 * §8.2); `destructive`/`impersonate` are OR'd across roles.
 *
 * `author` is `principal.author` when set. For an OIDC principal with no static
 * author, the front derives `name <email>` from claims and passes it as
 * `derivedAuthor`. If neither is available, this throws — a write with no
 * attributable author is never stamped with the engine default here.
 */
export function compile(policy: Policy, principalId: string, derivedAuthor?: string): Entitlement {
  const principal = policy.principals[principalId];
  if (!principal) {
    throw new PolicyError(`unknown principal "${principalId}"`);
  }
  const read: ScopeClaim[] = [];
  const write: ScopeClaim[] = [];
  let destructive = false;
  let impersonate = false;
  for (const roleName of principal.roles) {
    const role = policy.roles[roleName];
    // validatePrincipals already checked role existence; guard anyway so a
    // hand-built Policy object can't slip an unknown role past compile.
    if (!role)
      throw new PolicyError(`principal "${principalId}" references unknown role "${roleName}"`);
    if (role.destructive) destructive = true;
    if (role.impersonate) impersonate = true;
    for (const grant of role.grants) {
      if (grant.read !== undefined) read.push({ repo: grant.repo, paths: grant.read });
      if (grant.write !== undefined) write.push({ repo: grant.repo, paths: grant.write });
    }
  }
  const author = principal.author ?? derivedAuthor;
  if (author === undefined) {
    throw new PolicyError(
      `principal "${principalId}" has no static author and none was derived (OIDC login supplies it)`,
    );
  }
  return { author, read, write, destructive, impersonate };
}
