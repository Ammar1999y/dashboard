CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"requester" varchar(64) NOT NULL,
	"code" varchar(255) NOT NULL,
	"expires_at" timestamp (2) with time zone NOT NULL,
	"guesses" integer DEFAULT 0 NOT NULL,
	"next_allowed_at" timestamp (2) with time zone NOT NULL,
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_otp_challenges_guesses_non_negative" CHECK (guesses >= 0),
	CONSTRAINT "chk_otp_challenges_guesses_max" CHECK (guesses <= 3)
);
--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_session_id_verification_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."verification_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_otp_challenges_session_requester" ON "otp_challenges" USING btree ("session_id","requester");--> statement-breakpoint
CREATE INDEX "idx_otp_challenges_expires_at" ON "otp_challenges" USING btree ("expires_at");