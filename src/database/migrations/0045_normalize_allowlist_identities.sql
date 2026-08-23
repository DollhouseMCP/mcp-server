-- Canonicalize authorization allowlist identities written before the NFC-only
-- identity policy. This migration deliberately does not use compatibility or
-- confusable mappings: visually similar characters from different scripts must
-- remain distinct security principals.

-- Abort before changing data if NFC + trim would collapse two embedded-AS rows.
-- The existing unique index cannot detect canonically equivalent byte sequences.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "kind", normalize(btrim("value"), NFC) AS "next_value"
      FROM "auth_allowlist"
    ) AS "canonical_auth_allowlist"
    GROUP BY "kind", "next_value"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'auth_allowlist contains identities that collide after NFC normalization; resolve them before upgrading';
  END IF;
END $$;

UPDATE "auth_allowlist"
SET "value" = normalize(btrim("value"), NFC)
WHERE "value" IS DISTINCT FROM normalize(btrim("value"), NFC);

-- Versions deployed between the account-allowlist introduction and the
-- NFC-only identity policy passed display_value through a lossy confusable
-- mapping. For those rows, neither persisted column can prove the principal
-- originally entered by the operator. Preserve a durable pre-migration ledger
-- so operators must verify or recreate every legacy active entry before this
-- dormant console table is promoted to the sign-in authority. Do not restore
-- the lossy matcher: that would make distinct cross-script principals equal.
CREATE TABLE IF NOT EXISTS "account_allowlist_identity_migration_reviews" (
  "entry_id" UUID PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "legacy_normalized_value" TEXT NOT NULL,
  "legacy_display_value" TEXT NOT NULL,
  "captured_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "reviewed_at" TIMESTAMPTZ,
  "review_note" TEXT
);

INSERT INTO "account_allowlist_identity_migration_reviews" (
  "entry_id",
  "kind",
  "legacy_normalized_value",
  "legacy_display_value"
)
SELECT
  "id",
  "kind",
  "normalized_value",
  "display_value"
FROM "account_allowlist_entries"
WHERE "revoked_at" IS NULL
ON CONFLICT ("entry_id") DO NOTHING;

DO $$
DECLARE
  pending_review_count BIGINT;
BEGIN
  SELECT count(*) INTO pending_review_count
  FROM "account_allowlist_identity_migration_reviews"
  WHERE "reviewed_at" IS NULL;

  IF pending_review_count > 0 THEN
    RAISE WARNING
      '% active console allowlist entries require identity review before account-allowlist authority cutover',
      pending_review_count;
  END IF;
END $$;

-- Recompute the best available active-key candidate from display_value for
-- NFC/casing compatibility, then fail closed if those candidates collide.
-- The review ledger above is the authority for legacy-origin uncertainty.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        "kind",
        CASE
          -- Keep casing ASCII-only. PostgreSQL lower() is locale-aware and can
          -- alter a non-ASCII security principal.
          WHEN "kind" IN ('email', 'github_username') THEN translate(
            normalize(btrim("display_value"), NFC),
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
            'abcdefghijklmnopqrstuvwxyz'
          )
          ELSE normalize(btrim("display_value"), NFC)
        END AS "next_value"
      FROM "account_allowlist_entries"
      WHERE "revoked_at" IS NULL
    ) AS "canonical_console_allowlist"
    GROUP BY "kind", "next_value"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'account_allowlist_entries contains active identities that collide after NFC normalization; resolve them before upgrading';
  END IF;
END $$;

UPDATE "account_allowlist_entries"
SET
  "normalized_value" = CASE
    -- Keep casing ASCII-only. PostgreSQL lower() is locale-aware and can alter
    -- a non-ASCII security principal.
    WHEN "kind" IN ('email', 'github_username') THEN translate(
      normalize(btrim("display_value"), NFC),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxyz'
    )
    ELSE normalize(btrim("display_value"), NFC)
  END,
  "display_value" = normalize(btrim("display_value"), NFC)
WHERE
  "revoked_at" IS NULL
  AND (
    "normalized_value" IS DISTINCT FROM CASE
      -- Match the ASCII-only casing policy used above.
      WHEN "kind" IN ('email', 'github_username') THEN translate(
        normalize(btrim("display_value"), NFC),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'abcdefghijklmnopqrstuvwxyz'
      )
      ELSE normalize(btrim("display_value"), NFC)
    END
    OR "display_value" IS DISTINCT FROM normalize(btrim("display_value"), NFC)
  );
