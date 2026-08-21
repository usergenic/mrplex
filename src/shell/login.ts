/**
 * OAuth device-authorization login — auth-shell plan §1 (login), WS5.
 *
 * `mrplex login` runs the OAuth 2.0 **device authorization flow** (RFC 8628):
 * request a device+user code, show the user a URL and code to enter, then poll
 * the token endpoint until they approve. The resulting access + refresh tokens
 * are cached under the config dir (mode 600); `mcp-stdio` uses the cached
 * access token when no explicit credential is given, and refreshes it mid-
 * session (recompiling the entitlement on refresh, so long-lived agent sessions
 * neither die at token expiry nor outlive a policy change indefinitely).
 *
 * The IdP is the authorization server; mrplex is only the resource server, so
 * this file speaks the standard endpoints and stores tokens — it verifies
 * nothing (that's oidc.ts, on the serving side).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DeviceFlowConfig = {
  /** OAuth device-authorization endpoint. */
  deviceAuthorizationEndpoint: string;
  /** OAuth token endpoint. */
  tokenEndpoint: string;
  clientId: string;
  /** Space-delimited scopes (e.g. "openid email profile offline_access"). */
  scope?: string;
};

export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  /** Absolute expiry (epoch ms), computed from `expires_in` at grant time. */
  expires_at?: number;
  token_type?: string;
};

type DeviceAuthResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in: number;
};

/** Where the token cache lives — `${XDG_CONFIG_HOME}/mrplex/token.json`. */
export function tokenCachePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "mrplex", "token.json");
}

export function loadTokenSet(): TokenSet | null {
  try {
    return JSON.parse(readFileSync(tokenCachePath(), "utf8")) as TokenSet;
  } catch {
    return null;
  }
}

export function saveTokenSet(tokens: TokenSet): void {
  const path = tokenCachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // POSIX mode unsupported (Windows) — best-effort.
  }
}

/** A token is fresh if it exists and isn't within `skewMs` of expiry. */
export function isFresh(tokens: TokenSet, skewMs = 30_000): boolean {
  if (tokens.expires_at === undefined) return true; // no expiry info → assume usable
  return Date.now() + skewMs < tokens.expires_at;
}

function toTokenSet(raw: Record<string, unknown>): TokenSet {
  const set: TokenSet = { access_token: String(raw.access_token) };
  if (typeof raw.refresh_token === "string") set.refresh_token = raw.refresh_token;
  if (typeof raw.token_type === "string") set.token_type = raw.token_type;
  if (typeof raw.expires_in === "number") set.expires_at = Date.now() + raw.expires_in * 1000;
  return set;
}

/**
 * Run the device flow to completion. Prompts via `prompt` (defaults to stderr),
 * polls the token endpoint honoring `interval` and `slow_down`, and returns the
 * granted token set. Throws on denial, expiry, or endpoint error.
 */
export async function deviceFlowLogin(
  config: DeviceFlowConfig,
  prompt: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Promise<TokenSet> {
  const authResp = await postForm(config.deviceAuthorizationEndpoint, {
    client_id: config.clientId,
    scope: config.scope ?? "openid email profile offline_access",
  });
  if (!authResp.ok) {
    throw new Error(`device authorization failed: HTTP ${authResp.status}`);
  }
  const auth = (await authResp.json()) as DeviceAuthResponse;
  const uri = auth.verification_uri_complete ?? auth.verification_uri;
  prompt(`To sign in, visit:\n  ${uri}\nand enter code:  ${auth.user_code}`);

  let intervalMs = (auth.interval ?? 5) * 1000;
  const deadline = Date.now() + auth.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const tokenResp = await postForm(config.tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: auth.device_code,
      client_id: config.clientId,
    });
    const body = (await tokenResp.json()) as Record<string, unknown>;
    if (tokenResp.ok) return toTokenSet(body);
    // Standard device-flow polling errors (RFC 8628 §3.5).
    const error = String(body.error ?? "");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(`device token request failed: ${error || `HTTP ${tokenResp.status}`}`);
  }
  throw new Error("device flow timed out before the user approved");
}

/**
 * Exchange a refresh token for a fresh access token. Returns the new token set,
 * carrying the refresh token forward if the IdP didn't rotate it.
 */
export async function refreshTokens(
  config: Pick<DeviceFlowConfig, "tokenEndpoint" | "clientId">,
  refreshToken: string,
): Promise<TokenSet> {
  const resp = await postForm(config.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  const body = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    throw new Error(`token refresh failed: ${String(body.error ?? `HTTP ${resp.status}`)}`);
  }
  const next = toTokenSet(body);
  if (next.refresh_token === undefined) next.refresh_token = refreshToken;
  return next;
}

function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
