CREATE TABLE IF NOT EXISTS "virtual_numbers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"phone_number" text NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"provider_sid" text,
	"status" text DEFAULT 'active' NOT NULL,
	"rented_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sms_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"number_id" integer NOT NULL,
	"sender" text NOT NULL,
	"body" text NOT NULL,
	"provider_sid" text,
	"received_at" timestamp with time zone NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "virtual_numbers" ADD CONSTRAINT "virtual_numbers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_number_id_virtual_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."virtual_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "virtual_numbers_phone_unique" ON "virtual_numbers" USING btree ("phone_number");