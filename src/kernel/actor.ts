/**
 * Actor / authorization stub. Design §6.1 threads `actor` through every kernel
 * op and design §8 calls `authorize(actor, action, target)` before doing the
 * work. In M0 authorize() is allow-all — but the plumbing exists so M1 auth
 * drops into the call sites we already have.
 */

export type Actor = {
  user_id: number;
  scopes: unknown[]; // shape lands with M1
  admin: boolean;
};

export type Action = "read" | "write" | "admin";

export type Target =
  | { kind: "repo"; slug: string }
  | { kind: "path"; repo: string; path: string }
  | { kind: "server" };

/**
 * M0 stub: allow anything. M1 replaces this with real scope evaluation.
 */
export function authorize(_actor: Actor, _action: Action, _target: Target): void {
  // no-op
}

export const SYSTEM_ACTOR: Actor = {
  user_id: 0,
  scopes: [],
  admin: true,
};
