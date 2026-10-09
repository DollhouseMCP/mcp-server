-- Dormant DB UPDATE candidate preservation. No seed, admission or production activation.
-- Quota provisioning belongs to privileged fresh qualification; missing quota refuses.
CREATE TABLE public.memory_candidate_quotas (
  user_id uuid PRIMARY KEY,
  retained_rows integer NOT NULL DEFAULT 0 CHECK (retained_rows BETWEEN 0 AND 64),
  retained_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_bytes BETWEEN 0 AND 67108864)
);
--> statement-breakpoint
ALTER TABLE public.memory_candidate_quotas ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.memory_candidate_quotas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A SECURITY DEFINER trigger may account reservations; broad runtime CRUD grants
-- still cannot insert, reset or change this relation. Ordinary role qualification
-- excludes SUPERUSER/BYPASSRLS; handoff also refuses ownership of these
-- relations. Do not grant the schema owner role to the application.
CREATE POLICY memory_candidate_quota_owner ON public.memory_candidate_quotas FOR ALL
  USING (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.memory_candidate_quotas'::regclass)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.memory_candidate_quotas'::regclass)));
--> statement-breakpoint
CREATE TABLE public.memory_candidate_handoffs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  envelope bytea NOT NULL CHECK (octet_length(envelope) BETWEEN 1 AND 1048576),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  retire_hash text NOT NULL CHECK (retire_hash ~ '^[0-9a-f]{64}$'),
  envelope_bytes integer NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'refused', 'committed', 'published')),
  committed_token jsonb CHECK (committed_token IS NULL OR octet_length(committed_token::text) <= 4096),
  CHECK (envelope_bytes = octet_length(envelope) + COALESCE(octet_length(committed_token::text),0)),
  CHECK (envelope_bytes BETWEEN 1 AND 1048576),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status IN ('prepared','refused') AND committed_token IS NULL) OR
         (status IN ('committed','published') AND committed_token IS NOT NULL AND jsonb_typeof(committed_token) = 'object'))
);
--> statement-breakpoint
ALTER TABLE public.memory_candidate_handoffs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.memory_candidate_handoffs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memory_candidate_handoff_select ON public.memory_candidate_handoffs FOR SELECT
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY memory_candidate_handoff_insert ON public.memory_candidate_handoffs FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY memory_candidate_handoff_update ON public.memory_candidate_handoffs FOR UPDATE
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY memory_candidate_handoff_delete ON public.memory_candidate_handoffs FOR DELETE
  USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid AND status = 'published');
--> statement-breakpoint
CREATE FUNCTION public.memory_candidate_handoff_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  counted_rows bigint;
  counted_bytes bigint;
  quota_rows integer;
  quota_bytes bigint;
  secret text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS DISTINCT FROM NULLIF(current_setting('app.current_user_id', true), '')::uuid OR
       NEW.status <> 'prepared' OR NEW.committed_token IS NOT NULL OR
       encode(sha256(NEW.envelope), 'hex') <> NEW.digest THEN
      RAISE EXCEPTION 'Invalid candidate handoff reservation' USING ERRCODE = '23514';
    END IF;
    -- Actual bytes, never a caller-declared length. Counter lock serializes reservations.
    NEW.envelope_bytes := octet_length(NEW.envelope);
    SELECT retained_rows, retained_bytes INTO quota_rows, quota_bytes
      FROM public.memory_candidate_quotas WHERE user_id = NEW.user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Candidate handoff quota is not provisioned' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), COALESCE(sum(envelope_bytes),0) INTO counted_rows, counted_bytes
      FROM public.memory_candidate_handoffs WHERE user_id = NEW.user_id;
    IF quota_rows <> counted_rows OR quota_bytes <> counted_bytes THEN
      RAISE EXCEPTION 'Candidate handoff quota is inconsistent' USING ERRCODE = '23514';
    END IF;
    UPDATE public.memory_candidate_quotas
      SET retained_rows = retained_rows + 1, retained_bytes = retained_bytes + NEW.envelope_bytes
      WHERE user_id = NEW.user_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'published' THEN
      RAISE EXCEPTION 'Unresolved candidate cannot be retired' USING ERRCODE = '23514';
    END IF;
    SELECT retained_rows, retained_bytes INTO quota_rows, quota_bytes
      FROM public.memory_candidate_quotas WHERE user_id = OLD.user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Candidate handoff quota is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT count(*), COALESCE(sum(envelope_bytes),0) INTO counted_rows, counted_bytes
      FROM public.memory_candidate_handoffs WHERE user_id = OLD.user_id;
    IF quota_rows <> counted_rows OR quota_bytes <> counted_bytes THEN
      RAISE EXCEPTION 'Candidate handoff quota is inconsistent' USING ERRCODE = '23514';
    END IF;
    UPDATE public.memory_candidate_quotas
      SET retained_rows = retained_rows - 1, retained_bytes = retained_bytes - OLD.envelope_bytes
      WHERE user_id = OLD.user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Candidate handoff quota is unavailable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR
     NEW.envelope IS DISTINCT FROM OLD.envelope OR NEW.digest IS DISTINCT FROM OLD.digest OR
     NEW.retire_hash IS DISTINCT FROM OLD.retire_hash OR NEW.envelope_bytes IS DISTINCT FROM OLD.envelope_bytes OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Candidate handoff evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'prepared' AND NEW.status = 'refused' AND NEW.committed_token IS NULL THEN
    RETURN NEW;
  ELSIF OLD.status = 'prepared' AND NEW.status = 'committed' AND NEW.committed_token IS NOT NULL THEN
    NEW.envelope_bytes := octet_length(NEW.envelope) + octet_length(NEW.committed_token::text);
    SELECT retained_rows,retained_bytes INTO quota_rows,quota_bytes
      FROM public.memory_candidate_quotas WHERE user_id=NEW.user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Candidate handoff quota is unavailable' USING ERRCODE='23514';
    END IF;
    SELECT count(*),COALESCE(sum(envelope_bytes),0) INTO counted_rows,counted_bytes
      FROM public.memory_candidate_handoffs WHERE user_id=NEW.user_id;
    IF quota_rows <> counted_rows OR quota_bytes <> counted_bytes THEN
      RAISE EXCEPTION 'Candidate handoff quota is inconsistent' USING ERRCODE='23514';
    END IF;
    UPDATE public.memory_candidate_quotas SET retained_bytes=retained_bytes + NEW.envelope_bytes - OLD.envelope_bytes
      WHERE user_id=NEW.user_id;
    RETURN NEW;
  ELSIF OLD.status = 'committed' AND NEW.status = 'published' AND NEW.committed_token = OLD.committed_token THEN
    secret := current_setting('app.memory_handoff_retire', true);
    IF secret IS NOT NULL AND encode(sha256(convert_to(secret,'UTF8')), 'hex') = OLD.retire_hash THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Candidate handoff outcome transition is not authorized' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.memory_candidate_handoff_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER memory_candidate_handoff_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.memory_candidate_handoffs FOR EACH ROW EXECUTE FUNCTION public.memory_candidate_handoff_guard();
