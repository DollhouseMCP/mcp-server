#!/usr/bin/env bash
# Native CI only: compare the slim image against Drizzle Kit on an owned database.
set -euo pipefail
builder_image="${1:?builder image ID required}"
migration_image="${2:?migration image ID required}"
source_sha="${3:?source SHA required}"
proof_file="${4:?owned proof path required}"
[[ "$proof_file" == "${RUNNER_TEMP:?}/"* ]]
[[ "$builder_image" =~ ^sha256:[a-f0-9]{64}$ && "$migration_image" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]]
work="$(mktemp -d "${RUNNER_TEMP:?}/slim-migration-fixture.XXXXXXXX")"
chmod 0755 "$work"
network_id='' postgres_id='' child_id=''
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$child_id" ]]; then timeout 15s docker rm -f --volumes "$child_id" >/dev/null || result=1; fi
  if [[ -n "$postgres_id" ]]; then timeout 15s docker rm -f --volumes "$postgres_id" >/dev/null || result=1; fi
  if [[ -n "$network_id" ]]; then timeout 15s docker network rm "$network_id" >/dev/null || result=1; fi
  if [[ "$work" == "${RUNNER_TEMP}/slim-migration-fixture."* ]]; then rm -rf -- "$work"; else result=1; fi
  exit "$result"
}
trap cleanup EXIT
POST_MIGRATION_GRANTS_FILE="$work/grants.sql"
POST_MIGRATION_GRANTS_SCRIPT_FILE="$work/grants.sh"
source scripts/hosted-deploy/render.sh
write_post_migration_grants
write_post_migration_grants_script
network_id=$(docker network create --internal "slim-migration-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${RUNNER_ARCH}")
[[ "$network_id" =~ ^[a-f0-9]{64}$ ]]
postgres_id=$(docker create --network "$network_id" --network-alias fixture-db \
  --mount "type=bind,src=${POST_MIGRATION_GRANTS_SCRIPT_FILE},dst=/usr/local/bin/apply-post-migration-grants,readonly" \
  -e POSTGRES_USER=dollhouse -e POSTGRES_PASSWORD=fixture-only-password -e POSTGRES_DB=dollhousemcp \
  'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73')
[[ "$postgres_id" =~ ^[a-f0-9]{64}$ ]]
docker start "$postgres_id" >/dev/null
ready=false
for _ in {1..60}; do
  if timeout 5s docker exec "$postgres_id" pg_isready -U dollhouse -d dollhousemcp >/dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
for db in kit_fixture partial_fixture failed_fixture; do
  timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d postgres -c "CREATE DATABASE ${db}"
done
run_image() {
  local image="$1" db="$2" admin="$3" app="$4" mount="$5"
  shift 5
  local args=(--network "$network_id" --read-only --tmpfs '/tmp:noexec,nosuid,mode=1777'
    --tmpfs '/app/tmp:noexec,nosuid,mode=1777' --cap-drop ALL --security-opt no-new-privileges
    -e NODE_ENV=production -e DOLLHOUSE_DATABASE_SSL=disable -e DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres
    -e "DOLLHOUSE_DATABASE_ADMIN_URL=${admin}" -e "DOLLHOUSE_DATABASE_URL=${app}")
  if [[ -n "$mount" ]]; then args+=(--mount "type=bind,src=${mount},dst=/app/src/database/migrations,readonly"); fi
  child_id=$(docker create "${args[@]}" "$image" "$@") || return 2
  [[ "$child_id" =~ ^[a-f0-9]{64}$ ]] || return 2
  local status=0 exit_code
  timeout 120s docker start --attach "$child_id" >"$work/${db}.out" 2>&1 || status=$?
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$child_id") || return 2
  timeout 15s docker rm --force --volumes "$child_id" >/dev/null || return 2
  child_id=''
  if [[ "$status" == 124 || "$status" == 125 || "$status" == 126 || "$status" == 127 ]]; then return 2; fi
  if [[ "$status" == 0 && "$exit_code" == 0 ]]; then return 0; fi
  [[ "$exit_code" != 0 ]] || return 2
  return 1
}
admin_url() { printf 'postgres://dollhouse:fixture-only-password@fixture-db:5432/%s' "$1"; }
wrong_app='postgres://wrong:fixture-only-secret@fixture-db:5432/dollhousemcp'
fresh_admin="$(admin_url dollhousemcp)"
kit_admin="$(admin_url kit_fixture)"
run_image "$migration_image" fresh "$fresh_admin" "$wrong_app" ''
run_image "$builder_image" kit "$kit_admin" "$kit_admin" '' npm run db:migrate
history() {
  timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d "$1" -Atc \
    'SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id'
}
history dollhousemcp > "$work/fresh.history"
history kit_fixture > "$work/kit.history"
[[ -s "$work/fresh.history" ]]
cmp "$work/fresh.history" "$work/kit.history"
# Build a prefix journal while preserving the selected canonical SQL bytes.
mkdir -p "$work/partial/meta"
node - "$work/partial" <<'NODE_PREFIX'
const fs = require('node:fs');
const path = require('node:path');
const root = 'src/database/migrations';
const output = process.argv[2];
const journal = JSON.parse(fs.readFileSync(path.join(root, 'meta/_journal.json'), 'utf8'));
if (!Array.isArray(journal.entries) || journal.entries.length <= 3) throw new Error('Missing pending migrations');
const entries = journal.entries.slice(0, 3);
for (const entry of entries) {
  if (typeof entry.tag !== 'string' || !/^[a-z0-9_]+$/.test(entry.tag)) throw new Error('Invalid migration tag');
  fs.copyFileSync(path.join(root, entry.tag + '.sql'), path.join(output, entry.tag + '.sql'));
}
fs.writeFileSync(path.join(output, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }) + '\n');
NODE_PREFIX
partial_admin="$(admin_url partial_fixture)"
run_image "$builder_image" partial-kit "$partial_admin" "$partial_admin" "$work/partial" npm run db:migrate
history partial_fixture > "$work/partial-before.history"
[[ "$(wc -l < "$work/partial-before.history")" -eq 3 ]]
timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d partial_fixture -c \
  'CREATE TABLE public.slim_existing_sentinel (value integer NOT NULL); INSERT INTO public.slim_existing_sentinel VALUES (42)'
run_image "$migration_image" partial-upgrade "$partial_admin" "$wrong_app" ''
history partial_fixture > "$work/partial-after.history"
head -n 3 "$work/partial-after.history" > "$work/partial-after-prefix.history"
cmp "$work/partial-before.history" "$work/partial-after-prefix.history"
cmp "$work/fresh.history" "$work/partial-after.history"
sentinel=$(timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d partial_fixture -Atc 'SELECT value FROM public.slim_existing_sentinel')
[[ "$sentinel" == 42 ]]
timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d partial_fixture -c 'DROP TABLE public.slim_existing_sentinel'
# pg_dump's per-invocation random restrict token is not schema state.
for db in dollhousemcp kit_fixture partial_fixture; do
  timeout 30s docker exec "$postgres_id" pg_dump -U dollhouse --schema-only --no-owner --no-privileges "$db" > "$work/${db}.schema.raw"
  sed '/^\\restrict /d; /^\\unrestrict /d' "$work/${db}.schema.raw" > "$work/${db}.schema"
done
cmp "$work/dollhousemcp.schema" "$work/kit_fixture.schema"
cmp "$work/dollhousemcp.schema" "$work/partial_fixture.schema"
run_image "$migration_image" fresh-noop "$fresh_admin" "$wrong_app" ''
run_image "$migration_image" existing-noop "$kit_admin" "$wrong_app" ''
history dollhousemcp > "$work/fresh-after.history"
history kit_fixture > "$work/kit-after.history"
cmp "$work/fresh.history" "$work/fresh-after.history"
cmp "$work/kit.history" "$work/kit-after.history"
status=0
run_image "$migration_image" missing-admin '' "$fresh_admin" '' || status=$?
[[ "$status" == 1 ]] || { echo 'missing admin did not produce the expected CLI refusal' >&2; exit 1; }
grep -Fq 'Database migration failed.' "$work/missing-admin.out"
status=0
run_image "$migration_image" missing-bootstrap '' "$fresh_admin" '' node dist/cli/admin-bootstrap.js --require-admin-url --method github --github-id 123456789 || status=$?
[[ "$status" == 1 ]] || { echo 'missing bootstrap admin did not refuse' >&2; exit 1; }
grep -Fq 'DOLLHOUSE_DATABASE_ADMIN_URL is required' "$work/missing-bootstrap.out"
status=0
run_image "$migration_image" blank-bootstrap '   ' "$fresh_admin" '' node dist/cli/admin-bootstrap.js --require-admin-url --method github --github-id 123456789 || status=$?
[[ "$status" == 1 ]] || { echo 'blank bootstrap admin did not refuse' >&2; exit 1; }
bootstrap_rows=$(timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d dollhousemcp -Atc \
  "SELECT count(*) FROM auth_kv WHERE model='AuthBootstrap' AND id='state'")
[[ "$bootstrap_rows" == 0 ]]
if grep -Fq 'fixture-only-password' "$work/missing-admin.out"; then echo 'admin failure exposed URL' >&2; exit 1; fi
run_image "$migration_image" bootstrap "$fresh_admin" "$wrong_app" '' node dist/cli/admin-bootstrap.js --require-admin-url --method github --github-id 123456789
admin_sub=$(timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d dollhousemcp -Atc \
  "SELECT payload->>'adminSub' FROM auth_kv WHERE model='AuthBootstrap' AND id='state' AND payload->>'completed'='true'")
[[ "$admin_sub" == github_123456789 ]]
# Exercise the actual generated post-migration grants against the disposable database.
timeout 20s docker exec -i -e DOLLHOUSE_APP_DB_PASSWORD=fixture-app-only "$postgres_id" \
  /usr/local/bin/apply-post-migration-grants < "$POST_MIGRATION_GRANTS_FILE"
grants=$(timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d dollhousemcp -Atc \
  "SELECT has_table_privilege('dollhouse_app','public.auth_kv','SELECT')")
[[ "$grants" == t ]]
mkdir -p "$work/failure/meta"
chmod 0755 "$work" "$work/failure" "$work/failure/meta"
printf '%s\n' '{"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1,"tag":"0000_failure","breakpoints":true}]}' > "$work/failure/meta/_journal.json"
printf '%s\n' 'CREATE TABLE slim_migration_rollback_probe (id integer);' '--> statement-breakpoint' 'SELECT deliberately_missing_function();' > "$work/failure/0000_failure.sql"
chmod 0644 "$work/failure/meta/_journal.json" "$work/failure/0000_failure.sql"
failed_admin="$(admin_url failed_fixture)"
status=0
run_image "$migration_image" failure "$failed_admin" "$wrong_app" "$work/failure" || status=$?
[[ "$status" == 1 ]] || { echo 'invalid migration did not produce the expected CLI refusal' >&2; exit 1; }
grep -Fq 'Database migration failed.' "$work/failure.out"
if grep -Fq 'fixture-only-password' "$work/failure.out"; then echo 'migration failure exposed URL' >&2; exit 1; fi
probe=$(timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d failed_fixture -Atc "SELECT to_regclass('public.slim_migration_rollback_probe') IS NULL")
[[ "$probe" == t ]]
failed_history=$(timeout 10s docker exec "$postgres_id" psql -v ON_ERROR_STOP=1 -U dollhouse -d failed_fixture -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')
[[ "$failed_history" == 0 ]]
printf '{"source":"%s","builder":"%s","migration":"%s","fresh":true,"kitHistoryEqual":true,"schemaEqual":true,"existingHistory":true,"adminGuard":true,"noOp":true,"failureRollback":true,"bootstrap":true,"grants":true}\n' \
  "$source_sha" "$builder_image" "$migration_image" > "$proof_file"
