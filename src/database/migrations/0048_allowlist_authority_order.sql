-- Use a database-issued monotonic order for allowlist grant/revocation
-- precedence. Application timestamps can be skewed across replicas and are
-- retained only as operator-facing provenance.

CREATE SEQUENCE IF NOT EXISTS "account_allowlist_authority_order_seq";

ALTER TABLE "account_allowlist_entries"
  ADD COLUMN IF NOT EXISTS "authority_order" BIGINT;

WITH ordered AS (
  SELECT
    "id",
    row_number() OVER (
      ORDER BY GREATEST("created_at", COALESCE("revoked_at", "created_at")), "id"
    ) AS authority_order
  FROM "account_allowlist_entries"
  WHERE "authority_order" IS NULL
)
UPDATE "account_allowlist_entries" AS target
SET "authority_order" = ordered.authority_order
FROM ordered
WHERE target."id" = ordered."id";

SELECT setval(
  'account_allowlist_authority_order_seq',
  COALESCE((SELECT MAX("authority_order") FROM "account_allowlist_entries"), 1),
  EXISTS (SELECT 1 FROM "account_allowlist_entries")
);

ALTER TABLE "account_allowlist_entries"
  ALTER COLUMN "authority_order"
    SET DEFAULT nextval('account_allowlist_authority_order_seq'),
  ALTER COLUMN "authority_order" SET NOT NULL;

ALTER SEQUENCE "account_allowlist_authority_order_seq"
  OWNED BY "account_allowlist_entries"."authority_order";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_account_allowlist_entries_authority_order"
  ON "account_allowlist_entries" ("authority_order");
