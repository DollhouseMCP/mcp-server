SELECT (SELECT count(*)=2 FROM pg_roles WHERE
      (rolname='dollhouse_app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole) OR
      (rolname='dollhouse' AND rolcanlogin AND (rolsuper OR rolbypassrls)))
      AND (SELECT count(*)=3 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname IN ('memory_backend_modes','memory_candidate_quotas','memory_candidate_handoffs')
       AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)
      AND has_database_privilege('dollhouse_app','dollhousemcp','CONNECT')
      AND has_schema_privilege('dollhouse_app','public','USAGE')
      AND NOT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND (
       NOT has_table_privilege('dollhouse_app',format('%I.%I',schemaname,tablename),'SELECT') OR
       (tablename='users' AND (has_table_privilege('dollhouse_app','public.users','INSERT') OR has_table_privilege('dollhouse_app','public.users','UPDATE') OR has_table_privilege('dollhouse_app','public.users','DELETE'))) OR
       (tablename<>'users' AND (NOT has_table_privilege('dollhouse_app',format('%I.%I',schemaname,tablename),'INSERT') OR NOT has_table_privilege('dollhouse_app',format('%I.%I',schemaname,tablename),'UPDATE') OR NOT has_table_privilege('dollhouse_app',format('%I.%I',schemaname,tablename),'DELETE')))))
      AND NOT EXISTS(SELECT 1 FROM pg_sequences WHERE schemaname='public' AND (
       NOT has_sequence_privilege('dollhouse_app',format('%I.%I',schemaname,sequencename),'USAGE') OR
       NOT has_sequence_privilege('dollhouse_app',format('%I.%I',schemaname,sequencename),'SELECT')))
      AND has_schema_privilege('dollhouse_app','drizzle','USAGE')
      AND NOT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='drizzle' AND
       NOT has_table_privilege('dollhouse_app',format('%I.%I',schemaname,tablename),'SELECT'))
      AND NOT EXISTS(SELECT 1 FROM public.memory_backend_modes)
      AND NOT EXISTS(SELECT 1 FROM public.memory_candidate_quotas)
      AND NOT EXISTS(SELECT 1 FROM public.memory_candidate_handoffs);