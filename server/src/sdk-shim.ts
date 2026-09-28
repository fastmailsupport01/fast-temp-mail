/**
 * Standalone replacement for the `@hatch/space-sdk` server surface.
 *
 * The original Fast Temp Mail prototype ran inside Muse, where the SDK provided
 * action dispatch, the database handle, and query invalidation. Outside Muse
 * we provide the same contract with plain libraries:
 *
 * - `z` is zod (same version the app was built against).
 * - `Ctx.db()` returns a drizzle-orm database handle (PostgreSQL via
 *   postgres-js, pointed at DATABASE_URL — Supabase on the free tier).
 * - `Ctx.invalidateQueries()` is a no-op: the browser client owns its own
 *   React Query cache and refetches explicitly.
 */

import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export { z };

/** Drizzle database handle, same method subset the app uses. */
export type SpaceDb<TSchema extends Record<string, unknown> = Record<string, never>> = Pick<
  PostgresJsDatabase<TSchema>,
  "select" | "insert" | "update" | "delete" | "execute"
>;

/** Per-request context passed to every action handler. */
export interface Ctx {
  readonly db: <TSchema extends Record<string, unknown> = Record<string, never>>() => SpaceDb<TSchema>;
  /** No-op outside Muse; the browser client manages its own query cache. */
  readonly invalidateQueries: () => void;
}

export interface ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly request: Req;
  readonly response: Res;
  readonly handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(spec: {
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): ActionDefinition<Req, Res> {
  return spec;
}

/** The shape `server/src/actions.ts` must satisfy (mirrors the SDK). */
export type ActionsModule = Record<string, ActionDefinition>;
