-- Dormant DB admission foundation. No seed, promotion or production composition.
CREATE TABLE "memory_backend_modes" (
  "user_id" uuid NOT NULL,
  "backend" text NOT NULL,
  "protocol_version" integer NOT NULL,
  "profile" text NOT NULL,
  "mode" text NOT NULL,
  "generation" bigint NOT NULL,
  PRIMARY KEY ("user_id", "backend"),
  CONSTRAINT "memory_backend_modes_backend_check" CHECK ("backend" = 'database'),
  CONSTRAINT "memory_backend_modes_protocol_check" CHECK ("protocol_version" > 0),
  CONSTRAINT "memory_backend_modes_profile_check" CHECK (length("profile") > 0),
  CONSTRAINT "memory_backend_modes_mode_check" CHECK ("mode" IN ('guarded', 'read_only')),
  CONSTRAINT "memory_backend_modes_generation_check" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "memory_backend_modes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memory_backend_modes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "memory_backend_modes_select" ON "memory_backend_modes" FOR SELECT
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
-- FOR SHARE applies UPDATE USING too. WITH CHECK(false) forbids actual updates,
-- including no-op updates, even under a broad existing runtime CRUD grant.
CREATE POLICY "memory_backend_modes_lock" ON "memory_backend_modes" FOR UPDATE
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (false);
--> statement-breakpoint
CREATE FUNCTION public.memory_backend_modes_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Durable memory mode cannot be deleted' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.generation <> 1 THEN
      RAISE EXCEPTION 'Initial memory mode generation must be one' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.backend IS DISTINCT FROM OLD.backend THEN
      RAISE EXCEPTION 'Durable memory mode identity cannot change' USING ERRCODE = '23514';
    END IF;
    -- PostgreSQL bigint overflow refuses; a generation is never reused.
    NEW.generation := OLD.generation + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "memory_backend_modes_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "memory_backend_modes" FOR EACH ROW EXECUTE FUNCTION public.memory_backend_modes_guard();
