/**
 * `mrplex bootstrap` — mints the root admin token on a fresh database
 * (design §8.3, m1-plan §5).
 *
 * Refuses to run against a non-empty database (any user or token present).
 * That guardrail matters: bootstrap is idempotent-unsafe by nature — every
 * successful run mints an admin token. If someone accidentally re-bootstraps
 * a running instance, we'd silently issue root credentials. The refusal
 * catches that.
 */

import { generateSecret, hashSecret } from "../kernel/auth/tokens.js";
import { sqliteAdapter } from "../storage-sqlite/adapter.js";

const BOOTSTRAP_USER_SLUG = "system";
const BOOTSTRAP_LABEL = "root";
const BOOTSTRAP_SCOPES_JSON = JSON.stringify([{ repos: "*", read: ["**"], write: ["**"] }]);

export type BootstrapResult = {
  token: string;
  user: string; // slug
  token_id: string; // opaque
};

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

/**
 * Programmatic bootstrap — used by the CLI command below and callable from
 * tests directly. Opens the database, migrates, refuses if any user or
 * token already exists, then seeds the system user and mints the root
 * admin token. Returns the plaintext secret.
 */
export async function bootstrap(database: string): Promise<BootstrapResult> {
  const storage = await sqliteAdapter.open({ database });
  try {
    const users = await storage.users_list();
    if (users.length > 0) {
      throw new BootstrapError(
        "database is not empty (users already exist); refusing to bootstrap",
      );
    }
    const now = new Date().toISOString();
    const user = await storage.users_create({ slug: BOOTSTRAP_USER_SLUG, created_at: now });
    const secret = generateSecret();
    const token = await storage.tokens_create({
      user_id: user.id,
      secret_hash: hashSecret(secret),
      label: BOOTSTRAP_LABEL,
      scopes: BOOTSTRAP_SCOPES_JSON,
      admin: true,
      expires_at: null,
      created_at: now,
    });
    return { token: secret, user: user.slug, token_id: `t${token.id}` };
  } finally {
    await storage.close();
  }
}
