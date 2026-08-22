/**
 * Embedded shell serve with the OIDC front, end-to-end — auth-shell plan WS5.
 * A real HTTP server whose policy binds a principal by OIDC claim; requests
 * carry a real RS256 JWT verified against an in-process JWKS. Proves the JWT →
 * claims → principal → entitlement → guarded kernel path over the wire, plus
 * derived-author stamping.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOidcVerifier } from "./oidc.js";
import { type ShellServeHandle, startShellServer } from "./serve.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "mrplex";

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwksServer: Server;
let jwksUri: string;

async function mintJwt(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
  privateKey = priv;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwksServer = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

let dir: string;
let handle: ShellServeHandle;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mrplex-serve-oidc-"));
  const policyPath = join(dir, "policy.yaml");
  writeFileSync(
    policyPath,
    `
roles:
  editor:
    grants:
      - repo: notes
        read: "**"
        write: ["drafts/**"]
principals:
  ann:
    roles: [editor]
    oidc: { email: ann@example.com }
`,
  );
  handle = await startShellServer({
    database: `sqlite:${join(dir, "mrplex.db")}`,
    policyPath,
    host: "127.0.0.1",
    port: 0,
    oidc: createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri }),
    log: () => {},
  });
  base = handle.baseUrl;
  await handle.kernel.repos.create({}, "notes");
});

afterEach(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function req(
  method: string,
  path: string,
  jwt: string,
  opts: { body?: string; create?: boolean } = {},
) {
  const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` };
  if (opts.create) {
    headers["If-None-Match"] = "*";
    headers["Content-Type"] = "text/markdown";
  }
  return fetch(`${base}${path}`, { method, headers, body: opts.body });
}

describe("OIDC front over the wire", () => {
  it("rejects a bearer that is neither a key nor a valid JWT", async () => {
    expect((await req("GET", "/repos", "garbage")).status).toBe(401);
  });

  it("authenticates a valid JWT bound by email", async () => {
    const jwt = await mintJwt({
      sub: "auth0|ann",
      email: "ann@example.com",
      email_verified: true,
      name: "Ann",
    });
    expect((await req("GET", "/repos", jwt)).status).toBe(200);
  });

  it("stamps the author derived from the token claims", async () => {
    const jwt = await mintJwt({
      sub: "auth0|ann",
      email: "ann@example.com",
      email_verified: true,
      name: "Ann",
    });
    const r = await req("PUT", "/repos/notes/docs/drafts/x.md", jwt, { body: "hi", create: true });
    expect(r.status).toBe(201);
    const v = (await r.json()) as { author: string };
    expect(v.author).toBe("Ann <ann@example.com>");
  });

  it("enforces the bound principal's write scope", async () => {
    const jwt = await mintJwt({
      sub: "auth0|ann",
      email: "ann@example.com",
      email_verified: true,
      name: "Ann",
    });
    const r = await req("PUT", "/repos/notes/docs/published/x.md", jwt, {
      body: "hi",
      create: true,
    });
    expect(r.status).toBe(403);
  });

  it("401s a token whose email binds no principal", async () => {
    const jwt = await mintJwt({ sub: "auth0|stranger", email: "stranger@example.com" });
    expect((await req("GET", "/repos", jwt)).status).toBe(401);
  });
});
