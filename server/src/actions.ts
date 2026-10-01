import { defineAction, z, type ActionsModule, type Ctx } from "./sdk-shim";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import * as schema from "./schema";
import { getSql } from "./db";
import { gmailPoolSize, otpEmail, resendConfigured, resetEmail, sendEmail } from "./mail";
import {
  SMS_NUMBER_PRICE_USD,
  SMS_NUMBER_RENTAL_DAYS,
  buyTwilioNumber,
  releaseTwilioNumber,
  twilioConfigured,
} from "./sms";

const OTP_SENDER_NAME = "Fast Mail";
const MINIMUM_DEPOSIT = 3;
const okMessage = z.object({ ok: z.boolean(), message: z.string() });
const sessionResponse = z.object({ ok: z.boolean(), message: z.string(), token: z.string().nullable(), role: z.enum(["user", "admin"]).nullable() });
const googleStartResponse = z.object({ ok: z.boolean(), message: z.string(), authorizationUrl: z.string().nullable() });
const googleAdminResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  configured: z.boolean(),
  clientIdHint: z.string(),
  redirectUri: z.string(),
  secretStored: z.boolean(),
});
const googleTokenResponse = z.object({ access_token: z.string().min(1) });
const googleUserResponse = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().min(1),
  picture: z.string().url().optional(),
});
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const planSchema = z.enum(["free", "gmail", "pro"]);
const paidPlanSchema = z.enum(["gmail", "pro"]);
const txStatusSchema = z.enum(["pending", "completed", "failed", "cancelled"]);
const txTypeSchema = z.enum(["deposit", "credit", "debit", "plan_upgrade"]);

/** Human-readable TTL: "45 minutes" or "24 hours". */
function formatTtl(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function planDisplayName(plan: "gmail" | "pro"): string {
  return plan === "gmail" ? "Gmail" : "Pro";
}

/** Display domain for generated addresses. NOT a real receiving domain yet —
 *  see README "Honest limitations": inbound mail is simulated in this build. */
export function mailDomain(): string {
  const raw = (process.env.MAIL_DOMAIN ?? "").trim().toLowerCase();
  return raw || "fasttempmail.site";
}

/** Demo mode: shows the "simulate incoming mail" helper and reveals OTP codes
 *  on screen when email delivery is not configured. Disable (false) in
 *  production. */
export function demoMode(): boolean {
  return (process.env.DEMO_MODE ?? "true").trim().toLowerCase() !== "false";
}

function randomToken(bytes = 24): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SESSION_SECRET peppers stored session-token hashes: even with full read
 * access to the database, an attacker cannot forge a session token without
 * the secret. Changing SESSION_SECRET invalidates all existing sessions.
 * OTP and password-reset hashes are single-use and short-lived, so they use
 * plain SHA-256.
 */
async function sessionTokenHash(token: string): Promise<string> {
  const pepper = process.env.SESSION_SECRET ?? "";
  return sha256(`${pepper}:${token}`);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function safeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

function clientIdHint(clientId: string): string {
  if (!clientId) return "";
  const visible = clientId.slice(-22);
  return `••••${visible}`;
}

export async function passwordHash(password: string, salt = randomToken(16)): Promise<string> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 210000 }, base, 256);
  const hash = Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2-sha256$210000$${salt}$${hash}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const salt = parts[2];
  if (!salt) return false;
  return (await passwordHash(password, salt)) === stored;
}

async function createSession(ctx: Ctx, userId: number): Promise<string> {
  const token = randomToken(32);
  const now = new Date();
  await ctx.db<typeof schema>().insert(schema.loginSessions).values({
    userId,
    sessionTokenHash: await sessionTokenHash(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
  });
  return token;
}

async function sessionUser(ctx: Ctx, token: string) {
  const db = ctx.db<typeof schema>();
  const now = new Date();
  const rows = await db.select({ user: schema.users, session: schema.loginSessions })
    .from(schema.loginSessions)
    .innerJoin(schema.users, eq(schema.loginSessions.userId, schema.users.id))
    .where(and(eq(schema.loginSessions.sessionTokenHash, await sessionTokenHash(token)), gt(schema.loginSessions.expiresAt, now)))
    .limit(1);
  return rows[0]?.user ?? null;
}

async function audit(ctx: Ctx, userId: number | null, action: string) {
  await ctx.db<typeof schema>().insert(schema.auditLogs).values({ userId, action, createdAt: new Date() });
}

async function getPlanConfig(ctx: Ctx) {
  const rows = await ctx.db<typeof schema>().select().from(schema.planConfig).where(eq(schema.planConfig.id, 1)).limit(1);
  return rows[0] ?? { id: 1, gmailPriceCents: 250, proPriceCents: 300, freeTtlMinutes: 1440, updatedByUserId: null, updatedAt: new Date() };
}

const ADJECTIVES = ["swift", "bright", "silent", "golden", "rapid", "clever", "lucky", "nimble", "vivid", "bold", "quiet", "cosmic", "electric", "mellow", "prime", "turbo", "velvet", "zesty", "amber", "cobalt"];
const NOUNS = ["fox", "falcon", "wave", "comet", "tiger", "spark", "river", "eagle", "storm", "pixel", "raven", "orbit", "flame", "drift", "nova", "ridge", "surge", "thorn", "viper", "zephyr"];

function randomLocalPart(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}

/** Row-level access: anonymous rows (user_id NULL) are readable by anyone who
 *  knows the id; owned rows only by their owner. This mirrors disposable-mail
 *  semantics. */
async function accessibleTempEmail(ctx: Ctx, id: number, token?: string) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.tempEmails).where(eq(schema.tempEmails.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.userId === null) return row;
  if (!token) return null;
  const user = await sessionUser(ctx, token);
  if (!user || user.id !== row.userId) return null;
  return row;
}

const tempEmailResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  id: z.number().nullable(),
  address: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

const tempMessageSchema = z.object({
  id: z.number(),
  sender: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.string(),
  isRead: z.boolean(),
});

const DEMO_SENDERS: Array<[string, string, string]> = [
  ["welcome@fasttempmail.site", "Welcome to your Fast Temp Mail inbox 👋", "This is a simulated incoming message. Real inbound delivery needs a receiving domain + provider (see README). Your address is live and ready to share."],
  ["alerts@shop-example.com", "Your order #48291 has shipped", "Hi! This is a demo message showing how order notifications appear in your temporary inbox. Nothing was really sent."],
  ["noreply@social-example.com", "Verify your new account", "Your demo verification code is 842-119. This message was simulated locally — connect a real inbound provider to receive genuine mail."],
  ["news@digest-example.com", "Your weekly digest is here", "Demo digest: 3 new stories, 1 mention, 0 spam. Simulated locally for preview purposes."],
];

export const Actions = {
  getPublicConfig: defineAction({
    request: z.object({}),
    response: z.object({
      providers: z.object({ google: z.boolean(), resend: z.boolean(), crypto: z.boolean() }),
      minimumDeposit: z.number(),
      mailDomain: z.string(),
      tempEmailTtlMinutes: z.number(),
      demoMode: z.boolean(),
      proPrice: z.number(),
      gmailPrice: z.number(),
      otpSenderName: z.string(),
      gmailPoolSize: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.googleOAuthConfig).where(eq(schema.googleOAuthConfig.id, 1)).limit(1);
      const config = rows[0];
      const googleReady = Boolean(config?.clientId.trim() && config.clientSecret.trim() && config.redirectUri?.trim());
      const plan = await getPlanConfig(ctx);
      return {
        providers: { google: googleReady, resend: resendConfigured(), crypto: false as boolean },
        minimumDeposit: MINIMUM_DEPOSIT,
        mailDomain: mailDomain(),
        tempEmailTtlMinutes: plan.freeTtlMinutes,
        demoMode: demoMode(),
        proPrice: plan.proPriceCents / 100,
        gmailPrice: plan.gmailPriceCents / 100,
        otpSenderName: OTP_SENDER_NAME,
        gmailPoolSize: gmailPoolSize(),
      };
    },
  }),

  getPlans: defineAction({
    request: z.object({}),
    response: z.object({
      free: z.object({ name: z.string(), price: z.number(), ttlMinutes: z.number(), features: z.array(z.string()) }),
      gmail: z.object({ name: z.string(), price: z.number(), popular: z.boolean(), features: z.array(z.string()), activationNote: z.string() }),
      pro: z.object({ name: z.string(), price: z.number(), features: z.array(z.string()), activationNote: z.string() }),
    }),
    async handler(ctx) {
      const plan = await getPlanConfig(ctx);
      const gmailPrice = plan.gmailPriceCents / 100;
      const proPrice = plan.proPriceCents / 100;
      const ttlText = formatTtl(plan.freeTtlMinutes);
      const manualNote = "Activation is manual: request an upgrade and an admin activates it after payment. No automatic billing is connected yet.";
      return {
        free: {
          name: "Free",
          price: 0,
          ttlMinutes: plan.freeTtlMinutes,
          features: [
            "Temporary email addresses",
            "Basic inbox",
            `Email expiration (${ttlText})`,
            "Copy email",
          ],
        },
        gmail: {
          name: "Gmail",
          price: gmailPrice,
          popular: true,
          features: [
            "Gmail services — connect your Gmail and read it inside Fast Temp Mail",
            "Extended usage",
            "User dashboard",
            "Premium features",
          ],
          activationNote: manualNote,
        },
        pro: {
          name: "Pro",
          price: proPrice,
          features: [
            "Everything in Gmail",
            "Wallet with crypto deposits",
            "Priority support",
            "Advanced controls",
          ],
          activationNote: manualNote,
        },
      };
    },
  }),

  generateTempEmail: defineAction({
    request: z.object({ token: z.string().min(20).optional() }),
    response: tempEmailResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const plan = await getPlanConfig(ctx);
      let user: { id: number } | null = null;
      if (args.token) {
        user = await sessionUser(ctx, args.token);
        if (!user) return { ok: false, message: "Session expired. Sign in again.", id: null, address: null, expiresAt: null };
      }
      const now = new Date();
      // Housekeeping: drop addresses that expired more than a day ago.
      await db.delete(schema.tempEmails).where(lt(schema.tempEmails.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
      const domain = mailDomain();
      const expiresAt = new Date(now.getTime() + plan.freeTtlMinutes * 60 * 1000);
      for (let attempt = 0; attempt < 5; attempt++) {
        const localPart = randomLocalPart();
        const address = `${localPart}@${domain}`;
        try {
          const inserted = await db.insert(schema.tempEmails).values({
            userId: user ? user.id : null,
            address,
            localPart,
            domain,
            createdAt: now,
            expiresAt,
          }).returning({ id: schema.tempEmails.id });
          const row = inserted[0];
          if (!row) throw new Error("insert failed");
          await audit(ctx, user ? user.id : null, "tempmail.generated");
          return { ok: true, message: "Temporary email address generated.", id: row.id, address, expiresAt: expiresAt.toISOString() };
        } catch {
          // Address collision (unique index) — retry with a fresh random part.
        }
      }
      return { ok: false, message: "Could not generate an address. Please try again.", id: null, address: null, expiresAt: null };
    },
  }),

  getTempInbox: defineAction({
    request: z.object({ id: z.number().int().positive(), token: z.string().min(20).optional() }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      address: z.string().nullable(),
      expiresAt: z.string().nullable(),
      expired: z.boolean(),
      messages: z.array(tempMessageSchema),
    }),
    async handler(ctx, args) {
      const row = await accessibleTempEmail(ctx, args.id, args.token);
      if (!row) return { ok: false, message: "Address not found.", address: null, expiresAt: null, expired: false, messages: [] };
      if (row.expiresAt.getTime() <= Date.now()) {
        return { ok: true, message: "This address has expired.", address: row.address, expiresAt: row.expiresAt.toISOString(), expired: true, messages: [] };
      }
      const db = ctx.db<typeof schema>();
      const msgs = await db.select().from(schema.tempMessages).where(eq(schema.tempMessages.tempEmailId, row.id)).orderBy(desc(schema.tempMessages.receivedAt));
      await db.update(schema.tempMessages).set({ isRead: true }).where(eq(schema.tempMessages.tempEmailId, row.id));
      return {
        ok: true,
        message: "Inbox loaded.",
        address: row.address,
        expiresAt: row.expiresAt.toISOString(),
        expired: false,
        messages: msgs.map((m) => ({ id: m.id, sender: m.sender, subject: m.subject, body: m.body, receivedAt: m.receivedAt.toISOString(), isRead: true })),
      };
    },
  }),

  simulateIncomingMail: defineAction({
    request: z.object({ id: z.number().int().positive(), token: z.string().min(20).optional() }),
    response: okMessage,
    async handler(ctx, args) {
      if (!demoMode()) return { ok: false, message: "The demo mail simulator is disabled on this deployment." };
      const row = await accessibleTempEmail(ctx, args.id, args.token);
      if (!row) return { ok: false, message: "Address not found." };
      if (row.expiresAt.getTime() <= Date.now()) return { ok: false, message: "This address has expired." };
      const [sender, subject, body] = DEMO_SENDERS[Math.floor(Math.random() * DEMO_SENDERS.length)]!;
      await ctx.db<typeof schema>().insert(schema.tempMessages).values({
        tempEmailId: row.id,
        sender,
        subject,
        body,
        receivedAt: new Date(),
        isRead: false,
      });
      return { ok: true, message: "Simulated message delivered (demo only — not real email)." };
    },
  }),

  deleteTempEmail: defineAction({
    request: z.object({ id: z.number().int().positive(), token: z.string().min(20).optional() }),
    response: okMessage,
    async handler(ctx, args) {
      const row = await accessibleTempEmail(ctx, args.id, args.token);
      if (!row) return { ok: false, message: "Address not found." };
      await ctx.db<typeof schema>().delete(schema.tempEmails).where(eq(schema.tempEmails.id, row.id));
      await audit(ctx, row.userId, "tempmail.deleted");
      ctx.invalidateQueries();
      return { ok: true, message: "Address deleted." };
    },
  }),

  getMyTempEmails: defineAction({
    request: z.object({ token: z.string().min(20) }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      emails: z.array(z.object({ id: z.number(), address: z.string(), expiresAt: z.string(), expired: z.boolean(), unread: z.number() })),
    }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) return { ok: false, message: "Session expired.", emails: [] };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.tempEmails).where(eq(schema.tempEmails.userId, user.id)).orderBy(desc(schema.tempEmails.createdAt)).limit(20);
      const now = Date.now();
      const emails = [];
      for (const row of rows) {
        const unread = await db.select({ id: schema.tempMessages.id }).from(schema.tempMessages)
          .where(and(eq(schema.tempMessages.tempEmailId, row.id), eq(schema.tempMessages.isRead, false)));
        emails.push({ id: row.id, address: row.address, expiresAt: row.expiresAt.toISOString(), expired: row.expiresAt.getTime() <= now, unread: unread.length });
      }
      return { ok: true, message: "Addresses loaded.", emails };
    },
  }),

  signUp: defineAction({
    request: z.object({ name: z.string().trim().min(2).max(80), email: z.string().email(), password: z.string().min(10).max(128) }),
    response: z.object({ ok: z.boolean(), message: z.string(), email: z.string().nullable(), demoCode: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (existing[0]) return { ok: false, message: "An account already exists for this email.", email: null, demoCode: null };
      const now = new Date();
      const rows = await db.insert(schema.users).values({ name: args.name.trim(), email, passwordHash: await passwordHash(args.password), emailVerified: false, accountStatus: "pending", role: "user", plan: "free", createdAt: now, updatedAt: now }).returning({ id: schema.users.id });
      const user = rows[0];
      if (!user) return { ok: false, message: "Account could not be created.", email: null, demoCode: null };
      await db.insert(schema.wallets).values({ userId: user.id, balance: 0, currency: "USD", createdAt: now, updatedAt: now });
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      await db.insert(schema.emailVerifications).values({ userId: user.id, otpHash: await sha256(otp), expiresAt: new Date(now.getTime() + 10 * 60 * 1000), attempts: 0, createdAt: now });
      await audit(ctx, user.id, "account.created_pending_verification");
      const delivered = await sendEmail(email, otpEmail(otp).subject, otpEmail(otp).html, otpEmail(otp).text);
      if (delivered) {
        return { ok: true, message: `Account created. We sent a 6-digit code from ${OTP_SENDER_NAME} — enter it to verify your email.`, email, demoCode: null };
      }
      if (demoMode()) {
        return {
          ok: true,
          message: "Account created. Demo mode is ON and email delivery is not configured, so your verification code is shown below.",
          email,
          demoCode: otp,
        };
      }
      return { ok: true, message: "Account created, but email delivery is not configured yet (RESEND_API_KEY). You cannot verify until the administrator enables it — please ask them.", email, demoCode: null };
    },
  }),

  verifyEmail: defineAction({
    request: z.object({ email: z.string().email(), otp: z.string().regex(/^\d{6}$/) }),
    response: sessionResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const users = await db.select().from(schema.users).where(eq(schema.users.email, args.email.toLowerCase())).limit(1);
      const user = users[0];
      if (!user) return { ok: false, message: "Account not found.", token: null, role: null };
      const rows = await db.select().from(schema.emailVerifications).where(and(eq(schema.emailVerifications.userId, user.id), gt(schema.emailVerifications.expiresAt, new Date()))).orderBy(desc(schema.emailVerifications.id)).limit(1);
      const verification = rows[0];
      if (!verification || verification.verifiedAt) return { ok: false, message: "This code is expired or already used.", token: null, role: null };
      if (verification.attempts >= 5) return { ok: false, message: "Maximum attempts reached. Request a new code.", token: null, role: null };
      if ((await sha256(args.otp)) !== verification.otpHash) {
        await db.update(schema.emailVerifications).set({ attempts: verification.attempts + 1 }).where(eq(schema.emailVerifications.id, verification.id));
        return { ok: false, message: "That code is not valid.", token: null, role: null };
      }
      const now = new Date();
      await db.update(schema.emailVerifications).set({ verifiedAt: now }).where(eq(schema.emailVerifications.id, verification.id));
      await db.update(schema.users).set({ emailVerified: true, accountStatus: "active", updatedAt: now, lastLoginAt: now }).where(eq(schema.users.id, user.id));
      const token = await createSession(ctx, user.id);
      await audit(ctx, user.id, "email.verified");
      return { ok: true, message: "Email verified.", token, role: user.role };
    },
  }),

  login: defineAction({
    request: z.object({ email: z.string().email(), password: z.string().min(1) }),
    response: sessionResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.users).where(eq(schema.users.email, args.email.toLowerCase())).limit(1);
      const user = rows[0];
      if (!user || !user.passwordHash || !(await passwordMatches(args.password, user.passwordHash))) return { ok: false, message: "Email or password is incorrect.", token: null, role: null };
      if (!user.emailVerified) return { ok: false, message: "Verify your email before signing in.", token: null, role: null };
      const token = await createSession(ctx, user.id);
      await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
      await audit(ctx, user.id, "auth.login");
      return { ok: true, message: "Signed in.", token, role: user.role };
    },
  }),

  requestPasswordReset: defineAction({
    request: z.object({ email: z.string().email() }),
    response: z.object({ ok: z.boolean(), message: z.string(), demoCode: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.users).where(eq(schema.users.email, args.email.toLowerCase())).limit(1);
      const user = rows[0];
      if (user) {
        const token = randomToken(24);
        const now = new Date();
        await db.insert(schema.passwordResets).values({ userId: user.id, tokenHash: await sha256(token), expiresAt: new Date(now.getTime() + 30 * 60 * 1000), createdAt: now });
        await audit(ctx, user.id, "password.reset_requested");
        const content = resetEmail(token);
        const delivered = await sendEmail(user.email, content.subject, content.html, content.text);
        if (delivered) return { ok: true, message: "If the account exists, a reset code was sent. Codes expire after 30 minutes.", demoCode: null };
        if (demoMode()) return { ok: true, message: "Demo mode is ON: email delivery is not configured, so your reset code is shown below.", demoCode: token };
      }
      return { ok: true, message: "If the account exists and email delivery is configured, a reset code was sent. Codes expire after 30 minutes.", demoCode: null };
    },
  }),

  resetPassword: defineAction({
    request: z.object({ email: z.string().email(), token: z.string().trim().min(10).max(256), newPassword: z.string().min(10).max(128) }),
    response: sessionResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const users = await db.select().from(schema.users).where(eq(schema.users.email, args.email.toLowerCase())).limit(1);
      const user = users[0];
      if (!user) return { ok: false, message: "This reset code is not valid.", token: null, role: null };
      const rows = await db.select().from(schema.passwordResets)
        .where(and(eq(schema.passwordResets.userId, user.id), gt(schema.passwordResets.expiresAt, new Date())))
        .orderBy(desc(schema.passwordResets.createdAt))
        .limit(1);
      const reset = rows[0];
      if (!reset || reset.usedAt) return { ok: false, message: "This reset code is expired or already used.", token: null, role: null };
      if ((await sha256(args.token.trim())) !== reset.tokenHash) return { ok: false, message: "This reset code is not valid.", token: null, role: null };
      const now = new Date();
      await db.update(schema.passwordResets).set({ usedAt: now }).where(eq(schema.passwordResets.id, reset.id));
      await db.update(schema.users).set({ passwordHash: await passwordHash(args.newPassword), updatedAt: now, lastLoginAt: now }).where(eq(schema.users.id, user.id));
      const token = await createSession(ctx, user.id);
      await audit(ctx, user.id, "password.reset_completed");
      return { ok: true, message: "Password updated. You are now signed in.", token, role: user.role };
    },
  }),

  getDashboard: defineAction({
    request: z.object({ token: z.string().min(20) }),
    response: z.object({
      user: z.object({ id: z.number(), name: z.string(), email: z.string(), role: z.enum(["user", "admin"]), verified: z.boolean(), plan: planSchema, planExpiresAt: z.string().nullable() }),
      wallet: z.object({ balance: z.number(), currency: z.string() }),
      activeTempEmails: z.array(z.object({ id: z.number(), address: z.string(), expiresAt: z.string(), unread: z.number() })),
      transactions: z.array(z.object({ id: z.string(), type: txTypeSchema, amount: z.number(), status: txStatusSchema, provider: z.string(), createdAt: z.string() })),
    }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) throw new Error("Session expired. Sign in again.");
      const db = ctx.db<typeof schema>();
      const walletRows = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, user.id)).limit(1);
      const wallet = walletRows[0];
      const now = Date.now();
      const emailRows = await db.select().from(schema.tempEmails).where(eq(schema.tempEmails.userId, user.id)).orderBy(desc(schema.tempEmails.createdAt)).limit(10);
      const activeTempEmails = [];
      for (const row of emailRows) {
        if (row.expiresAt.getTime() <= now) continue;
        const unread = await db.select({ id: schema.tempMessages.id }).from(schema.tempMessages)
          .where(and(eq(schema.tempMessages.tempEmailId, row.id), eq(schema.tempMessages.isRead, false)));
        activeTempEmails.push({ id: row.id, address: row.address, expiresAt: row.expiresAt.toISOString(), unread: unread.length });
      }
      const txRows = await db.select().from(schema.transactions).where(eq(schema.transactions.userId, user.id)).orderBy(desc(schema.transactions.createdAt)).limit(30);
      return {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, verified: user.emailVerified, plan: user.plan, planExpiresAt: user.planExpiresAt ? user.planExpiresAt.toISOString() : null },
        wallet: { balance: wallet?.balance ?? 0, currency: wallet?.currency ?? "USD" },
        activeTempEmails,
        transactions: txRows.map((t) => ({ id: t.publicId, type: t.type, amount: t.amount, status: t.status, provider: t.provider, createdAt: t.createdAt.toISOString() })),
      };
    },
  }),

  requestDeposit: defineAction({
    request: z.object({ token: z.string(), amount: z.number().finite().min(MINIMUM_DEPOSIT), method: z.enum(["crypto"]) }),
    response: z.object({ ok: z.boolean(), message: z.string(), transactionId: z.string().nullable() }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) return { ok: false, message: "Session expired.", transactionId: null };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, user.id)).limit(1);
      const wallet = rows[0];
      if (!wallet) return { ok: false, message: "Wallet not found.", transactionId: null };
      const publicId = `ZM-${Date.now().toString(36).toUpperCase()}-${randomToken(3).toUpperCase()}`;
      await db.insert(schema.transactions).values({
        publicId, userId: user.id, walletId: wallet.id, type: "deposit",
        amount: Math.round(args.amount * 100) / 100, currency: "USD", status: "pending",
        provider: "crypto_manual", description: "Crypto deposit awaiting manual verification",
        createdAt: new Date(),
      });
      await audit(ctx, user.id, "deposit.pending_created");
      ctx.invalidateQueries();
      return { ok: true, message: "Deposit request created as pending. An admin verifies crypto payments manually until a payment provider is connected — your wallet is credited only after verification.", transactionId: publicId };
    },
  }),

  requestPlanUpgrade: defineAction({
    request: z.object({ token: z.string(), plan: paidPlanSchema }),
    response: z.object({ ok: z.boolean(), message: z.string(), transactionId: z.string().nullable() }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) return { ok: false, message: "Session expired.", transactionId: null };
      if (user.plan === args.plan && user.planExpiresAt && user.planExpiresAt.getTime() > Date.now()) {
        return { ok: false, message: `You already have an active ${planDisplayName(args.plan)} plan.`, transactionId: null };
      }
      const db = ctx.db<typeof schema>();
      const plan = await getPlanConfig(ctx);
      const existing = await db.select().from(schema.transactions).where(and(
        eq(schema.transactions.userId, user.id),
        eq(schema.transactions.type, "plan_upgrade"),
        eq(schema.transactions.status, "pending"),
      )).limit(1);
      if (existing[0]) return { ok: false, message: "You already have a pending upgrade request.", transactionId: existing[0].publicId };
      const wallets = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, user.id)).limit(1);
      const wallet = wallets[0];
      if (!wallet) return { ok: false, message: "Wallet not found.", transactionId: null };
      const publicId = `ZM-${Date.now().toString(36).toUpperCase()}-${randomToken(3).toUpperCase()}`;
      const amount = (args.plan === "gmail" ? plan.gmailPriceCents : plan.proPriceCents) / 100;
      const tierName = planDisplayName(args.plan);
      await db.insert(schema.transactions).values({
        publicId, userId: user.id, walletId: wallet.id, type: "plan_upgrade",
        amount, currency: "USD", status: "pending", provider: "manual",
        description: `${tierName} plan upgrade ($${amount.toFixed(2)}/month) — pending manual activation`,
        createdAt: new Date(),
      });
      await audit(ctx, user.id, "plan.upgrade_requested");
      ctx.invalidateQueries();
      return { ok: true, message: `${tierName} upgrade request created as pending. An admin activates it manually after payment — no automatic billing is connected yet.`, transactionId: publicId };
    },
  }),

  updateProfile: defineAction({
    request: z.object({ token: z.string(), name: z.string().trim().min(2).max(80) }),
    response: okMessage,
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) return { ok: false, message: "Session expired." };
      await ctx.db<typeof schema>().update(schema.users).set({ name: args.name, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
      await audit(ctx, user.id, "profile.updated");
      ctx.invalidateQueries();
      return { ok: true, message: "Profile updated." };
    },
  }),

  getAdminDashboard: defineAction({
    request: z.object({ token: z.string().min(20) }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      metrics: z.object({
        totalUsers: z.number(), verifiedUsers: z.number(), activeUsers: z.number(), gmailUsers: z.number(), proUsers: z.number(),
        tempEmailsActive: z.number(), totalTempEmails: z.number(),
        completedDeposits: z.number(), pendingDeposits: z.number(), failedDeposits: z.number(),
        pendingUpgrades: z.number(),
      }).nullable(),
      recentUsers: z.array(z.object({ id: z.number(), name: z.string(), email: z.string(), role: z.enum(["user", "admin"]), plan: planSchema, createdAt: z.string() })),
      recentTempEmails: z.array(z.object({ id: z.number(), address: z.string(), userEmail: z.string().nullable(), expiresAt: z.string(), expired: z.boolean() })),
      pendingTransactions: z.array(z.object({ id: z.string(), type: txTypeSchema, plan: z.string().nullable(), amount: z.number(), userEmail: z.string(), createdAt: z.string() })),
      planConfig: z.object({ gmailPriceCents: z.number(), proPriceCents: z.number(), freeTtlMinutes: z.number() }).nullable(),
      recentAudit: z.array(z.object({ id: z.number(), action: z.string(), createdAt: z.string() })),
    }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user || user.role !== "admin") return { ok: false, message: "Admin access required.", metrics: null, recentUsers: [], recentTempEmails: [], pendingTransactions: [], planConfig: null, recentAudit: [] };
      const db = ctx.db<typeof schema>();
      const now = Date.now();
      const userRows = await db.select().from(schema.users);
      const tempRows = await db.select({ e: schema.tempEmails, u: schema.users }).from(schema.tempEmails)
        .leftJoin(schema.users, eq(schema.tempEmails.userId, schema.users.id))
        .orderBy(desc(schema.tempEmails.createdAt)).limit(10);
      const depositRows = await db.select().from(schema.transactions).where(eq(schema.transactions.type, "deposit"));
      const pendingTx = await db.select({ t: schema.transactions, u: schema.users }).from(schema.transactions)
        .innerJoin(schema.users, eq(schema.transactions.userId, schema.users.id))
        .where(eq(schema.transactions.status, "pending"))
        .orderBy(desc(schema.transactions.createdAt)).limit(20);
      const auditRows = await db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.createdAt)).limit(12);
      const plan = await getPlanConfig(ctx);
      return {
        ok: true,
        message: "Admin dashboard loaded.",
        metrics: {
          totalUsers: userRows.length,
          verifiedUsers: userRows.filter((u) => u.emailVerified).length,
          activeUsers: userRows.filter((u) => u.accountStatus === "active").length,
          gmailUsers: userRows.filter((u) => u.plan === "gmail" && u.planExpiresAt && u.planExpiresAt.getTime() > now).length,
          proUsers: userRows.filter((u) => u.plan === "pro" && u.planExpiresAt && u.planExpiresAt.getTime() > now).length,
          tempEmailsActive: tempRows.filter((r) => r.e.expiresAt.getTime() > now).length,
          totalTempEmails: tempRows.length,
          completedDeposits: depositRows.filter((t) => t.status === "completed").length,
          pendingDeposits: depositRows.filter((t) => t.status === "pending").length,
          failedDeposits: depositRows.filter((t) => t.status === "failed").length,
          pendingUpgrades: pendingTx.filter((r) => r.t.type === "plan_upgrade").length,
        },
        recentUsers: userRows.slice(-10).reverse().map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan, createdAt: u.createdAt.toISOString() })),
        recentTempEmails: tempRows.map((r) => ({ id: r.e.id, address: r.e.address, userEmail: r.u?.email ?? null, expiresAt: r.e.expiresAt.toISOString(), expired: r.e.expiresAt.getTime() <= now })),
        pendingTransactions: pendingTx.map((r) => ({
          id: r.t.publicId, type: r.t.type,
          plan: r.t.type === "plan_upgrade" ? (r.t.description?.startsWith("Gmail") ? "gmail" : "pro") : null,
          amount: r.t.amount, userEmail: r.u.email, createdAt: r.t.createdAt.toISOString(),
        })),
        planConfig: { gmailPriceCents: plan.gmailPriceCents, proPriceCents: plan.proPriceCents, freeTtlMinutes: plan.freeTtlMinutes },
        recentAudit: auditRows.map((row) => ({ id: row.id, action: row.action, createdAt: row.createdAt.toISOString() })),
      };
    },
  }),

  savePlanConfig: defineAction({
    request: z.object({ token: z.string().min(20), gmailPriceCents: z.number().int().min(100).max(10000), proPriceCents: z.number().int().min(100).max(10000), freeTtlMinutes: z.number().int().min(5).max(1440) }),
    response: z.object({ ok: z.boolean(), message: z.string(), planConfig: z.object({ gmailPriceCents: z.number(), proPriceCents: z.number(), freeTtlMinutes: z.number() }).nullable() }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user || user.role !== "admin") return { ok: false, message: "Admin access required.", planConfig: null };
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.planConfig).where(eq(schema.planConfig.id, 1)).limit(1);
      const values = { gmailPriceCents: args.gmailPriceCents, proPriceCents: args.proPriceCents, freeTtlMinutes: args.freeTtlMinutes, updatedByUserId: user.id, updatedAt: new Date() };
      if (existing[0]) await db.update(schema.planConfig).set(values).where(eq(schema.planConfig.id, 1));
      else await db.insert(schema.planConfig).values({ id: 1, ...values });
      await audit(ctx, user.id, "plan.config_updated");
      ctx.invalidateQueries();
      return { ok: true, message: "Plan settings saved.", planConfig: { gmailPriceCents: args.gmailPriceCents, proPriceCents: args.proPriceCents, freeTtlMinutes: args.freeTtlMinutes } };
    },
  }),

  completePlanUpgrade: defineAction({
    request: z.object({ token: z.string().min(20), transactionId: z.string().min(1), plan: paidPlanSchema }),
    response: okMessage,
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user || user.role !== "admin") return { ok: false, message: "Admin access required." };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.transactions).where(and(
        eq(schema.transactions.publicId, args.transactionId),
        eq(schema.transactions.type, "plan_upgrade"),
        eq(schema.transactions.status, "pending"),
      )).limit(1);
      const tx = rows[0];
      if (!tx) return { ok: false, message: "Pending upgrade request not found." };
      const now = new Date();
      const tierName = planDisplayName(args.plan);
      await db.update(schema.transactions).set({ status: "completed" }).where(eq(schema.transactions.id, tx.id));
      await db.update(schema.users).set({ plan: args.plan, planExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), updatedAt: now }).where(eq(schema.users.id, tx.userId));
      await audit(ctx, user.id, `plan.upgrade_completed:${tx.publicId}:${args.plan}`);
      ctx.invalidateQueries();
      return { ok: true, message: `${tierName} plan activated for 30 days.` };
    },
  }),

  getGoogleOAuthAdminConfig: defineAction({
    request: z.object({ token: z.string().min(20) }),
    response: googleAdminResponse,
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user || user.role !== "admin") return { ok: false, message: "Admin access required.", configured: false, clientIdHint: "", redirectUri: "", secretStored: false };
      const rows = await ctx.db<typeof schema>().select().from(schema.googleOAuthConfig).where(eq(schema.googleOAuthConfig.id, 1)).limit(1);
      const config = rows[0];
      const secretStored = Boolean(config?.clientSecret.trim());
      const redirectUri = config?.redirectUri ?? "";
      return {
        ok: true,
        message: "Google OAuth configuration loaded.",
        configured: Boolean(config?.clientId.trim() && secretStored && redirectUri.trim()),
        clientIdHint: clientIdHint(config?.clientId ?? ""),
        redirectUri,
        secretStored,
      };
    },
  }),

  saveGoogleOAuthConfig: defineAction({
    request: z.object({
      token: z.string().min(20),
      clientId: z.string().trim().min(20).max(300),
      clientSecret: z.string().max(500),
      redirectUri: z.string().trim().max(1000),
    }),
    response: googleAdminResponse,
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user || user.role !== "admin") return { ok: false, message: "Admin access required.", configured: false, clientIdHint: "", redirectUri: "", secretStored: false };
      if (!args.clientId.endsWith(".apps.googleusercontent.com")) return { ok: false, message: "Enter a valid Google OAuth web client ID.", configured: false, clientIdHint: "", redirectUri: args.redirectUri, secretStored: false };
      if (args.redirectUri && !safeRedirectUri(args.redirectUri)) return { ok: false, message: "Redirect URI must use HTTPS. Localhost HTTP is allowed for local testing.", configured: false, clientIdHint: clientIdHint(args.clientId), redirectUri: args.redirectUri, secretStored: false };
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.googleOAuthConfig).where(eq(schema.googleOAuthConfig.id, 1)).limit(1);
      const current = rows[0];
      const clientSecret = args.clientSecret.trim() || current?.clientSecret || "";
      if (current) {
        await db.update(schema.googleOAuthConfig).set({ clientId: args.clientId.trim(), clientSecret, redirectUri: args.redirectUri || null, updatedByUserId: user.id, updatedAt: new Date() }).where(eq(schema.googleOAuthConfig.id, 1));
      } else {
        await db.insert(schema.googleOAuthConfig).values({ id: 1, clientId: args.clientId.trim(), clientSecret, redirectUri: args.redirectUri || null, updatedByUserId: user.id, updatedAt: new Date() });
      }
      await audit(ctx, user.id, "oauth.google_configuration_updated");
      ctx.invalidateQueries();
      const configured = Boolean(args.clientId.trim() && clientSecret && args.redirectUri);
      return { ok: true, message: configured ? "Google sign-in is live." : "Google client saved. Add the secret and redirect URI to activate sign-in.", configured, clientIdHint: clientIdHint(args.clientId.trim()), redirectUri: args.redirectUri, secretStored: Boolean(clientSecret) };
    },
  }),

  beginGoogleOAuth: defineAction({
    request: z.object({}),
    response: googleStartResponse,
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.googleOAuthConfig).where(eq(schema.googleOAuthConfig.id, 1)).limit(1);
      const config = rows[0];
      if (!config?.clientId.trim() || !config.clientSecret.trim() || !config.redirectUri?.trim()) return { ok: false, message: "Google sign-in is not fully configured yet.", authorizationUrl: null };
      if (!safeRedirectUri(config.redirectUri)) return { ok: false, message: "The configured Google redirect URI is not valid.", authorizationUrl: null };
      const state = randomToken(32);
      const verifier = randomToken(48);
      await db.insert(schema.googleOAuthStates).values({ stateHash: await sha256(state), codeVerifier: verifier, redirectUri: config.redirectUri, expiresAt: new Date(Date.now() + 10 * 60 * 1000), createdAt: new Date() });
      const url = new URL(GOOGLE_AUTH_URL);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("response_type", "code");
      // Gmail read-only scope is added only when explicitly enabled — it is
      // needed later for the Pro "Gmail-connected mailbox" feature.
      const scopes = ["openid", "email", "profile"];
      if ((process.env.GOOGLE_GMAIL_SCOPE ?? "").trim().toLowerCase() === "true") {
        scopes.push("https://www.googleapis.com/auth/gmail.readonly");
      }
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", await pkceChallenge(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "select_account");
      return { ok: true, message: "Redirecting to Google…", authorizationUrl: url.toString() };
    },
  }),

  completeGoogleOAuth: defineAction({
    request: z.object({ code: z.string().min(1).max(4096), state: z.string().min(20).max(256) }),
    response: sessionResponse,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const stateRows = await db.select().from(schema.googleOAuthStates).where(and(eq(schema.googleOAuthStates.stateHash, await sha256(args.state)), gt(schema.googleOAuthStates.expiresAt, new Date()))).limit(1);
      const oauthState = stateRows[0];
      if (!oauthState) return { ok: false, message: "This Google sign-in request expired. Please try again.", token: null, role: null };
      await db.delete(schema.googleOAuthStates).where(eq(schema.googleOAuthStates.id, oauthState.id));
      const configRows = await db.select().from(schema.googleOAuthConfig).where(eq(schema.googleOAuthConfig.id, 1)).limit(1);
      const config = configRows[0];
      if (!config?.clientId || !config.clientSecret) return { ok: false, message: "Google sign-in is not configured.", token: null, role: null };
      try {
        const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code: args.code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: oauthState.redirectUri, grant_type: "authorization_code", code_verifier: oauthState.codeVerifier }),
        });
        if (!tokenResponse.ok) return { ok: false, message: "Google could not complete sign-in. Check the client secret and redirect URI.", token: null, role: null };
        const tokenResult = googleTokenResponse.safeParse(await tokenResponse.json());
        if (!tokenResult.success) return { ok: false, message: "Google returned an incomplete sign-in response.", token: null, role: null };
        const userResponse = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${tokenResult.data.access_token}` } });
        if (!userResponse.ok) return { ok: false, message: "Google profile details could not be verified.", token: null, role: null };
        const profileResult = googleUserResponse.safeParse(await userResponse.json());
        if (!profileResult.success || profileResult.data.email_verified === false) return { ok: false, message: "Google did not provide a verified email address.", token: null, role: null };
        const profile = profileResult.data;
        const email = profile.email.toLowerCase();
        const googleRows = await db.select().from(schema.users).where(eq(schema.users.googleUserId, profile.sub)).limit(1);
        const emailRows = googleRows[0] ? [] : await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
        let user = googleRows[0] ?? emailRows[0];
        const now = new Date();
        if (user) {
          if (user.accountStatus === "suspended") return { ok: false, message: "This account is suspended.", token: null, role: null };
          await db.update(schema.users).set({ googleUserId: profile.sub, name: profile.name, profileImage: profile.picture ?? user.profileImage, emailVerified: true, accountStatus: "active", lastLoginAt: now, updatedAt: now }).where(eq(schema.users.id, user.id));
        } else {
          const inserted = await db.insert(schema.users).values({ name: profile.name, email, googleUserId: profile.sub, profileImage: profile.picture ?? null, emailVerified: true, accountStatus: "active", role: "user", plan: "free", createdAt: now, updatedAt: now, lastLoginAt: now }).returning();
          user = inserted[0];
          if (!user) return { ok: false, message: "Fast Temp Mail could not create your account.", token: null, role: null };
          await db.insert(schema.wallets).values({ userId: user.id, balance: 0, currency: "USD", createdAt: now, updatedAt: now });
        }
        const token = await createSession(ctx, user.id);
        await audit(ctx, user.id, "auth.google_login");
        return { ok: true, message: "Signed in with Google.", token, role: user.role };
      } catch {
        return { ok: false, message: "Google sign-in is temporarily unavailable. Please try again.", token: null, role: null };
      }
    },
  }),

  /* ================= Virtual numbers (SMS receiving) ================= */

  getSmsConfig: defineAction({
    request: z.object({}),
    response: z.object({
      twilioReady: z.boolean(),
      numberPriceUSD: z.number(),
      rentalDays: z.number(),
      webhookUrl: z.string(),
    }),
    async handler() {
      const { twilioSmsWebhookUrl } = await import("./sms");
      return {
        twilioReady: twilioConfigured(),
        numberPriceUSD: SMS_NUMBER_PRICE_USD,
        rentalDays: SMS_NUMBER_RENTAL_DAYS,
        webhookUrl: twilioSmsWebhookUrl(),
      };
    },
  }),

  listVirtualNumbers: defineAction({
    request: z.object({ token: z.string().min(20) }),
    response: z.object({
      numbers: z.array(z.object({
        id: z.number(),
        phoneNumber: z.string(),
        status: z.string(),
        expiresAt: z.string(),
        unread: z.number(),
      })),
    }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) throw new Error("Session expired. Sign in again.");
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.virtualNumbers)
        .where(eq(schema.virtualNumbers.userId, user.id))
        .orderBy(desc(schema.virtualNumbers.createdAt)).limit(20);
      const numbers = [];
      for (const row of rows) {
        const unread = await db.select({ id: schema.smsMessages.id }).from(schema.smsMessages)
          .where(and(eq(schema.smsMessages.numberId, row.id), eq(schema.smsMessages.isRead, false)));
        numbers.push({
          id: row.id,
          phoneNumber: row.phoneNumber,
          status: row.status,
          expiresAt: row.expiresAt.toISOString(),
          unread: unread.length,
        });
      }
      return { numbers };
    },
  }),

  rentVirtualNumber: defineAction({
    request: z.object({ token: z.string().min(20) }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      number: z.object({ id: z.number(), phoneNumber: z.string(), expiresAt: z.string() }).nullable(),
    }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) return { ok: false, message: "Session expired. Sign in again.", number: null };
      if (!twilioConfigured()) {
        return { ok: false, message: "SMS receiving is not configured yet (Twilio). The administrator needs to connect a Twilio account first.", number: null };
      }
      const db = ctx.db<typeof schema>();
      const activeCount = await db.select({ id: schema.virtualNumbers.id }).from(schema.virtualNumbers)
        .where(and(eq(schema.virtualNumbers.userId, user.id), eq(schema.virtualNumbers.status, "active")));
      if (activeCount.length >= 3) {
        return { ok: false, message: "You already have 3 active numbers — release one before renting another.", number: null };
      }
      const walletRows = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, user.id)).limit(1);
      const wallet = walletRows[0];
      if (!wallet) return { ok: false, message: "Wallet not found.", number: null };
      if (wallet.balance < SMS_NUMBER_PRICE_USD) {
        return { ok: false, message: `Insufficient balance. A number costs $${SMS_NUMBER_PRICE_USD.toFixed(2)} for ${SMS_NUMBER_RENTAL_DAYS} days — please deposit first.`, number: null };
      }
      let bought: { phoneNumber: string; sid: string };
      try {
        bought = await buyTwilioNumber();
      } catch (err) {
        console.error("[sms] number purchase failed:", err);
        return { ok: false, message: "Could not rent a number right now. Please try again later.", number: null };
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + SMS_NUMBER_RENTAL_DAYS * 24 * 60 * 60 * 1000);
      const publicId = `ZM-${Date.now().toString(36).toUpperCase()}-${randomToken(3).toUpperCase()}`;
      await db.update(schema.wallets)
        .set({ balance: Math.round((wallet.balance - SMS_NUMBER_PRICE_USD) * 100) / 100, updatedAt: now })
        .where(eq(schema.wallets.id, wallet.id));
      await db.insert(schema.transactions).values({
        publicId, userId: user.id, walletId: wallet.id, type: "debit",
        amount: SMS_NUMBER_PRICE_USD, currency: "USD", status: "completed",
        provider: "twilio", description: `Virtual number rental ${bought.phoneNumber} (${SMS_NUMBER_RENTAL_DAYS} days)`,
        createdAt: now,
      });
      const inserted = await db.insert(schema.virtualNumbers).values({
        userId: user.id, phoneNumber: bought.phoneNumber, provider: "twilio",
        providerSid: bought.sid, status: "active",
        rentedAt: now, expiresAt, createdAt: now, updatedAt: now,
      }).returning();
      await audit(ctx, user.id, "sms.number_rented");
      ctx.invalidateQueries();
      const row = inserted[0];
      return {
        ok: true,
        message: `Number ${bought.phoneNumber} is active for ${SMS_NUMBER_RENTAL_DAYS} days. Share it anywhere — incoming SMS will appear in its inbox.`,
        number: row ? { id: row.id, phoneNumber: row.phoneNumber, expiresAt: row.expiresAt.toISOString() } : null,
      };
    },
  }),

  getSmsInbox: defineAction({
    request: z.object({ token: z.string().min(20), numberId: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      message: z.string(),
      messages: z.array(z.object({
        id: z.number(), sender: z.string(), body: z.string(),
        receivedAt: z.string(), isRead: z.boolean(),
      })),
    }),
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) return { ok: false, message: "Session expired. Sign in again.", messages: [] };
      const db = ctx.db<typeof schema>();
      const numRows = await db.select().from(schema.virtualNumbers)
        .where(and(eq(schema.virtualNumbers.id, args.numberId), eq(schema.virtualNumbers.userId, user.id))).limit(1);
      const number = numRows[0];
      if (!number) return { ok: false, message: "Number not found.", messages: [] };
      const msgs = await db.select().from(schema.smsMessages)
        .where(eq(schema.smsMessages.numberId, number.id))
        .orderBy(desc(schema.smsMessages.receivedAt)).limit(100);
      await db.update(schema.smsMessages).set({ isRead: true })
        .where(eq(schema.smsMessages.numberId, number.id));
      return {
        ok: true, message: "ok",
        messages: msgs.map((m) => ({
          id: m.id, sender: m.sender, body: m.body,
          receivedAt: m.receivedAt.toISOString(), isRead: m.isRead,
        })),
      };
    },
  }),

  releaseVirtualNumber: defineAction({
    request: z.object({ token: z.string().min(20), numberId: z.number().int().positive() }),
    response: okMessage,
    async handler(ctx, args) {
      const user = await sessionUser(ctx, args.token);
      if (!user) return { ok: false, message: "Session expired. Sign in again." };
      const db = ctx.db<typeof schema>();
      const numRows = await db.select().from(schema.virtualNumbers)
        .where(and(eq(schema.virtualNumbers.id, args.numberId), eq(schema.virtualNumbers.userId, user.id))).limit(1);
      const number = numRows[0];
      if (!number) return { ok: false, message: "Number not found." };
      if (number.status !== "active") return { ok: false, message: "This number is already released." };
      if (number.providerSid && twilioConfigured()) {
        try { await releaseTwilioNumber(number.providerSid); } catch (err) {
          console.error("[sms] Twilio release failed:", err);
        }
      }
      await db.update(schema.virtualNumbers)
        .set({ status: "released", releasedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.virtualNumbers.id, number.id));
      await audit(ctx, user.id, "sms.number_released");
      ctx.invalidateQueries();
      return { ok: true, message: `Number ${number.phoneNumber} has been released. Its SMS history stays in your account.` };
    },
  }),

} satisfies ActionsModule;
