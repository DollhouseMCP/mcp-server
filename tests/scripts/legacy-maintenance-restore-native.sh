#!/usr/bin/env bash
# Disposable native CI rehearsal: synthetic persisted data only, never a legacy handoff.
set -euo pipefail
builder="${1:?bound builder image ID required}"
source_sha="${2:?tested checkout required}"
proof="${3:?owned proof path required}"
arch="${4:?architecture required}"
[[ "$proof" == "${RUNNER_TEMP:?}/"* ]]
started=$SECONDS
source_tree='' work='' owner='' work_identity=''
operation_end=$((started + 190))
cleanup_end=$((started + 295))
label='org.dollhousemcp.legacy-rehearsal-owner'
pg_image='postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'
source_volume='' destination_volume='' network='' source_pg='' destination_pg='' helper=''
phase='setup' backup_sha='' roles_sha='' database_sha='' manifest_sha='' source_meta_sha='' destination_meta_sha='' db_state_sha='' tool_tar='' tool_pg='' pg_source_image='' pg_destination_image=''
ownership_unknown=false
cleanup_ok=true
corrupt_refused=false incomplete_refused=false restored=false source_logical_unchanged=false
cleanup_run() {
  local remaining=$((cleanup_end - SECONDS))
  (( remaining > 1 )) || return 1
  if (( remaining > 5 )); then remaining=5; fi
  timeout --kill-after=1s "$((remaining - 1))s" "$@"
}
run() {
  local remaining=$((operation_end - SECONDS))
  (( remaining > 1 )) || { echo 'rehearsal operation deadline reached' >&2; return 1; }
  if (( remaining > 30 )); then remaining=30; fi
  timeout --kill-after=1s "$((remaining - 1))s" "$@"
}
remove_container() {
  local id="$1" observed
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
  observed=$(cleanup_run docker inspect --format "{{index .Config.Labels \"${label}\"}}" "$id") || return 1
  [[ "$observed" == "$owner" ]] || return 1
  cleanup_run docker rm --force --volumes "$id" >/dev/null || return 1
  local status=0
  cleanup_run docker inspect "$id" >/dev/null 2>&1 || status=$?
  [[ "$status" == 1 ]]
}
remove_volume() {
  local name="$1" observed
  [[ "$name" == "${owner}-"* ]] || return 1
  observed=$(cleanup_run docker volume inspect --format "{{index .Labels \"${label}\"}}" "$name") || return 1
  [[ "$observed" == "$owner" ]] || return 1
  cleanup_run docker volume rm "$name" >/dev/null || return 1
  local status=0
  cleanup_run docker volume inspect "$name" >/dev/null 2>&1 || status=$?
  [[ "$status" == 1 ]]
}
cleanup() {
  local result=$? item observed
  trap - EXIT
  [[ "$ownership_unknown" == false ]] || cleanup_ok=false
  cleanup_run docker info >/dev/null 2>&1 || cleanup_ok=false
  for item in "$helper" "$destination_pg" "$source_pg"; do
    if [[ -n "$item" ]]; then remove_container "$item" || cleanup_ok=false; fi
  done
  for item in "$destination_volume" "$source_volume"; do
    if [[ -n "$item" ]]; then remove_volume "$item" || cleanup_ok=false; fi
  done
  if [[ -n "$network" ]]; then
    observed=$(cleanup_run docker network inspect --format "{{index .Labels \"${label}\"}}" "$network") || observed=''
    if [[ "$network" =~ ^[a-f0-9]{64}$ && "$observed" == "$owner" ]]; then
      cleanup_run docker network rm "$network" >/dev/null || cleanup_ok=false
      local status=0
      cleanup_run docker network inspect "$network" >/dev/null 2>&1 || status=$?
      [[ "$status" == 1 ]] || cleanup_ok=false
    else cleanup_ok=false; fi
  fi
  cleanup_run docker info >/dev/null 2>&1 || cleanup_ok=false
  if [[ -n "$work" ]]; then
    if [[ -n "$work_identity" ]]; then
      cleanup_run python3 - "$work" "$RUNNER_TEMP" "$work_identity" <<'PYWORK' || cleanup_ok=false
import os, pathlib, shutil, stat, sys
path, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
info = path.lstat()
if (path.parent != root or not path.name.startswith('legacy-checkpoint.') or
    not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or
    f'{info.st_dev}:{info.st_ino}' != sys.argv[3]):
    raise SystemExit('owned scratch identity changed')
shutil.rmtree(path)
if path.exists() or path.is_symlink():
    raise SystemExit('owned scratch removal failed')
PYWORK
    else cleanup_ok=false; fi
  fi
  [[ "$cleanup_ok" == true && "$phase" == verified ]] || result=1
  export REHEARSAL_RESULT="$result" REHEARSAL_CLEANUP="$cleanup_ok" REHEARSAL_ELAPSED="$((SECONDS-started))"
  export REHEARSAL_PHASE="$phase" REHEARSAL_BUILDER="$builder" REHEARSAL_SOURCE="$source_sha" REHEARSAL_ARCH="$arch"
  export REHEARSAL_TAR_VERSION="$tool_tar" REHEARSAL_PG_VERSION="$tool_pg" REHEARSAL_VOLUME_SHA="$backup_sha"
  export REHEARSAL_DB_STATE_SHA="$db_state_sha"
  export REHEARSAL_SOURCE_META_SHA="$source_meta_sha" REHEARSAL_DESTINATION_META_SHA="$destination_meta_sha"
  export REHEARSAL_ROLES_SHA="$roles_sha" REHEARSAL_DATABASE_SHA="$database_sha" REHEARSAL_MANIFEST_SHA="$manifest_sha"
  export REHEARSAL_TREE="$source_tree" REHEARSAL_PROOF="$proof"
  export REHEARSAL_CORRUPT="$corrupt_refused" REHEARSAL_INCOMPLETE="$incomplete_refused"
  export REHEARSAL_RESTORED="$restored" REHEARSAL_SOURCE_UNCHANGED="$source_logical_unchanged"
  export REHEARSAL_PG_SOURCE_IMAGE="$pg_source_image" REHEARSAL_PG_DESTINATION_IMAGE="$pg_destination_image"
  timeout --kill-after=1s 4s python3 - <<'PY' || result=1
import json, os, pathlib
keys = {'source':'REHEARSAL_SOURCE', 'tree':'REHEARSAL_TREE', 'architecture':'REHEARSAL_ARCH',
        'builderImageId':'REHEARSAL_BUILDER', 'postgresSourceImageId':'REHEARSAL_PG_SOURCE_IMAGE',
        'postgresDestinationImageId':'REHEARSAL_PG_DESTINATION_IMAGE', 'tarVersion':'REHEARSAL_TAR_VERSION', 'pgDumpVersion':'REHEARSAL_PG_VERSION',
        'volumeArchiveSha256':'REHEARSAL_VOLUME_SHA', 'sourceMetadataSha256':'REHEARSAL_SOURCE_META_SHA',
        'destinationMetadataSha256':'REHEARSAL_DESTINATION_META_SHA', 'databaseStateSha256':'REHEARSAL_DB_STATE_SHA', 'rolesSha256':'REHEARSAL_ROLES_SHA',
        'databaseSha256':'REHEARSAL_DATABASE_SHA', 'manifestSha256':'REHEARSAL_MANIFEST_SHA', 'phase':'REHEARSAL_PHASE'}
proof = {key: os.environ[value] for key, value in keys.items()}
proof.update(result='passed' if os.environ['REHEARSAL_RESULT']=='0' else 'failed',
             cleanupVerified=os.environ['REHEARSAL_CLEANUP']=='true', elapsedSeconds=int(os.environ['REHEARSAL_ELAPSED']),
             corruptRefused=os.environ['REHEARSAL_CORRUPT']=='true', incompleteRefused=os.environ['REHEARSAL_INCOMPLETE']=='true',
             restored=os.environ['REHEARSAL_RESTORED']=='true', sourceLogicalContentUnchanged=os.environ['REHEARSAL_SOURCE_UNCHANGED']=='true',
             postgresImageReference='postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
             scope='synthetic only; hash-checked backup is not immutable storage; no legacy image, live host or acknowledged-work settlement')
path = pathlib.Path(os.environ['REHEARSAL_PROOF'])
with path.open('x') as output:
    json.dump(proof, output, indent=2)
    output.write('\n')
PY
  exit "$result"
}
trap cleanup EXIT
[[ "$builder" =~ ^sha256:[a-f0-9]{64}$ && "$source_sha" =~ ^[a-f0-9]{40}$ ]]
[[ "$(git rev-parse HEAD)" == "$source_sha" && "$source_sha" == "${GITHUB_SHA:?}" ]]
source_tree=$(git rev-parse 'HEAD^{tree}')
case "$arch:$(uname -m)" in amd64:x86_64|arm64:aarch64) ;; *) exit 1 ;; esac
[[ "$(run docker image inspect --format '{{.Id}}' "$builder")" == "$builder" ]]
[[ "$(run docker image inspect --format '{{.Os}}/{{.Architecture}}' "$builder")" == "linux/$arch" ]]
[[ "$(run docker image inspect --format '{{index .Config.Labels "org.dollhousemcp.engine-proof-source"}}' "$builder")" == "$source_sha" ]]
run docker image inspect "$pg_image" >/dev/null
work="$(mktemp -d "${RUNNER_TEMP}/legacy-checkpoint.XXXXXXXX")"
work_identity=$(stat -c '%d:%i' "$work")
chmod 0700 "$work"
owner="legacy-rehearsal-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${arch}-$(tr -d '-' < /proc/sys/kernel/random/uuid)"
run_helper() {
  local volume="$1" mode="$2" command="$3"
  ownership_unknown=true
  helper=$(run docker create --label "${label}=${owner}" --network none --read-only --user 0:0 \
    --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    --mount "type=volume,src=${volume},dst=/data,${mode}" \
    --mount "type=bind,src=${work},dst=/backup" "$builder" sh -ec "$command")
  [[ "$helper" =~ ^[a-f0-9]{64}$ ]]
  ownership_unknown=false
  [[ "$(run docker inspect --format "{{index .Config.Labels \"${label}\"}}" "$helper")" == "$owner" ]]
  run docker start --attach "$helper"
  remove_container "$helper"
  helper=''
}
if run docker network inspect "${owner}-net" >/dev/null 2>&1; then echo 'network namespace collision' >&2; exit 1; fi
ownership_unknown=true
network=$(run docker network create --internal --label "${label}=${owner}" "${owner}-net")
[[ "$network" =~ ^[a-f0-9]{64}$ ]]
ownership_unknown=false
[[ "$(run docker network inspect --format "{{index .Labels \"${label}\"}}" "$network")" == "$owner" ]]
if run docker volume inspect "${owner}-source" >/dev/null 2>&1; then echo 'source volume collision' >&2; exit 1; fi
ownership_unknown=true
source_volume=$(run docker volume create --label "${label}=${owner}" "${owner}-source")
[[ "$source_volume" == "${owner}-source" ]]
ownership_unknown=false
[[ "$(run docker volume inspect --format "{{index .Labels \"${label}\"}}" "$source_volume")" == "$owner" ]]
ownership_unknown=true
source_pg=$(run docker create --label "${label}=${owner}" --network "$network" \
  -e POSTGRES_USER=fixture_admin -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=fixture_db "$pg_image")
[[ "$source_pg" =~ ^[a-f0-9]{64}$ ]]
ownership_unknown=false
[[ "$(run docker inspect --format "{{index .Config.Labels \"${label}\"}}" "$source_pg")" == "$owner" ]]
pg_source_image=$(run docker inspect --format '{{.Image}}' "$source_pg")
[[ "$pg_source_image" =~ ^sha256:[a-f0-9]{64}$ ]]
run docker start "$source_pg" >/dev/null
ready=false
for _ in {1..60}; do
  if run docker exec "$source_pg" pg_isready -h 127.0.0.1 -U fixture_admin -d fixture_db >/dev/null 2>&1; then ready=true; break; fi
  run sleep 1
done
[[ "$ready" == true ]]
tool_pg=$(run docker exec "$source_pg" pg_dump --version)
run docker exec -i "$source_pg" psql -v ON_ERROR_STOP=1 -U fixture_admin -d fixture_db <<'SQL'
CREATE ROLE fixture_owner NOLOGIN;
CREATE ROLE fixture_reader NOLOGIN;
CREATE SCHEMA fixture AUTHORIZATION fixture_owner;
CREATE TABLE fixture.items (id integer PRIMARY KEY, value text NOT NULL);
ALTER TABLE fixture.items OWNER TO fixture_owner;
INSERT INTO fixture.items VALUES (1, 'checkpoint-value');
GRANT USAGE ON SCHEMA fixture TO fixture_reader;
GRANT SELECT ON fixture.items TO fixture_reader;
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (id integer PRIMARY KEY, hash text, created_at bigint);
INSERT INTO drizzle.__drizzle_migrations VALUES (1, 'synthetic-journal-hash', 42);
SQL
fixture_query="SELECT value || ':' || (SELECT count(*) FROM fixture.items) || ':' || (SELECT count(*) FROM drizzle.__drizzle_migrations) || ':' || pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database())) || ':' || (SELECT hash || ':' || created_at FROM drizzle.__drizzle_migrations WHERE id=1) || ':' || pg_get_userbyid(c.relowner) || ':' || pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname='fixture')) || ':' || (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='fixture_owner') || ':' || (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='fixture_reader') || ':' || has_table_privilege('fixture_reader','fixture.items','SELECT') || ':' || has_table_privilege('fixture_reader','fixture.items','INSERT') FROM fixture.items, pg_class c WHERE c.oid='fixture.items'::regclass AND id=1"
source_database_before=$(run docker exec "$source_pg" psql -v ON_ERROR_STOP=1 -U fixture_admin -d fixture_db -Atc "$fixture_query")
[[ "$source_database_before" == 'checkpoint-value:1:1:fixture_admin:synthetic-journal-hash:42:fixture_owner:fixture_owner:true:true:true:false' ]]
db_state_sha=$(printf '%s\n' "$source_database_before" | sha256sum | cut -d' ' -f1)
run_helper "$source_volume" volume-nocopy 'mkdir -p /data/private; printf "synthetic-volume-data\n" > /data/private/payload; printf "synthetic-hidden\n" > /data/.hidden; chown 1001:1001 /data/private /data/private/payload /data/.hidden; chmod 0700 /data/private; chmod 0640 /data/private/payload; chmod 0600 /data/.hidden; ln -s private/payload /data/link; chown 1001:1001 /data; chmod 0750 /data; tar --version | head -1 > /backup/tar-version'
tool_tar=$(cat "$work/tar-version")
run_helper "$source_volume" readonly 'stat -c "%n|%u|%g|%a|%F" /data /data/private /data/private/payload /data/.hidden /data/link > /backup/source-before; readlink /data/link >> /backup/source-before; sha256sum /data/private/payload /data/.hidden >> /backup/source-before; find /data -mindepth 1 -printf "%P\n" | LC_ALL=C sort > /backup/source-paths'
printf '%s\n' '/data|1001|1001|750|directory' '/data/private|1001|1001|700|directory' '/data/private/payload|1001|1001|640|regular file' '/data/.hidden|1001|1001|600|regular file' '/data/link|0|0|777|symbolic link' 'private/payload' > "$work/expected-metadata"
head -6 "$work/source-before" > "$work/source-metadata"
cmp "$work/expected-metadata" "$work/source-metadata"
printf '%s\n' '.hidden' 'link' 'private' 'private/payload' > "$work/expected-paths"
cmp "$work/expected-paths" "$work/source-paths"
phase='backup'
# Capture actual synthetic cluster roles and database ACLs; destination bootstrap name is distinct.
run docker exec "$source_pg" pg_dumpall -U fixture_admin --globals-only > "$work/roles.sql"
run docker exec "$source_pg" pg_dump -U fixture_admin --create -d fixture_db > "$work/database.sql"
run docker stop --time -1 "$source_pg" >/dev/null
[[ "$(run docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$source_pg")" == 'false false 0 false' ]]
run_helper "$source_volume" readonly 'tar --numeric-owner -cpf /backup/volume.tar -C /data .'
(cd "$work" && sha256sum roles.sql database.sql volume.tar source-before source-paths > SHA256SUMS)
roles_sha=$(sha256sum "$work/roles.sql" | cut -d' ' -f1)
database_sha=$(sha256sum "$work/database.sql" | cut -d' ' -f1)
backup_sha=$(sha256sum "$work/volume.tar" | cut -d' ' -f1)
manifest_sha=$(sha256sum "$work/SHA256SUMS" | cut -d' ' -f1)
source_meta_sha=$(sha256sum "$work/source-before" | cut -d' ' -f1)
validate_backup() {
  local directory="$1"
  [[ -f "$directory/SHA256SUMS" ]] || return 1
  [[ $(wc -l < "$directory/SHA256SUMS") -eq 5 ]] || return 1
  for item in roles.sql database.sql volume.tar source-before source-paths; do
    [[ -f "$directory/$item" ]] && grep -Eq "^[a-f0-9]{64}  ${item//./\\.}$" "$directory/SHA256SUMS" || return 1
  done
  (cd "$directory" && sha256sum --check --status SHA256SUMS)
}
mkdir -m 700 "$work/corrupt" "$work/incomplete"
cp "$work/"{roles.sql,database.sql,volume.tar,source-before,source-paths,SHA256SUMS} "$work/corrupt/"
cp "$work/"{roles.sql,database.sql,source-before,source-paths,SHA256SUMS} "$work/incomplete/"
printf 'corrupt\n' >> "$work/corrupt/volume.tar"
if validate_backup "$work/corrupt"; then echo 'corrupt backup accepted' >&2; exit 1; else corrupt_refused=true; fi
if validate_backup "$work/incomplete"; then echo 'incomplete backup accepted' >&2; exit 1; else incomplete_refused=true; fi
validate_backup "$work"
phase='restore'
if run docker volume inspect "${owner}-destination" >/dev/null 2>&1; then echo 'destination volume collision' >&2; exit 1; fi
ownership_unknown=true
destination_volume=$(run docker volume create --label "${label}=${owner}" "${owner}-destination")
[[ "$destination_volume" == "${owner}-destination" && "$destination_volume" != "$source_volume" ]]
ownership_unknown=false
[[ "$(run docker volume inspect --format "{{index .Labels \"${label}\"}}" "$destination_volume")" == "$owner" ]]
ownership_unknown=true
destination_pg=$(run docker create --label "${label}=${owner}" --network "$network" \
  -e POSTGRES_USER=fixture_restore_admin -e POSTGRES_PASSWORD=synthetic-only -e POSTGRES_DB=fixture_db "$pg_image")
[[ "$destination_pg" =~ ^[a-f0-9]{64}$ && "$destination_pg" != "$source_pg" ]]
ownership_unknown=false
[[ "$(run docker inspect --format "{{index .Config.Labels \"${label}\"}}" "$destination_pg")" == "$owner" ]]
pg_destination_image=$(run docker inspect --format '{{.Image}}' "$destination_pg")
[[ "$pg_destination_image" == "$pg_source_image" ]]
run docker start "$destination_pg" >/dev/null
ready=false
for _ in {1..60}; do
  if run docker exec "$destination_pg" pg_isready -h 127.0.0.1 -U fixture_restore_admin -d fixture_db >/dev/null 2>&1; then ready=true; break; fi
  run sleep 1
done
[[ "$ready" == true ]]
run docker exec "$destination_pg" psql -v ON_ERROR_STOP=1 -U fixture_restore_admin -d postgres -c 'DROP DATABASE fixture_db' >/dev/null
for item in roles.sql database.sql; do
  run docker exec -i "$destination_pg" psql -v ON_ERROR_STOP=1 -U fixture_restore_admin -d postgres < "$work/$item" >/dev/null
done
run_helper "$destination_volume" volume-nocopy 'tar --numeric-owner -xpf /backup/volume.tar -C /data; stat -c "%n|%u|%g|%a|%F" /data /data/private /data/private/payload /data/.hidden /data/link > /backup/destination; readlink /data/link >> /backup/destination; sha256sum /data/private/payload /data/.hidden >> /backup/destination; find /data -mindepth 1 -printf "%P\n" | LC_ALL=C sort > /backup/destination-paths'
destination_meta_sha=$(sha256sum "$work/destination" | cut -d' ' -f1)
cmp "$work/source-before" "$work/destination"
cmp "$work/expected-paths" "$work/destination-paths"
run_helper "$source_volume" readonly 'stat -c "%n|%u|%g|%a|%F" /data /data/private /data/private/payload /data/.hidden /data/link > /backup/source-after; readlink /data/link >> /backup/source-after; sha256sum /data/private/payload /data/.hidden >> /backup/source-after; find /data -mindepth 1 -printf "%P\n" | LC_ALL=C sort > /backup/source-after-paths'
cmp "$work/source-before" "$work/source-after"
cmp "$work/source-paths" "$work/source-after-paths"
result=$(run docker exec "$destination_pg" psql -v ON_ERROR_STOP=1 -U fixture_restore_admin -d fixture_db -Atc "$fixture_query")
[[ "$result" == "$source_database_before" ]]
allowed=$(run docker exec "$destination_pg" psql -v ON_ERROR_STOP=1 -U fixture_restore_admin -d fixture_db -Atc 'SET ROLE fixture_reader; SELECT value FROM fixture.items WHERE id=1')
[[ "$allowed" == *'checkpoint-value' ]]
if run docker exec "$destination_pg" psql -v ON_ERROR_STOP=1 -U fixture_restore_admin -d fixture_db -c "SET ROLE fixture_reader; INSERT INTO fixture.items VALUES (2, 'forbidden')" > "$work/denied.log" 2>&1; then
  echo 'fixture reader unexpectedly wrote restored data' >&2
  exit 1
fi
grep -Fq 'permission denied for table items' "$work/denied.log"
restored=true
run docker start "$source_pg" >/dev/null
ready=false
for _ in {1..60}; do
  if run docker exec "$source_pg" pg_isready -h 127.0.0.1 -U fixture_admin -d fixture_db >/dev/null 2>&1; then ready=true; break; fi
  run sleep 1
done
[[ "$ready" == true ]]
source_database_after=$(run docker exec "$source_pg" psql -v ON_ERROR_STOP=1 -U fixture_admin -d fixture_db -Atc "$fixture_query")
[[ "$source_database_after" == "$source_database_before" ]]
run docker stop --time -1 "$source_pg" >/dev/null
[[ "$(run docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$source_pg")" == 'false false 0 false' ]]
validate_backup "$work"
source_logical_unchanged=true
phase='verified'
