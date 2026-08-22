/**
 * OAuth device-flow login — auth-shell plan WS5. Token cache round-trip,
 * freshness, refresh, and the device-flow polling loop driven against an
 * in-process fake OAuth server (no live IdP).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TokenSet,
  deviceFlowLogin,
  isFresh,
  loadTokenSet,
  refreshTokens,
  saveTokenSet,
  tokenCachePath,
} from "./login.js";

let dir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrplex-login-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  // delete (not = undefined) — assigning undefined would set the literal
  // string "undefined"; env vars must actually be removed.
  // biome-ignore lint/performance/noDelete: env cleanup requires real deletion
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("token cache", () => {
  it("round-trips a token set under XDG_CONFIG_HOME", () => {
    expect(tokenCachePath().startsWith(dir)).toBe(true);
    const tokens: TokenSet = { access_token: "a", refresh_token: "r", expires_at: 123 };
    saveTokenSet(tokens);
    expect(loadTokenSet()).toEqual(tokens);
  });

  it("returns null when no cache exists", () => {
    expect(loadTokenSet()).toBeNull();
  });
});

describe("isFresh", () => {
  it("is true with no expiry info", () => {
    expect(isFresh({ access_token: "a" })).toBe(true);
  });
  it("is false when within the skew of expiry", () => {
    expect(isFresh({ access_token: "a", expires_at: Date.now() + 1000 }, 30_000)).toBe(false);
  });
  it("is true when comfortably before expiry", () => {
    expect(isFresh({ access_token: "a", expires_at: Date.now() + 120_000 }, 30_000)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Fake OAuth server driving the device flow + refresh.
// -----------------------------------------------------------------------------

describe("deviceFlowLogin", () => {
  let server: Server;
  let baseUrl: string;
  let pollsUntilGrant: number;
  let deviceForm: URLSearchParams | undefined;

  beforeEach(async () => {
    pollsUntilGrant = 2;
    deviceForm = undefined;
    let polls = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const form = new URLSearchParams(body);
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/device") {
          deviceForm = form;
          res.end(
            JSON.stringify({
              device_code: "dev-code",
              user_code: "WXYZ-1234",
              verification_uri: `${baseUrl}/activate`,
              interval: 0, // no real delay in tests
              expires_in: 300,
            }),
          );
          return;
        }
        if (req.url === "/token") {
          const grant = form.get("grant_type");
          if (grant === "refresh_token") {
            res.end(JSON.stringify({ access_token: "refreshed", expires_in: 3600 }));
            return;
          }
          polls += 1;
          if (polls < pollsUntilGrant) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "authorization_pending" }));
            return;
          }
          res.end(
            JSON.stringify({
              access_token: "access-1",
              refresh_token: "refresh-1",
              expires_in: 3600,
              token_type: "Bearer",
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("polls through authorization_pending and returns the granted tokens", async () => {
    const prompts: string[] = [];
    const tokens = await deviceFlowLogin(
      {
        deviceAuthorizationEndpoint: `${baseUrl}/device`,
        tokenEndpoint: `${baseUrl}/token`,
        clientId: "cli",
      },
      (m) => prompts.push(m),
    );
    expect(tokens.access_token).toBe("access-1");
    expect(tokens.refresh_token).toBe("refresh-1");
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
    expect(prompts.join("\n")).toMatch(/WXYZ-1234/);
  });

  it("includes audience in the device-authorization request when set", async () => {
    await deviceFlowLogin(
      {
        deviceAuthorizationEndpoint: `${baseUrl}/device`,
        tokenEndpoint: `${baseUrl}/token`,
        clientId: "cli",
        audience: "https://api.example.com",
      },
      () => {},
    );
    expect(deviceForm?.get("audience")).toBe("https://api.example.com");
  });

  it("omits audience when not set", async () => {
    await deviceFlowLogin(
      {
        deviceAuthorizationEndpoint: `${baseUrl}/device`,
        tokenEndpoint: `${baseUrl}/token`,
        clientId: "cli",
      },
      () => {},
    );
    expect(deviceForm?.has("audience")).toBe(false);
  });

  it("refreshes an access token, carrying the refresh token forward", async () => {
    const next = await refreshTokens(
      { tokenEndpoint: `${baseUrl}/token`, clientId: "cli" },
      "refresh-1",
    );
    expect(next.access_token).toBe("refreshed");
    expect(next.refresh_token).toBe("refresh-1"); // IdP didn't rotate → carried forward
  });
});
