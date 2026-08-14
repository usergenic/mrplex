/**
 * The kernel `authorize()` check — design §8.2.
 *
 * WS4 (this milestone) leaves the check as an allow-all body: every M0
 * caller stays green, the M0-boundary invariant "authorize() is called at
 * every op" survives, and WS5 replaces the body with real scope evaluation.
 * We deliberately keep `authorize.ts` a single-function file so the WS5 diff
 * is contained.
 */

import type { Action, Actor, Target } from "./actor.js";

export function authorize(_actor: Actor, _action: Action, _target: Target): void {
  // WS5 replaces this body with real scope + admin evaluation.
}
