/**
 * stdio launcher — auth-shell plan §1 "Launcher mode: stdio", WS4.
 *
 * `mrplex mcp-stdio` runs an in-process stdio MCP session over a GUARDED
 * kernel. stdio has no HTTP layer, so the credential arrives one of three ways
 * (the MCP spec's own guidance for stdio is credentials-from-environment):
 *
 *   1. `--principal <id>` — trust-by-spawn, no credential: the parent chose to
 *      spawn us (local dev, or a gateway that already authenticated).
 *   2. `MRPLEX_SHELL_KEY` env / `--key` — an API key, verified against the
 *      policy file exactly as the HTTP front does.
 *   3. `MRPLEX_SHELL_TOKEN` env / `--token` — an OAuth access token (WS5).
 *
 * All three converge on the same `credential → principal → compile() →
 * guardKernel` pipeline; stdio is only special in how the credential arrives.
 */

import type { Kernel } from "../kernel/kernel.js";
import { type StdioMount, startMcpStdio } from "../mcp/server.js";
import { type AuditSink, guardKernel } from "./guard.js";
import { principalForKey } from "./keys.js";
import { type OidcVerifier, resolvePrincipalFromClaims } from "./oidc.js";
import { type Policy, compile } from "./policy.js";

export type StdioCredential =
  | { kind: "principal"; id: string }
  | { kind: "key"; key: string }
  | { kind: "token"; token: string };

/** A resolved stdio caller: which principal, plus a derived author for tokens. */
export type StdioResolution = { principalId: string; derivedAuthor?: string };

/**
 * Resolve a stdio credential to a principal against the policy, or throw a
 * clear error. `--principal` is trust-by-spawn (the id must exist, no secret
 * checked); a key is verified by hash; a token is verified as a JWT (requires
 * an OIDC verifier) and matched to a principal by its oidc binding.
 */
export async function resolveCredential(
  policy: Policy,
  cred: StdioCredential,
  oidc?: OidcVerifier,
): Promise<StdioResolution> {
  if (cred.kind === "principal") {
    if (!(cred.id in policy.principals)) {
      throw new Error(`--principal "${cred.id}" is not defined in the policy file`);
    }
    return { principalId: cred.id };
  }
  if (cred.kind === "key") {
    const id = principalForKey(policy, cred.key);
    if (id === null) throw new Error("MRPLEX_SHELL_KEY / --key does not match any principal");
    return { principalId: id };
  }
  // token
  if (oidc === undefined) {
    throw new Error("a token credential requires OIDC configuration (issuer/audience)");
  }
  const claims = await oidc.verify(cred.token);
  const { principalId, author } = resolvePrincipalFromClaims(policy, claims);
  return { principalId, derivedAuthor: author };
}

/**
 * Start a guarded stdio MCP session. Resolves the credential to a principal,
 * compiles its entitlement, wraps the kernel in the guard (+ optional audit),
 * and hands the guarded kernel to the shared stdio transport.
 */
export async function startShellStdio(config: {
  kernel: Kernel;
  policy: Policy;
  credential: StdioCredential;
  oidc?: OidcVerifier;
  auditSinkFor?: (principal: string) => AuditSink;
}): Promise<StdioMount> {
  const { principalId, derivedAuthor } = await resolveCredential(
    config.policy,
    config.credential,
    config.oidc,
  );
  const entitlement = compile(config.policy, principalId, derivedAuthor);
  const audit = config.auditSinkFor?.(principalId);
  const guarded = guardKernel(config.kernel, entitlement, audit);
  // The guard derives author + read scope from the entitlement, so no launch-
  // time CallContext is needed — pass none.
  return startMcpStdio({ kernel: guarded });
}
