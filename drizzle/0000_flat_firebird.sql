CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"otp_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_oauth_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"redirect_uri" text,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_oauth_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"gmail_price_cents" integer DEFAULT 250 NOT NULL,
	"pro_price_cents" integer DEFAULT 300 NOT NULL,
	"free_ttl_minutes" integer DEFAULT 1440 NOT NULL,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temp_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"address" text NOT NULL,
	"local_part" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temp_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"temp_email_id" integer NOT NULL,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"wallet_id" integer NOT NULL,
	"type" text NOT NULL,
	"amount" real NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"provider_transaction_id" text,
	"description" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"google_user_id" text,
	"profile_image" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"account_status" text DEFAULT 'pending' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"plan_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"balance" real DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_oauth_config" ADD CONSTRAINT "google_oauth_config_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_sessions" ADD CONSTRAINT "login_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_config" ADD CONSTRAINT "plan_config_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temp_emails" ADD CONSTRAINT "temp_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temp_messages" ADD CONSTRAINT "temp_messages_temp_email_id_temp_emails_id_fk" FOREIGN KEY ("temp_email_id") REFERENCES "public"."temp_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_oauth_states_state_unique" ON "google_oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_unique" ON "login_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "temp_emails_address_unique" ON "temp_emails" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_unique" ON "wallets" USING btree ("user_id");