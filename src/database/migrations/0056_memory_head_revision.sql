-- Monotonic revision for version-checked memory head writes. The trigger also
-- covers older name-keyed writers, so a stale snapshot cannot pass after a
-- content A -> B -> A cycle. The counter is internal and never uses JS number.
ALTER TABLE "elements"
  ADD COLUMN "storage_revision" BIGINT NOT NULL DEFAULT 1;
ALTER TABLE "elements"
  ADD CONSTRAINT "elements_storage_revision_positive" CHECK ("storage_revision" > 0);
ALTER TABLE "elements"
  ADD COLUMN "memory_entries_out_of_sync" BOOLEAN NOT NULL DEFAULT TRUE;
--> statement-breakpoint

CREATE FUNCTION bump_element_storage_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.storage_revision := OLD.storage_revision + 1;
  IF OLD.element_type = 'memories' AND NEW.raw_content IS DISTINCT FROM OLD.raw_content THEN
    NEW.memory_entries_out_of_sync := TRUE;
  END IF;
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
CREATE FUNCTION mark_memory_head_out_of_sync(p_memory_id UUID, p_user_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE affected INTEGER;
BEGIN
  UPDATE "elements" SET "updated_at" = NOW(), "memory_entries_out_of_sync" = TRUE
    WHERE "id" = p_memory_id AND "user_id" = p_user_id AND "element_type" = 'memories';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;
CREATE FUNCTION bump_memory_entry_head_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") THEN
      RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- Cascading parent deletion has no remaining head to invalidate.
    PERFORM mark_memory_head_out_of_sync(OLD."memory_id", OLD."user_id");
    RETURN OLD;
  END IF;

  -- Moving an entry between heads is not exposed by the application, but a
  -- direct UPDATE must invalidate both snapshots. Use a stable update order.
  IF (OLD."memory_id", OLD."user_id") IS DISTINCT FROM (NEW."memory_id", NEW."user_id") THEN
    IF OLD."memory_id" < NEW."memory_id" THEN
      IF NOT mark_memory_head_out_of_sync(OLD."memory_id", OLD."user_id") OR
         NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") THEN
        RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
      END IF;
    ELSE
      IF NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") OR
         NOT mark_memory_head_out_of_sync(OLD."memory_id", OLD."user_id") THEN
        RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
      END IF;
    END IF;
  ELSE
    IF NOT mark_memory_head_out_of_sync(NEW."memory_id", NEW."user_id") THEN
      RAISE EXCEPTION 'Memory entry owner does not match a live memory head' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_entries_head_revision_change
  BEFORE INSERT OR UPDATE OR DELETE ON "memory_entries"
  FOR EACH ROW EXECUTE FUNCTION bump_memory_entry_head_revision();
