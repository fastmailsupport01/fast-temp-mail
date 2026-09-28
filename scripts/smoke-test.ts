/**
 * Local smoke test for the Fast Temp Mail standalone export.
 *
 * Uses PGlite (real PostgreSQL, in-process/WASM) so no database server is
 * needed. It applies the actual drizzle migration files statement-by-statement
 * (same splitting the server uses), then exercises the real action handlers:
 * temp-mail generate → inbox → simulate → expire → delete, signup (demo OTP)
 * → verify → login → dashboard → deposit → plan upgrade → admin → OAuth →
 * password reset.
 *
 * Run: `bun run test:smoke`
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PGliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as schema from "../server/src/schema";
import { Actions, passwordHash } from "../server/src/actions";
import type { Ctx, SpaceDb } from "../server/src/sdk-shim";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");

let failures = 0;
function check(name: string, cond: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}
function eqStr(a: string) {
  return createHash("sha256").update(a).digest("hex");
}

// Deterministic environment for the suite.
process.env.MAIL_DOMAIN = "fasttempmail.site";
process.env.DEMO_MODE = "true";
delete process.env.RESEND_API_KEY;

const pg = new PGlite();
const db = drizzle(pg, { schema }) as PGliteDatabase<typeof schema>;
const ctx: Ctx = {
  db: () => db as unknown as SpaceDb<Record<string, unknown>>,
  invalidateQueries: () => {},
};

async function call<K extends keyof typeof Actions>(
  name: K,
  args: Parameters<(typeof Actions)[K]["handler"]>[1],
): Promise<ReturnType<(typeof Actions)[K]["handler"]>> {
  const action = Actions[name];
  const parsed = action.request.safeParse(args);
  if (!parsed.success) throw new Error(`Test bug: invalid args for ${String(name)}`);
  // @ts-expect-error dynamic dispatch keeps the test generic
  return action.handler(ctx, parsed.data);
}

console.log("== migrations ==");
const journal = JSON.parse(
  readFileSync(join(root, "drizzle", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; tag: string }[] };
let total = 0;
for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
  const padded = String(entry.idx).padStart(4, "0");
  const fileName = entry.tag.startsWith(`${padded}_`) ? `${entry.tag}.sql` : `${padded}_${entry.tag}.sql`;
  const sql = readFileSync(join(root, "drizzle", fileName), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await pg.query(stmt);
  total += statements.length;
  console.log(`  applied ${fileName} (${statements.length} statements)`);
}
const tables = (await pg.query<{ tablename: string }>(
  "SELECT tablename FROM pg_tables WHERE schemaname='public'",
)) as unknown as { rows: { tablename: string }[] };
const tableNames = tables.rows.map((r) => r.tablename);
check("all 12 tables exist", total >= 12);
check(
  "expected tables present",
  ["users", "wallets", "transactions", "temp_emails", "temp_messages", "plan_config", "email_verifications", "login_sessions", "password_resets", "google_oauth_config", "google_oauth_states", "audit_logs"].every((t) => tableNames.includes(t)),
);
check("old messages table gone", !tableNames.includes("messages"));

// Seed the default plan config row (db.ts does this at boot against real PG).
await db.insert(schema.planConfig).values({ id: 1, gmailPriceCents: 250, proPriceCents: 300, freeTtlMinutes: 1440, updatedByUserId: null, updatedAt: new Date() });

console.log("== dev bypass removed ==");
check("no seedDevelopmentData action", !("seedDevelopmentData" in Actions));
check("no startDevelopmentSession action", !("startDevelopmentSession" in Actions));
check("no composeMessage action", !("composeMessage" in Actions));
check("resetPassword action exists", "resetPassword" in Actions);

console.log("== public config & plans ==");
const pub = await call("getPublicConfig", {});
check("providers all false without env", !pub.providers.google && !pub.providers.resend && pub.providers.crypto === false);
check("minimumDeposit is 3", pub.minimumDeposit === 3);
check("mail domain exposed", pub.mailDomain === "fasttempmail.site");
check("demo mode on", pub.demoMode === true);
check("gmail price 2.50", pub.gmailPrice === 2.5);
check("pro price 3.00", pub.proPrice === 3);
const plans = await call("getPlans", {});
check("free plan has temp-email features", plans.free.features.length >= 3 && plans.free.price === 0);
check("gmail tier is popular at $2.50", plans.gmail.popular === true && plans.gmail.price === 2.5 && plans.gmail.features.length >= 3 && /manual/i.test(plans.gmail.activationNote));
check("pro tier at $3.00", plans.pro.price === 3 && plans.pro.features.length >= 3 && /manual/i.test(plans.pro.activationNote));

console.log("== temp mail lifecycle (anonymous) ==");
const gen = await call("generateTempEmail", {});
check("address generated", gen.ok === true && !!gen.address && gen.address.endsWith("@fasttempmail.site") && typeof gen.id === "number");
const anonId = gen.id!;
const inbox0 = await call("getTempInbox", { id: anonId });
check("inbox starts empty", inbox0.ok === true && inbox0.messages.length === 0 && inbox0.expired === false);
const exp = new Date(inbox0.expiresAt!);
check("expiry ~24h out", exp.getTime() - Date.now() > 23.5 * 3600 * 1000 && exp.getTime() - Date.now() <= 24 * 3600 * 1000 + 60 * 1000);
const sim = await call("simulateIncomingMail", { id: anonId });
check("demo simulator delivers", sim.ok === true);
const inbox1 = await call("getTempInbox", { id: anonId });
check("simulated message visible", inbox1.ok === true && inbox1.messages.length === 1 && inbox1.messages[0]!.sender.length > 0);
// Expired address reporting.
const past = new Date(Date.now() - 1000);
const expiredRows = await db.insert(schema.tempEmails).values({
  userId: null, address: "old-thing@fasttempmail.site", localPart: "old-thing", domain: "fasttempmail.site",
  createdAt: new Date(Date.now() - 7200_000), expiresAt: past,
}).returning({ id: schema.tempEmails.id });
const inboxExpired = await call("getTempInbox", { id: expiredRows[0]!.id });
check("expired address reported", inboxExpired.expired === true);
const del = await call("deleteTempEmail", { id: anonId });
check("address deleted", del.ok === true);
const inboxGone = await call("getTempInbox", { id: anonId });
check("deleted address not found", inboxGone.ok === false);

console.log("== signup / verify / login ==");
const su = await call("signUp", { name: "Test User", email: "test@example.com", password: "supersecret123" });
check("signup ok", su.ok === true);
check("demo OTP shown on screen", typeof su.demoCode === "string" && /^\d{6}$/.test(su.demoCode!));
const dupe = await call("signUp", { name: "Test User", email: "test@example.com", password: "supersecret123" });
check("duplicate signup rejected", dupe.ok === false);
const badOtp = await call("verifyEmail", { email: "test@example.com", otp: "000000" });
check("wrong OTP rejected", badOtp.ok === false);
const goodOtp = await call("verifyEmail", { email: "test@example.com", otp: su.demoCode! });
check("correct OTP verifies", goodOtp.ok === true && !!goodOtp.token && goodOtp.role === "user");
const login = await call("login", { email: "test@example.com", password: "supersecret123" });
check("login works", login.ok === true && !!login.token);
const badLogin = await call("login", { email: "test@example.com", password: "wrongpassword1" });
check("wrong password rejected", badLogin.ok === false);
const token = login.token!;

console.log("== logged-in temp mail ==");
const genUser = await call("generateTempEmail", { token });
check("user address generated", genUser.ok === true && typeof genUser.id === "number");
const mine = await call("getMyTempEmails", { token });
check("my addresses listed", mine.ok === true && mine.emails.some((e) => e.id === genUser.id));
// Second user cannot read the first user's address.
const su2 = await call("signUp", { name: "Second User", email: "second@example.com", password: "supersecret123" });
const ok2 = await call("verifyEmail", { email: "second@example.com", otp: su2.demoCode! });
const token2 = ok2.token!;
const cross = await call("getTempInbox", { id: genUser.id!, token: token2 });
check("cross-user inbox access blocked", cross.ok === false);
const ownerInbox = await call("getTempInbox", { id: genUser.id!, token });
check("owner can read own inbox", ownerInbox.ok === true);

console.log("== dashboard / deposit / ledger ==");
let invalidTokenRejected = false;
try {
  await call("getDashboard", { token: "this-token-is-long-enough-but-invalid" });
} catch {
  invalidTokenRejected = true;
}
check("dashboard rejects invalid token", invalidTokenRejected);
const dashOk = await call("getDashboard", { token });
check("dashboard loads", dashOk.user.email === "test@example.com" && dashOk.wallet.balance === 0 && dashOk.user.plan === "free");
let depositRejected = false;
try {
  await call("requestDeposit", { token, amount: 2, method: "crypto" });
} catch {
  depositRejected = true;
}
check("deposit below $3 rejected", depositRejected);
const dep = await call("requestDeposit", { token, amount: 5, method: "crypto" });
check("crypto deposit pending created", dep.ok === true && !!dep.transactionId);
const dash2 = await call("getDashboard", { token });
check("deposit shows as pending in ledger", dash2.transactions.some((t) => t.status === "pending" && t.amount === 5 && t.type === "deposit"));

console.log("== plan upgrade flow ==");
const up = await call("requestPlanUpgrade", { token, plan: "gmail" });
check("upgrade request created", up.ok === true && !!up.transactionId);
const upDupe = await call("requestPlanUpgrade", { token, plan: "pro" });
check("duplicate upgrade request blocked", upDupe.ok === false);

console.log("== admin ==");
const adminExists = await db.select().from(schema.users).where(eq(schema.users.email, "admin@example.com"));
if (!adminExists[0]) {
  const now = new Date();
  const rows = await db.insert(schema.users).values({
    name: "Administrator", email: "admin@example.com", passwordHash: await passwordHash("adminpassword123"),
    emailVerified: true, accountStatus: "active", role: "admin", plan: "free", createdAt: now, updatedAt: now,
  }).returning({ id: schema.users.id });
  await db.insert(schema.wallets).values({ userId: rows[0]!.id, balance: 0, currency: "USD", createdAt: now, updatedAt: now });
}
const adminLogin = await call("login", { email: "admin@example.com", password: "adminpassword123" });
check("admin login works", adminLogin.ok === true && adminLogin.role === "admin");
const adminToken = adminLogin.token!;
const adm = await call("getAdminDashboard", { token: adminToken });
check("admin dashboard loads", adm.ok === true && adm.metrics !== null && adm.metrics.totalUsers === 3);
check("admin sees pending upgrade with tier", adm.pendingTransactions.some((t) => t.type === "plan_upgrade" && t.id === up.transactionId && t.plan === "gmail"));
check("gmailUsers metric present", typeof adm.metrics.gmailUsers === "number");
const nonAdminAdm = await call("getAdminDashboard", { token });
check("non-admin blocked from admin dashboard", nonAdminAdm.ok === false);
const activateFail = await call("completePlanUpgrade", { token, transactionId: up.transactionId!, plan: "gmail" });
check("non-admin cannot activate upgrade", activateFail.ok === false);
const activate = await call("completePlanUpgrade", { token: adminToken, transactionId: up.transactionId!, plan: "gmail" });
check("admin activates gmail plan", activate.ok === true);
const dashPro = await call("getDashboard", { token });
check("user is gmail for ~30 days", dashPro.user.plan === "gmail" && !!dashPro.user.planExpiresAt && new Date(dashPro.user.planExpiresAt).getTime() > Date.now() + 29 * 24 * 3600 * 1000);
let cfgRejected = false;
try {
  await call("savePlanConfig", { token: adminToken, gmailPriceCents: 50, proPriceCents: 300, freeTtlMinutes: 60 });
} catch {
  cfgRejected = true;
}
check("plan price below $1 rejected", cfgRejected);
const cfg = await call("savePlanConfig", { token: adminToken, gmailPriceCents: 275, proPriceCents: 300, freeTtlMinutes: 30 });
check("plan config saved", cfg.ok === true && cfg.planConfig!.gmailPriceCents === 275 && cfg.planConfig!.proPriceCents === 300 && cfg.planConfig!.freeTtlMinutes === 30);
const cfgNonAdmin = await call("savePlanConfig", { token, gmailPriceCents: 275, proPriceCents: 300, freeTtlMinutes: 30 });
check("non-admin cannot save plan config", cfgNonAdmin.ok === false);
const pub3 = await call("getPublicConfig", {});
check("ttl follows saved plan config", pub3.tempEmailTtlMinutes === 30);

console.log("== oauth config ==");
const oauthCfg = await call("getGoogleOAuthAdminConfig", { token: adminToken });
check("oauth config starts unconfigured", oauthCfg.configured === false);
const nonAdminCfg = await call("getGoogleOAuthAdminConfig", { token });
check("non-admin blocked from oauth config", nonAdminCfg.ok === false);
const saveBad = await call("saveGoogleOAuthConfig", {
  token: adminToken, clientId: "invalid-client-id-1234567890", clientSecret: "shh", redirectUri: "https://example.com/oauth/callback",
});
check("invalid client id rejected", saveBad.ok === false);
const saveOk = await call("saveGoogleOAuthConfig", {
  token: adminToken, clientId: "12345-abcdef.apps.googleusercontent.com", clientSecret: "test-secret", redirectUri: "https://example.com/oauth/callback",
});
check("oauth config saved", saveOk.ok === true && saveOk.configured === true);
const pub4 = await call("getPublicConfig", {});
check("google now advertised ready", pub4.providers.google === true);
const begin = await call("beginGoogleOAuth", {});
check("oauth flow starts with PKCE url", begin.ok === true && !!begin.authorizationUrl?.includes("accounts.google.com"));

console.log("== password reset ==");
const req = await call("requestPasswordReset", { email: "test@example.com" });
check("reset request ok in demo", req.ok === true && typeof req.demoCode === "string");
const badReset = await call("resetPassword", { email: "test@example.com", token: "nope-not-real-token", newPassword: "newpassword123" });
check("bad reset token rejected", badReset.ok === false);
const goodReset = await call("resetPassword", { email: "test@example.com", token: req.demoCode!, newPassword: "newpassword123" });
check("reset with demo code works", goodReset.ok === true && !!goodReset.token);
const loginNew = await call("login", { email: "test@example.com", password: "newpassword123" });
check("login with new password works", loginNew.ok === true);

console.log("== demo mode off ==");
process.env.DEMO_MODE = "false";
const simOff = await call("simulateIncomingMail", { id: expiredRows[0]!.id });
check("simulator disabled when DEMO_MODE=false", simOff.ok === false);
const su3 = await call("signUp", { name: "Third User", email: "third@example.com", password: "supersecret123" });
check("no demo code when DEMO_MODE=false", su3.ok === true && su3.demoCode === null && /not configured/i.test(su3.message));
process.env.DEMO_MODE = "true";

await pg.close();
console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
