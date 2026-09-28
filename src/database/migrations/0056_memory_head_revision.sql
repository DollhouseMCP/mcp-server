-- Monotonic revision for version-checked memory head writes. The trigger also
-- covers older name-keyed writers, so a stale snapshot cannot pass after a
-- content A -> B -> A cycle. The counter is internal and never uses JS number.
ALTER TABLE "elements"
  ADD COLUMN "storage_revision" BIGINT NOT NULL DEFAULT 1;
ALTER TABLE "elements"
  ADD CONSTRAINT "elements_storage_revision_positive" CHECK ("storage_revision" > 0);
--> statement-breakpoint

CREATE FUNCTION bump_element_storage_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.storage_revision := OLD.storage_revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER elements_storage_revision_update
  BEFORE UPDATE ON "elements"
  FOR EACH ROW EXECUTE FUNCTION bump_element_storage_revision();
--> statement-breakpoint

-- Entry-level APIs may mutate memory_entries without writing raw_content.
-- Bump the owning head before each child mutation so a previously captured
-- head token cannot authorize a stale whole-document replacement afterward.
-- A conflicting direct child write may deadlock with a whole-head sync and be
-- aborted by PostgreSQL; it must not silently commit a stale head revision.
CREATE FUNCTION bump_memory_entry_head_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "elements" SET "updated_at" = NOW()
      WHERE "id" = NEW."memory_id" AND "user_id" = NEW."user_id" AND "element_type" = 'memories';
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "elements" SET "updated_at" = NOW()
      WHERE "id" = OLD."memory_id" AND "user_id" = OLD."user_id" AND "element_type" = 'memories';
    RETURN OLD;
  END IF;

  -- Moving an entry between heads is not exposed by the application, but a
  -- direct UPDATE must invalidate both snapshots. Use a stable update order.
  IF (OLD."memory_id", OLD."user_id") IS DISTINCT FROM (NEW."memory_id", NEW."user_id") THEN
    IF OLD."memory_id" < NEW."memory_id" THEN
      UPDATE "elements" SET "updated_at" = NOW()
        WHERE "id" = OLD."memory_id" AND "user_id" = OLD."user_id" AND "element_type" = 'memories';
      UPDATE "elements" SET "updated_at" = NOW()
        WHERE "id" = NEW."memory_id" AND "user_id" = NEW."user_id" AND "element_type" = 'memories';
    ELSE
      UPDATE "elements" SET "updated_at" = NOW()
        WHERE "id" = NEW."memory_id" AND "user_id" = NEW."user_id" AND "element_type" = 'memories';
      UPDATE "elements" SET "updated_at" = NOW()
        WHERE "id" = OLD."memory_id" AND "user_id" = OLD."user_id" AND "element_type" = 'memories';
    END IF;
  ELSE
    UPDATE "elements" SET "updated_at" = NOW()
      WHERE "id" = NEW."memory_id" AND "user_id" = NEW."user_id" AND "element_type" = 'memories';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_entries_head_revision_change
  BEFORE INSERT OR UPDATE OR DELETE ON "memory_entries"
  FOR EACH ROW EXECUTE FUNCTION bump_memory_entry_head_revision();
