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

-- Console rows retain display_value specifically so normalization policy can be
-- upgraded without guessing the intended principal from an older lookup key.
-- Recompute the active-key candidate from that preserved identity, then fail
-- closed if the new key would collide.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        "kind",
        CASE
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
    WHEN "kind" IN ('email', 'github_username') THEN translate(
      normalize(btrim("display_value"), NFC),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxyz'
    )
    ELSE normalize(btrim("display_value"), NFC)
  END,
  "display_value" = normalize(btrim("display_value"), NFC)
WHERE
  "normalized_value" IS DISTINCT FROM CASE
    WHEN "kind" IN ('email', 'github_username') THEN translate(
      normalize(btrim("display_value"), NFC),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'abcdefghijklmnopqrstuvwxyz'
    )
    ELSE normalize(btrim("display_value"), NFC)
  END
  OR "display_value" IS DISTINCT FROM normalize(btrim("display_value"), NFC);
