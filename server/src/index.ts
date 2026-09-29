/**
 * Fast Temp Mail standalone server entrypoint.
 *
 * Bun.serve-based HTTP server:
 * - Boot: runs PostgreSQL migrations, seeds the admin account, Google OAuth
 *   config and plan settings from environment/defaults, then starts listening.
 * - POST /actions — JSON action dispatch: { name, args } → action result.
 *   A Zod schema violation returns HTTP 400 with the validation issues.
 * - POST /webhooks/twilio-sms — inbound SMS from Twilio (signature-verified).
 * - GET /health — liveness probe.
 * - GET /* — static files from client/dist, with SPA fallback to index.html.
 */

import { serve } from "bun";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { Actions } from "./actions";
import { getDb, runMigrations, seedAdminFromEnv, seedOAuthConfigFromEnv, seedPlanConfig } from "./db";
import * as schema from "./schema";
import { twilioSmsWebhookUrl, validateTwilioSignature } from "./sms";
import type { Ctx, SpaceDb } from "./sdk-shim";

const PORT = Number(process.env.PORT ?? "3000");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function clientDir(): string {
  const candidates = [
    resolve(import.meta.dir, "../../client/dist"),
    resolve(import.meta.dir, "../client/dist"),
    resolve(process.cwd(), "client/dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return candidates[0] ?? "";
}

const ctx: Ctx = {
  db: <TSchema extends Record<string, unknown> = Record<string, never>>(): SpaceDb<TSchema> =>
    getDb() as SpaceDb<TSchema>,
  invalidateQueries: () => {
    /* client owns its cache */
  },
};

/**
 * Inbound SMS webhook called by Twilio for each message to a rented number.
 * Twilio posts form-urlencoded fields (From, To, Body, MessageSid, ...) and
 * signs the request with X-Twilio-Signature. We verify the signature against
 * the public webhook URL before storing anything.
 */
async function handleTwilioSmsWebhook(request: Request): Promise<Response> {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  const respond = () => new Response(twiml, { headers: { "content-type": "text/xml; charset=utf-8" } });
  let params: Record<string, string> = {};
  try {
    const form = await request.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!validateTwilioSignature(signature, twilioSmsWebhookUrl(), params)) {
    console.error("[sms] rejected webhook with invalid Twilio signature");
    return new Response("Forbidden", { status: 403 });
  }
  const to = (params["To"] ?? "").trim();
  const from = (params["From"] ?? "").trim();
  const body = (params["Body"] ?? "").slice(0, 4000);
  const messageSid = (params["MessageSid"] ?? "").trim() || null;
  if (!to || !from) return respond();
  try {
    const db = ctx.db<typeof schema>();
    if (messageSid) {
      const dup = await db.select({ id: schema.smsMessages.id }).from(schema.smsMessages)
        .where(eq(schema.smsMessages.providerSid, messageSid)).limit(1);
      if (dup[0]) return respond();
    }
    const numbers = await db.select().from(schema.virtualNumbers)
      .where(and(eq(schema.virtualNumbers.phoneNumber, to), eq(schema.virtualNumbers.status, "active"))).limit(1);
    const number = numbers[0];
    if (!number) return respond();
    if (number.expiresAt.getTime() <= Date.now()) return respond();
    await db.insert(schema.smsMessages).values({
      numberId: number.id, sender: from, body, providerSid: messageSid,
      receivedAt: new Date(), isRead: false,
    });
  } catch (err) {
    console.error("[sms] failed to store inbound SMS:", err);
  }
  return respond();
}

function makeActionHandler(request: Request): Promise<Response> {
  return (async () => {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, message: "Request body must be valid JSON." }, { status: 400 });
    }
    const parsed = z
      .object({ name: z.string().min(1), args: z.record(z.string(), z.any()) })
      .safeParse(body);
    if (!parsed.success) {
      return Response.json({ ok: false, message: "Malformed action request." }, { status: 400 });
    }
    const action = (Actions as Record<string, { request: { safeParse: (a: unknown) => { success: boolean; data?: unknown; error?: unknown } }; handler: (ctx: Ctx, args: unknown) => Promise<unknown> }>)[parsed.data.name];
    if (!action) {
      return Response.json({ ok: false, message: `Unknown action "${parsed.data.name}".` }, { status: 404 });
    }
    const args = action.request.safeParse(parsed.data.args);
    if (!args.success) {
      return Response.json(
        { ok: false, message: "Invalid request data.", issues: args.error },
        { status: 400 },
      );
    }
    try {
      const result = await action.handler(ctx, args.data);
      return Response.json(result);
    } catch (err) {
      console.error(`[actions] "${parsed.data.name}" failed:`, err);
      return Response.json({ ok: false, message: "Something went wrong. Please try again." }, { status: 500 });
    }
  })();
}

function serveStatic(url: URL): Response {
  const dir = clientDir();
  const pathname = decodeURIComponent(url.pathname);
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = resolve(dir, file);
  if (!resolved.startsWith(resolve(dir))) {
    return new Response("Forbidden", { status: 403 });
  }
  if (existsSync(resolved) && !resolved.endsWith("/") && statIsFile(resolved)) {
    const ext = resolved.slice(resolved.lastIndexOf("."));
    return new Response(Bun.file(resolved), {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  }
  const fallback = join(dir, "index.html");
  if (existsSync(fallback)) {
    return new Response(Bun.file(fallback), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("Client not built. Run `bun run build` first.", { status: 503 });
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  await runMigrations();
  await seedAdminFromEnv();
  await seedOAuthConfigFromEnv();
  await seedPlanConfig();

  serve({
    port: PORT,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, service: "fasttempmail", time: new Date().toISOString() });
      }
      if (url.pathname === "/actions") {
        return makeActionHandler(request);
      }
      if (url.pathname === "/webhooks/twilio-sms") {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        return handleTwilioSmsWebhook(request);
      }
      return serveStatic(url);
    },
    error(error) {
      console.error("[server] unhandled error:", error);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  console.log(`[server] Fast Temp Mail listening on http://localhost:${PORT}`);
}

boot().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
