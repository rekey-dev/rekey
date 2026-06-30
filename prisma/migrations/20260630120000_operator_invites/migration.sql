-- Deploy-time operator-registration control (OPERATOR_SIGNUP_MODE='invite').
-- Single-use invite keys minted by the super-admin and consumed atomically at
-- operator sign-up. Hash-only: the raw key is never stored.
CREATE TABLE "operator_invites" (
    "id" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_admin" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "expires_at" TIMESTAMP(3),
    "used_at" TIMESTAMP(3),
    "used_by_tenant_user_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_invites_pkey" PRIMARY KEY ("id")
);

-- One row per raw key; a duplicate mint can never collide.
CREATE UNIQUE INDEX "operator_invites_token_hash_key" ON "operator_invites"("token_hash");

CREATE INDEX "operator_invites_expires_at_idx" ON "operator_invites"("expires_at");

-- Null the consumer link if the operator account is ever deleted; keep the
-- invite row as an audit record.
ALTER TABLE "operator_invites" ADD CONSTRAINT "operator_invites_used_by_tenant_user_id_fkey" FOREIGN KEY ("used_by_tenant_user_id") REFERENCES "tenant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
