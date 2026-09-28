/**
 * Database bootstrap for standalone Fast Temp Mail.
 *
 * - PostgreSQL via postgres-js + drizzle-orm. `DATABASE_URL` is required —
 *   on the free tier this is the Supabase connection string (direct port
 *   5432 or the port-6543 pooler; see README).
 * - `runMigrations()` applies `drizzle/*.sql` in journal order, tracking
 *   applied files in `_schema_migrations` so reruns are safe. Each file runs
 *   inside a transaction.
 * - `seedAdminFromEnv()` creates the admin account from ADMIN_EMAIL /
 *   ADMIN_PASSWORD on first boot (no dev backdoor, no hardcoded users).
 * - `seedOAuthConfigFromEnv()` inserts the Google OAuth row from
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI when the
 *   admin has not configured them through the app yet.
 * - `seedPlanConfig()` inserts the default plan settings row (id=1) when it
 *   does not exist yet.
 */

import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";
import { passwordHash } from "./actions";

export type Db = PostgresJsDatabase<Record<string, unknown>>;

const here = dirname(fileURLToPath(import.meta.url));

/** Locate the drizzle migrations directory both from source and from Docker. */
export function drizzleDir(): string {
  const candidates = [
    resolve(here, "../../drizzle"),
    resolve(here, "../drizzle"),
    resolve(process.cwd(), "drizzle"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "meta", "_journal.json"))) return dir;
  }
  throw new Error("drizzle migrations directory not found");
}

export function requireDatabaseUrl(): string {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at your PostgreSQL connection string " +
        "(Supabase: Project Settings → Database → Connection string → URI).",
    );
  }
  return url;
}

let sql: Sql | null = null;
let db: Db | null = null;

export function getSql(): Sql {
  if (!sql) {
    const url = requireDatabaseUrl();
    // Supabase's port-6543 pooler runs PgBouncer in transaction mode, which
    // cannot use prepared statements.
    const pooler = /pgbouncer=true/i.test(url) || /:6543(\/|$|\?)/.test(url);
    // Supabase requires TLS. Allow opting out for local non-TLS Postgres.
    const sslDisabled = /sslmode=disable/i.test(url) || process.env.DATABASE_SSL === "disable";
    sql = postgres(url, {
      prepare: !pooler,
      ssl: sslDisabled ? false : "require",
      max: 5,
      connect_timeout: 15,
      idle_timeout: 20,
    });
  }
  return sql;
}

export function getDb(): Db {
  if (!db) db = drizzle(getSql(), { schema });
  return db;
}

interface JournalEntry {
  idx: number;
  tag: string;
}

export async function runMigrations(): Promise<void> {
  const sql = getSql();
  const dir = drizzleDir();
  await sql.unsafe(
    "CREATE TABLE IF NOT EXISTS _schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
  );
  const appliedRows = (await sql.unsafe(
    "SELECT name FROM _schema_migrations",
  )) as unknown as Array<{ name: string }>;
  const appliedNames = new Set(appliedRows.map((row) => String(row.name)));
  const journal = JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
  for (const entry of ordered) {
    // drizzle-kit's tag already contains the idx prefix ("0000_name"); older
    // journals may not, so handle both.
    const padded = String(entry.idx).padStart(4, "0");
    const fileName = entry.tag.startsWith(`${padded}_`) ? `${entry.tag}.sql` : `${padded}_${entry.tag}.sql`;
    if (appliedNames.has(fileName)) continue;
    const fileSql = readFileSync(join(dir, fileName), "utf8");
    // Split on the literal marker: drizzle-kit places it on its own line in
    // some files and trailing the previous statement (";--> ...") in others.
    const statements = fileSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await sql.begin(async (tx) => {
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx`INSERT INTO _schema_migrations (name, applied_at) VALUES (${fileName}, ${Date.now()})`;
    });
    console.log(`[db] applied migration ${fileName} (${statements.length} statements)`);
  }
}

/** Create the admin account from env on first boot. Never overwrites. */
export async function seedAdminFromEnv(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!email && !password) {
    console.log("[db] ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping admin seed (sign up, then promote via DB if needed).");
    return;
  }
  if (!email || !password) throw new Error("Set both ADMIN_EMAIL and ADMIN_PASSWORD, or neither.");
  if (password.length < 10) throw new Error("ADMIN_PASSWORD must be at least 10 characters.");
  const db = getDb();
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing[0]) {
    console.log(`[db] admin ${email} already exists — not overwritten.`);
    return;
  }
  const now = new Date();
  const rows = await db
    .insert(schema.users)
    .values({
      name: "Administrator",
      email,
      passwordHash: await passwordHash(password),
      emailVerified: true,
      accountStatus: "active",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.users.id });
  const created = rows[0];
  if (!created) throw new Error("Admin seed insert failed.");
  await db.insert(schema.wallets).values({
    userId: created.id,
    balance: 0,
    currency: "USD",
    createdAt: now,
    updatedAt: now,
  });
  console.log(`[db] admin account created for ${email}.`);
}

/**
 * Seed the Google OAuth row from env when the admin has not configured it
 * through the app's Administration page yet. Existing rows are never
 * overwritten — the in-app form stays the source of truth afterwards.
 */
export async function seedOAuthConfigFromEnv(): Promise<void> {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const redirectUri = (process.env.GOOGLE_REDIRECT_URI ?? "").trim() || null;
  if (!clientId || !clientSecret) return;
  const db = getDb();
  const rows = await db
    .select({ id: schema.googleOAuthConfig.id })
    .from(schema.googleOAuthConfig)
    .where(eq(schema.googleOAuthConfig.id, 1))
    .limit(1);
  if (rows[0]) {
    console.log("[db] Google OAuth already configured — env values not applied.");
    return;
  }
  await db.insert(schema.googleOAuthConfig).values({
    id: 1,
    clientId,
    clientSecret,
    redirectUri,
    updatedByUserId: null,
    updatedAt: new Date(),
  });
  console.log("[db] Google OAuth configuration seeded from environment.");
}

/**
 * Insert the default plan settings row (id=1) when it does not exist yet.
 * Defaults: Gmail $2.50/month, Pro $3.00/month, free temp-email TTL 24 hours.
 * The admin can change these later in Administration → Plan settings.
 */
export async function seedPlanConfig(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.planConfig.id })
    .from(schema.planConfig)
    .where(eq(schema.planConfig.id, 1))
    .limit(1);
  if (rows[0]) return;
  await db.insert(schema.planConfig).values({
    id: 1,
    gmailPriceCents: 250,
    proPriceCents: 300,
    freeTtlMinutes: 1440,
    updatedByUserId: null,
    updatedAt: new Date(),
  });
  console.log("[db] default plan settings seeded (Gmail $2.50/mo, Pro $3.00/mo, free TTL 24 h).");
}
