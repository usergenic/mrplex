/**
 * OIDC verification + claim binding — auth-shell plan WS5. We generate a local
 * RSA keypair with jose, sign real JWTs, and stand up an in-process JWKS
 * endpoint so verify() exercises the true code path (issuer/audience checks,
 * signature verification) without a live IdP.
 */

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OidcError, createOidcVerifier, resolvePrincipalFromClaims } from "./oidc.js";
import { parsePolicy } from "./policy.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "mrplex";

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwksServer: Server;
let jwksUri: string;

async function mint(
  claims: Record<string, unknown>,
  over: { aud?: string; iss?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
  privateKey = priv;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  jwksServer = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const port = (jwksServer.address() as AddressInfo).port;
  jwksUri = `http://127.0.0.1:${port}/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

describe("createOidcVerifier.verify", () => {
  it("verifies a well-formed token and returns its claims", async () => {
    const verifier = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const jwt = await mint({ sub: "abc", email: "a@example.com", name: "Ann" });
    const claims = await verifier.verify(jwt);
    expect(claims).toEqual({ sub: "abc", email: "a@example.com", name: "Ann" });
  });

  it("rejects a token with the wrong audience", async () => {
    const verifier = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const jwt = await mint({ sub: "abc" }, { aud: "someone-else" });
    await expect(verifier.verify(jwt)).rejects.toBeInstanceOf(OidcError);
  });

  it("rejects a token from the wrong issuer", async () => {
    const verifier = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    const jwt = await mint({ sub: "abc" }, { iss: "https://evil.example.com" });
    await expect(verifier.verify(jwt)).rejects.toBeInstanceOf(OidcError);
  });

  it("rejects a garbage token", async () => {
    const verifier = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
    await expect(verifier.verify("not.a.jwt")).rejects.toBeInstanceOf(OidcError);
  });
});

describe("resolvePrincipalFromClaims", () => {
  const policy = parsePolicy(`
roles:
  reader: { grants: [ { repo: "*", read: "**" } ] }
principals:
  by-sub:
    author: Sub Bound <sub@example.com>
    roles: [reader]
    oidc: { sub: "sub-123" }
  by-email:
    roles: [reader]
    oidc: { email: derive@example.com }
`);

  it("binds by sub and uses the static author", () => {
    const r = resolvePrincipalFromClaims(policy, { sub: "sub-123" });
    expect(r).toEqual({ principalId: "by-sub", author: "Sub Bound <sub@example.com>" });
  });

  it("binds by email and derives the author from claims", () => {
    const r = resolvePrincipalFromClaims(policy, {
      sub: "whatever",
      email: "derive@example.com",
      name: "Dee",
    });
    expect(r).toEqual({ principalId: "by-email", author: "Dee <derive@example.com>" });
  });

  it("derives a name-less author as <email>", () => {
    const r = resolvePrincipalFromClaims(policy, { sub: "x", email: "derive@example.com" });
    expect(r.author).toBe("<derive@example.com>");
  });

  it("prefers a sub match over an email match", () => {
    const r = resolvePrincipalFromClaims(policy, { sub: "sub-123", email: "derive@example.com" });
    expect(r.principalId).toBe("by-sub");
  });

  it("throws when no principal binds", () => {
    expect(() => resolvePrincipalFromClaims(policy, { sub: "nobody" })).toThrow(OidcError);
  });
});
