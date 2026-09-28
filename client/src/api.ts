/**
 * Standalone API shim — replaces the Muse `@hatch/space-sdk` client proxy.
 *
 * The original app called `api.<actionName>(args)` and the SDK serialized
 * those calls into the host. Here the same shape is kept: every property
 * access becomes a POST to /actions, validated server-side by zod schemas.
 *
 * The import of `Actions` is type-only, so no server code lands in the
 * browser bundle — only the action names and their request/response types.
 */
import type { Actions } from "../../server/src/actions";

export type ActionName = keyof typeof Actions;

export type ActionCallMap = {
  [K in ActionName]: (
    args: Parameters<(typeof Actions)[K]["handler"]>[1],
  ) => ReturnType<(typeof Actions)[K]["handler"]>;
};

/**
 * Response type of an action, e.g.
 * `type Workspace = ApiResponse<typeof api, "getWorkspace">`.
 * Mirrors the SDK's `ApiResponse` helper the original app used.
 */
export type ApiResponse<TApi extends object, TName extends keyof TApi> =
  TApi[TName] extends (...args: never[]) => infer R ? Awaited<R> : never;

async function callAction(name: string, args: unknown): Promise<unknown> {
  const res = await fetch("/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name, args: args ?? {} }),
  });
  if (!res.ok) {
    throw new Error(`Action "${name}" failed with HTTP ${res.status}.`);
  }
  return res.json();
}

export const api = new Proxy(
  {},
  {
    get(_target, name: string) {
      return (args?: unknown) => callAction(name, args ?? {});
    },
  },
) as ActionCallMap;
