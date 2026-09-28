import { boolean, integer, pgTable, real, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * PostgreSQL schema for the standalone Fast Temp Mail export.
 *
 * Fast Temp Mail is a temporary-email service with accounts, wallets and plans.
 * Tables:
 * - users / email_verifications / password_resets / login_sessions /
 *   audit_logs — auth & security (same proven session/auth pattern).
 * - wallets / transactions — per-user USD wallet; transaction types include
 *   "deposit" (crypto, manual verification) and "plan_upgrade" (Pro plan).
 * - temp_emails / temp_messages — disposable addresses. `user_id` is
 *   nullable: anonymous visitors' addresses are tracked client-side in
 *   localStorage, while signed-in users' addresses are linked to their
 *   account. Anyone who knows an address can read its inbox — that is how
 *   disposable mail works.
 * - plan_config — single-row (id=1) admin-editable plan settings.
 * - google_oauth_config / google_oauth_states — "Continue with Google".
 *
 * Fresh installs apply the single consolidated drizzle migration at boot.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  googleUserId: text("google_user_id"),
  profileImage: text("profile_image"),
  emailVerified: boolean("email_verified").notNull().default(false),
  accountStatus: text("account_status", { enum: ["active", "pending", "suspended"] }).notNull().default("pending"),
  role: text("role", { enum: ["user", "admin"] }).notNull().default("user"),
  plan: text("plan", { enum: ["free", "gmail", "pro"] }).notNull().default("free"),
  planExpiresAt: timestamp("plan_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const emailVerifications = pgTable("email_verifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  otpHash: text("otp_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const wallets = pgTable("wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  balance: real("balance").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("wallets_user_unique").on(table.userId)]);

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  publicId: text("public_id").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  walletId: integer("wallet_id").notNull().references(() => wallets.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["deposit", "credit", "debit", "plan_upgrade"] }).notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status", { enum: ["pending", "completed", "failed", "cancelled"] }).notNull(),
  provider: text("provider").notNull(),
  providerTransactionId: text("provider_transaction_id"),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const tempEmails = pgTable("temp_emails", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  localPart: text("local_part").notNull(),
  domain: text("domain").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("temp_emails_address_unique").on(table.address)]);

export const tempMessages = pgTable("temp_messages", {
  id: serial("id").primaryKey(),
  tempEmailId: integer("temp_email_id").notNull().references(() => tempEmails.id, { onDelete: "cascade" }),
  sender: text("sender").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  isRead: boolean("is_read").notNull().default(false),
});

export const planConfig = pgTable("plan_config", {
  id: integer("id").primaryKey(),
  gmailPriceCents: integer("gmail_price_cents").notNull().default(250),
  proPriceCents: integer("pro_price_cents").notNull().default(300),
  freeTtlMinutes: integer("free_ttl_minutes").notNull().default(1440),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const loginSessions = pgTable("login_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionTokenHash: text("session_token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("sessions_token_unique").on(table.sessionTokenHash)]);

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const googleOAuthConfig = pgTable("google_oauth_config", {
  id: integer("id").primaryKey(),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
  redirectUri: text("redirect_uri"),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const googleOAuthStates = pgTable("google_oauth_states", {
  id: serial("id").primaryKey(),
  stateHash: text("state_hash").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("google_oauth_states_state_unique").on(table.stateHash)]);
