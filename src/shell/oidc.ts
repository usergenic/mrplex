/**
 * OIDC verification — auth-shell plan §1 (authn front 2), WS5.
 *
 * Verify a caller's JWT against the IdP's JWKS (issuer + audience pinned in
 * shell config), then match the verified claims to a policy principal by its
 * `oidc.sub` / `oidc.email` binding. Where the matched principal has no static
 * `author`, derive one from the token as `name <email>` — the convention and
 * the credential line up by construction (plan §3).
 *
 * Shared by the HTTP front and `mcp-stdio`'s `MRPLEX_SHELL_TOKEN` front: both
 * hand a bearer JWT here and get back a principal id + author. The shell is the
 * OAuth *resource server*; the authorization-server role belongs entirely to
 * the IdP (this is also the on-ramp to MCP's OAuth 2.1 story).
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Policy } from "./policy.js";

export type OidcConfig = {
  /** Pinned issuer (`iss` claim must match). */
  issuer: string;
  /** Pinned audience (`aud` claim must include this). */
  audience: string;
  /** JWKS endpoint URL. Defaults to `${issuer}/.well-known/jwks.json` if absent. */
  jwksUri?: string;
};

/** The subset of verified claims the shell binds/derives identity from. */
export type VerifiedClaims = {
  sub: string;
  email?: string;
  /** OIDC `email_verified` — whether the IdP has verified ownership of `email`. */
  email_verified?: boolean;
  name?: string;
};

/** Resolution of a verified token: which principal, and the author to stamp. */
export type OidcResolution = {
  principalId: string;
  author: string;
};

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcError";
  }
}

/**
 * A verifier bound to one IdP. Construction sets up the (cached, auto-rotating)
 * remote JWKS; `verify()` checks a token and returns its claims. Kept as a
 * factory so the JWKS fetcher is created once and reused across requests.
 */
export type OidcVerifier = {
  verify: (jwt: string) => Promise<VerifiedClaims>;
};

export function createOidcVerifier(config: OidcConfig): OidcVerifier {
  const jwksUri = config.jwksUri ?? `${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  return {
    verify: async (jwt: string): Promise<VerifiedClaims> => {
      let payload: Record<string, unknown>;
      try {
        const result = await jwtVerify(jwt, jwks, {
          issuer: config.issuer,
          audience: config.audience,
        });
        payload = result.payload as Record<string, unknown>;
      } catch (err) {
        throw new OidcError(`token verification failed: ${(err as Error).message}`);
      }
      const sub = payload.sub;
      if (typeof sub !== "string" || sub.length === 0) {
        throw new OidcError("token has no `sub` claim");
      }
      const claims: VerifiedClaims = { sub };
      if (typeof payload.email === "string") claims.email = payload.email;
      // Some IdPs emit email_verified as the string "true"/"false"; accept both.
      if (typeof payload.email_verified === "boolean") {
        claims.email_verified = payload.email_verified;
      } else if (payload.email_verified === "true" || payload.email_verified === "false") {
        claims.email_verified = payload.email_verified === "true";
      }
      if (typeof payload.name === "string") claims.name = payload.name;
      return claims;
    },
  };
}

/**
 * Match verified claims to a policy principal and resolve the author. A
 * principal binds via `oidc.sub` (exact) or `oidc.email` (exact); `sub` wins
 * when both could match. The author is the principal's static `author` if set,
 * else derived as `${name} <${email}>` (or just `<email>` when the token
 * carries no display name). Throws `OidcError` when no principal binds or no
 * author can be formed.
 *
 * Email binding requires `email_verified === true`: an IdP that lets a user set
 * an arbitrary unverified `email` (or exposes federated emails without
 * re-verification) would otherwise let a hostile user claim another principal's
 * grants. `sub` binding is unaffected — it's issuer-namespaced and IdP-controlled.
 */
export function resolvePrincipalFromClaims(policy: Policy, claims: VerifiedClaims): OidcResolution {
  let matchBySub: string | undefined;
  let matchByEmail: string | undefined;
  const emailUsable = claims.email !== undefined && claims.email_verified === true;
  for (const [id, principal] of Object.entries(policy.principals)) {
    const binding = principal.oidc;
    if (!binding) continue;
    if (binding.sub !== undefined && binding.sub === claims.sub) matchBySub = id;
    if (emailUsable && binding.email !== undefined && binding.email === claims.email) {
      matchByEmail = id;
    }
  }
  const principalId = matchBySub ?? matchByEmail;
  if (principalId === undefined) {
    throw new OidcError("no policy principal binds this token's sub/email");
  }
  const principal = policy.principals[principalId];
  const author = principal?.author ?? deriveAuthor(claims);
  if (author === undefined) {
    throw new OidcError(
      `principal "${principalId}" has no static author and the token carries no email to derive one`,
    );
  }
  return { principalId, author };
}

/** `name <email>` / `<email>` from claims, or undefined when there's no email. */
function deriveAuthor(claims: VerifiedClaims): string | undefined {
  if (claims.email === undefined) return undefined;
  return claims.name !== undefined ? `${claims.name} <${claims.email}>` : `<${claims.email}>`;
}
