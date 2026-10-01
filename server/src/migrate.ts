/**
 * One-time database migration helper (TEMPORARY — removed after the
 * Render → Supabase move).
 *
 * Copies schema (via the drizzle migration files) and all table data from
 * the source connection into the target PostgreSQL database, then resets
 * serial sequences. Tables are copied in foreign-key-safe order.
 */
import postgres, { type Sql } from "postgres";
import { runMigrationsOn } from "./db";

/** Parent tables before child tables (foreign-key-safe order). */
const TABLES_IN_ORDER = [
  "users",
  "email_verifications",
  "password_resets",
  "wallets",
  "temp_emails",
  "login_sessions",
  "google_oauth_states",
  "transactions",
  "temp_messages",
  "virtual_numbers",
  "sms_messages",
  "plan_config",
  "audit_logs",
  "google_oauth_config",
];

/** Tables with a serial (auto-increment) primary key. */
const SERIAL_TABLES = [
  "users",
  "email_verifications",
  "password_resets",
  "wallets",
  "transactions",
  "temp_emails",
  "temp_messages",
  "login_sessions",
  "audit_logs",
  "virtual_numbers",
  "sms_messages",
];

export async function verifyDatabaseCopy(
  source: Sql,
  targetUrl: string,
): Promise<Record<string, { source: number; target: number; match: boolean }>> {
  const target = postgres(targetUrl, {
    prepare: false,
    ssl: "require",
    max: 2,
    connect_timeout: 20,
    idle_timeout: 20,
  });
  try {
    const result: Record<string, { source: number; target: number; match: boolean }> = {};
    for (const table of TABLES_IN_ORDER) {
      const [s] = (await source.unsafe(`SELECT count(*)::int AS c FROM "${table}"`)) as Array<{ c: number }>;
      const [t] = (await target.unsafe(`SELECT count(*)::int AS c FROM "${table}"`)) as Array<{ c: number }>;
      result[table] = { source: s.c, target: t.c, match: s.c === t.c };
    }
    return result;
  } finally {
    await target.end();
  }
}
  const target = postgres(targetUrl, {
    prepare: false,
    ssl: "require",
    max: 3,
    connect_timeout: 20,
    idle_timeout: 20,
  });
  try {
    await runMigrationsOn(target);
    const counts: Record<string, number> = {};
    for (const table of TABLES_IN_ORDER) {
      const cols = (await source.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position`,
      )) as Array<{ column_name: string }>;
      if (cols.length === 0) {
        counts[table] = 0;
        continue;
      }
      const rows = (await source.unsafe(`SELECT * FROM "${table}"`)) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        counts[table] = 0;
        continue;
      }
      const names = cols.map((c) => c.column_name);
      const colList = names.map((n) => `"${n}"`).join(", ");
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const values: Array<string | number | boolean | Date | null> = [];
        const tuples = chunk.map((row) => {
          const placeholders = names.map((n) => {
            const raw: unknown = row[n];
            values.push(raw === undefined || raw === null ? null : (raw as string | number | boolean | Date));
            return `$${values.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        await target.unsafe(`INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(", ")}`, values);
      }
      counts[table] = rows.length;
    }
    for (const table of SERIAL_TABLES) {
      await target.unsafe(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT max("id") FROM "${table}"), 1))`,
      );
    }
    return counts;
  } finally {
    await target.end();
  }
}
