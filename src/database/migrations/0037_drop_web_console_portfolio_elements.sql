-- Drop the deprecated web-console portfolio mirror.
--
-- The replacement console now reads and writes through the canonical element
-- managers, whose source of truth is elements/raw_content plus element_tags.
-- Backfill/quarantine of any legacy rows must be completed before applying
-- this migration in a selected deployment.

DO $$
BEGIN
  IF to_regclass('public.portfolio_elements') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.portfolio_elements LIMIT 1) THEN
    RAISE EXCEPTION
      'portfolio_elements contains rows; run the selected-deployment backfill/quarantine reconciliation before migration 0037';
  END IF;
END $$;

DROP TABLE IF EXISTS portfolio_elements;
