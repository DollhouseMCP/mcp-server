# Onboarding schema readiness probe

`assertOnboardingSchemaReady` is an unregistered, read-only startup helper. A future opt-in bootstrap calls it on the same privileged database used by onboarding, before SMTP verification or route registration. Disabled onboarding must skip this probe.

Its fixed zero-row projection resolves all five invitation tables from migration `0054_invitation_lifecycle.sql`, `users.activation_state`, the owner/session/OAuth-state `auth_kv` table, and `security_audit_events`, including the columns those services consume. PostgreSQL resolves the schema and SELECT privileges without returning credential or audit records. Any error becomes one fixed diagnostic without raw SQL, parameters, exception causes, or database details.

This supplements the existing console database readiness gate. It does not run migrations, verify their provenance, check column types/constraints/indexes or write privileges, or replace disposable PostgreSQL qualification and deployment migration evidence. `database/bootstrap.ts` establishes connections and materializes the current user; migrations are a separate deployment step.
