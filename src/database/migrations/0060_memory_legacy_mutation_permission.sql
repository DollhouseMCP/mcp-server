-- Dormant explicit legacy permission. No runtime seed/promotion or activation.
ALTER TABLE public.memory_backend_modes DROP CONSTRAINT memory_backend_modes_mode_check;
--> statement-breakpoint
ALTER TABLE public.memory_backend_modes ADD CONSTRAINT memory_backend_modes_mode_check
  CHECK (mode IN ('legacy', 'guarded', 'read_only'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.memory_backend_modes_guard() RETURNS trigger
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
    IF OLD.mode IN ('guarded', 'read_only') AND NEW.mode = 'legacy' THEN
      RAISE EXCEPTION 'Protected memory mode cannot return to legacy' USING ERRCODE = '23514';
    END IF;
    -- PostgreSQL bigint overflow refuses; a generation is never reused.
    NEW.generation := OLD.generation + 1;
  END IF;
  RETURN NEW;
END;
$$;
