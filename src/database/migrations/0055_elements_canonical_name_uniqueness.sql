-- Keep upgrades compatible with portfolios that already contain two distinct
-- names with the same canonical form. A regular expression index makes the
-- trigger lookup efficient without forcing operators to delete or silently
-- rename legacy elements during migration.
CREATE INDEX IF NOT EXISTS "idx_elements_user_type_canonical_name"
ON "elements" (
  "user_id",
  "element_type",
  trim(both '-' from regexp_replace(regexp_replace(lower(btrim("name")), '[[:space:]_]+', '-', 'g'), '-+', '-', 'g'))
);

CREATE OR REPLACE FUNCTION "dollhouse_element_canonical_name"("value" text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT trim(both '-' from regexp_replace(regexp_replace(lower(btrim("value")), '[[:space:]_]+', '-', 'g'), '-+', '-', 'g'))
$function$;

CREATE OR REPLACE FUNCTION "enforce_elements_canonical_name_uniqueness"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  canonical_name text := public."dollhouse_element_canonical_name"(NEW."name");
BEGIN
  -- Existing installations can contain legacy canonical collisions. An edit
  -- that keeps this row in the same canonical identity does not create a new
  -- collision and must remain possible (including ordinary CAS content edits
  -- that write the unchanged name back). Moves to a different identity still
  -- pass through the serialized uniqueness check below.
  IF TG_OP = 'UPDATE'
    AND OLD."user_id" = NEW."user_id"
    AND OLD."element_type" = NEW."element_type"
    AND public."dollhouse_element_canonical_name"(OLD."name") = canonical_name
  THEN
    RETURN NEW;
  END IF;

  -- Serialize same-canonical writers before checking. A hash collision can
  -- only add contention; the exact equality query remains authoritative.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(NEW."user_id", NEW."element_type", canonical_name)::text,
    0
  ));

  -- INSERT ... ON CONFLICT DO UPDATE reaches BEFORE INSERT before PostgreSQL
  -- selects the exact-name conflict row. Let the table's existing exact-name
  -- unique index arbitrate that case: normal upserts update it, while plain
  -- exclusive inserts still fail with 23505. Different spellings that share a
  -- canonical form continue through the collision check below.
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1
    FROM public."elements" AS exact_existing
    WHERE exact_existing."user_id" = NEW."user_id"
      AND exact_existing."element_type" = NEW."element_type"
      AND exact_existing."name" = NEW."name"
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."elements" AS existing
    WHERE existing."user_id" = NEW."user_id"
      AND existing."element_type" = NEW."element_type"
      AND public."dollhouse_element_canonical_name"(existing."name") = canonical_name
      AND existing."id" IS DISTINCT FROM NEW."id"
  ) THEN
    RAISE unique_violation
      USING MESSAGE = 'duplicate canonical element name',
            CONSTRAINT = 'idx_elements_user_type_canonical_name';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "elements_canonical_name_uniqueness" ON "elements";
CREATE TRIGGER "elements_canonical_name_uniqueness"
BEFORE INSERT OR UPDATE OF "user_id", "element_type", "name" ON "elements"
FOR EACH ROW
EXECUTE FUNCTION "enforce_elements_canonical_name_uniqueness"();
