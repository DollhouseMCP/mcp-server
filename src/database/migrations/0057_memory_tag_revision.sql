-- Authoritative memory tags participate in the same monotonic head revision
-- as entries. Invoker privileges preserve FORCE RLS; no tenant bypass.
-- Installing this trigger does not qualify preexisting clean heads. Their
-- bounded invalidation and all-tenant completion proof are an activation gate.
CREATE FUNCTION invalidate_memory_tag_owner(p_element_id UUID, p_user_id UUID, p_deleting BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE parent_type VARCHAR; parent_user UUID;
BEGIN
  SELECT element_type, user_id INTO parent_type, parent_user
    FROM elements WHERE id = p_element_id;
  IF NOT FOUND THEN
    -- Parent/account cascades can already have removed the parent. DELETE
    -- also permits cleanup of legacy tags whose parent is invisible to RLS.
    IF p_deleting THEN RETURN; END IF;
    RAISE EXCEPTION 'Tag owner does not match a visible live head' USING ERRCODE = '23503';
  END IF;
  -- Preserve existing tag behavior for visible non-memory elements.
  IF parent_type <> 'memories' THEN RETURN; END IF;
  IF parent_user IS DISTINCT FROM p_user_id OR
     p_user_id IS DISTINCT FROM current_setting('app.current_user_id', true)::uuid THEN
    -- A visible malformed memory tag can affect public tag projections.
    -- Fail closed even on deletion; audited legacy cleanup is a release gate.
    RAISE EXCEPTION 'Tag owner does not match a live memory head' USING ERRCODE = '23503';
  END IF;
  IF NOT mark_memory_head_out_of_sync(p_element_id, p_user_id) THEN
    IF p_deleting THEN RETURN; END IF;
    RAISE EXCEPTION 'Tag owner does not match a live memory head' USING ERRCODE = '23503';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION bump_memory_tag_head_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM invalidate_memory_tag_owner(OLD.element_id, OLD.user_id, TRUE);
    RETURN OLD;
  END IF;
  IF (OLD.element_id, OLD.user_id) IS DISTINCT FROM (NEW.element_id, NEW.user_id) THEN
    -- Invalidate each distinct owner once, in global order. This does not
    -- eliminate tag-row -> parent versus whole-save parent -> tag deadlocks.
    IF (OLD.element_id, OLD.user_id) < (NEW.element_id, NEW.user_id) THEN
      PERFORM invalidate_memory_tag_owner(OLD.element_id, OLD.user_id, FALSE);
      PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
    ELSE
      PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
      PERFORM invalidate_memory_tag_owner(OLD.element_id, OLD.user_id, FALSE);
    END IF;
  ELSE
    PERFORM invalidate_memory_tag_owner(NEW.element_id, NEW.user_id, FALSE);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER element_tags_memory_head_revision_change
  BEFORE INSERT OR UPDATE OR DELETE ON element_tags
  FOR EACH ROW EXECUTE FUNCTION bump_memory_tag_head_revision();
