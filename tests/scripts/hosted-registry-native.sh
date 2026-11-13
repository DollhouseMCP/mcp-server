#!/usr/bin/env bash
# Native CI only. Registry transfers are confined to this owned loopback fixture.
set -euo pipefail
runtime_id="$(cat "${RUNNER_TEMP:?}/beta3-tested-production.id")"
migration_id="$(cat "${RUNNER_TEMP}/beta3-tested-migration.id")"
[[ "$runtime_id" =~ ^sha256:[a-f0-9]{64}$ && "$migration_id" =~ ^sha256:[a-f0-9]{64}$ ]]
work="$(mktemp -d "${RUNNER_TEMP}/registry-fixture.XXXXXXXX")"
project="registryfixture${GITHUB_RUN_ID}${GITHUB_RUN_ATTEMPT}$(printf '%s' "$RUNNER_ARCH" | tr '[:upper:]' '[:lower:]')"
registry_id='' tag_runtime='' tag_migration='' runtime_ref='' migration_ref='' pulled_runtime_id='' pulled_migration_id='' old_id='' new_id='' dependency_id=''
runtime_tagged=false migration_tagged=false app_possible=false sentinel_possible=false registry_possible=false maintenance_possible=false
completed=false
operation_end=$((SECONDS + 420))
run() {
  local cap="$1" remaining=$((operation_end - SECONDS))
  shift
  (( remaining > 2 )) || return 124
  if (( cap > remaining - 2 )); then cap=$((remaining - 2)); fi
  timeout --kill-after=2s "${cap}s" "$@"
}
cleanup() {
  local result=$? owner owned_id identity tag expected tagged remaining cleanup_ok=true
  local cleanup_end=$((SECONDS + 100))
  trap - EXIT
  cleanup_run() {
    local cap="$1" remaining=$((cleanup_end - SECONDS))
    shift
    (( remaining > 2 )) || return 124
    if (( cap > remaining - 2 )); then cap=$((remaining - 2)); fi
    timeout --kill-after=2s "${cap}s" "$@"
  }
  # Only two exact, prechecked fixture names may be resolved; verify ownership
  # before removing each immutable ID, including a partially-created replacement.
  for pair in "${project}-app $app_possible" "${project}-sentinel $sentinel_possible"; do
    read -r name possible <<< "$pair"
    [[ "$possible" == true ]] || continue
    if identity=$(cleanup_run 10 docker inspect --format '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null); then
      owned_id="${identity%%|*}"; owner="${identity#*|}"
      if [[ "$owned_id" =~ ^[a-f0-9]{64}$ && "$owner" == "$project" ]]; then
        cleanup_run 10 docker rm -f --volumes "$owned_id" >/dev/null || cleanup_ok=false
      else cleanup_ok=false; fi
    else cleanup_ok=false; fi
  done
  if [[ "$maintenance_possible" == true ]]; then
    if identity=$(cleanup_run 10 docker inspect --format '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}' "${project}-maintenance" 2>/dev/null); then
      owned_id="${identity%%|*}"; owner="${identity#*|}"
      if [[ "$owned_id" =~ ^[a-f0-9]{64}$ && "$owner" == "$project" ]]; then
        cleanup_run 10 docker rm -f --volumes "$owned_id" >/dev/null || cleanup_ok=false
      else cleanup_ok=false; fi
    else
      remaining=$(cleanup_run 10 docker ps -aq --no-trunc --filter "name=^/${project}-maintenance$") || cleanup_ok=false
      [[ -z "$remaining" ]] || cleanup_ok=false
    fi
  fi
  if [[ "$registry_possible" == true ]]; then
    if identity=$(cleanup_run 10 docker inspect --format '{{.Id}}|{{index .Config.Labels "dollhouse.fixture"}}' "${project}-registry" 2>/dev/null); then
      owned_id="${identity%%|*}"; owner="${identity#*|}"
      if [[ "$owned_id" =~ ^[a-f0-9]{64}$ && "$owner" == "$project" ]]; then
        cleanup_run 10 docker rm -f --volumes "$owned_id" >/dev/null || cleanup_ok=false
      else cleanup_ok=false; fi
    else cleanup_ok=false; fi
  fi
  for pair in "$tag_runtime $runtime_id $runtime_tagged" "$tag_migration $migration_id $migration_tagged"; do
    read -r tag expected tagged <<< "$pair"
    [[ "$tagged" == true ]] || continue
    identity=$(cleanup_run 10 docker image inspect --format '{{.Id}}' "$tag") || cleanup_ok=false
    if [[ "$identity" == "$expected" ]]; then cleanup_run 10 docker image rm "$tag" >/dev/null || cleanup_ok=false; else cleanup_ok=false; fi
  done
  [[ "$work" == "${RUNNER_TEMP}/registry-fixture."* ]] && rm -rf -- "$work" || cleanup_ok=false
  [[ "$cleanup_ok" == true && "$completed" == true ]] || result=1
  FIXTURE_SOURCE="$GITHUB_SHA" FIXTURE_PLATFORM="$RUNNER_ARCH" FIXTURE_RUNTIME="$runtime_id" FIXTURE_MIGRATION="$migration_id" \
    FIXTURE_RUNTIME_REF="$runtime_ref" FIXTURE_MIGRATION_REF="$migration_ref" FIXTURE_OLD="$old_id" FIXTURE_NEW="$new_id" \
    FIXTURE_DEPENDENCY="$dependency_id" FIXTURE_PULLED_RUNTIME="$pulled_runtime_id" FIXTURE_PULLED_MIGRATION="$pulled_migration_id" FIXTURE_COMPLETED="$completed" FIXTURE_CLEANUP="$cleanup_ok" FIXTURE_EXIT="$result" \
    timeout --kill-after=1s 4s python3 - "$RUNNER_TEMP/registry-fixture-proof.json" <<'PY' || result=1
import json, os, sys
keys = ('SOURCE', 'PLATFORM', 'RUNTIME', 'MIGRATION', 'RUNTIME_REF', 'MIGRATION_REF', 'OLD', 'NEW', 'DEPENDENCY', 'PULLED_RUNTIME', 'PULLED_MIGRATION', 'COMPLETED', 'CLEANUP', 'EXIT')
with open(sys.argv[1], 'w', encoding='utf-8') as stream:
    json.dump({key.lower(): os.environ['FIXTURE_' + key] for key in keys}, stream, sort_keys=True)
    stream.write('\n')
PY
  exit "$result"
}
trap cleanup EXIT
[[ "$(uname -s)" == Linux && -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" && -z "${DOCKER_TLS_VERIFY:-}" && -z "${DOCKER_CERT_PATH:-}" ]]
[[ "$(run 10 docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]]
case "${RUNNER_ARCH}" in X64) expected_arch=x86_64 ;; ARM64) expected_arch=aarch64 ;; *) exit 1 ;; esac
[[ "$(uname -m)" == "$expected_arch" ]]
daemon_platform="$(run 10 docker info --format '{{.OSType}}|{{.Architecture}}')"
case "${RUNNER_ARCH}:${daemon_platform}" in
  X64:linux\|x86_64|X64:linux\|amd64|ARM64:linux\|aarch64|ARM64:linux\|arm64) : ;;
  *) exit 1 ;;
esac
run 10 docker info --format '{{json .SecurityOptions}}' | python3 -c 'import json,sys; opts=json.load(sys.stdin); assert isinstance(opts,list) and not any("rootless" in x.lower() for x in opts)'
for name in "${project}-app" "${project}-sentinel" "${project}-registry" "${project}-maintenance"; do
  if run 10 docker inspect "$name" >/dev/null 2>&1; then exit 1; fi
done
registry='docker.io/library/registry@sha256:38907510915c3f1604c7e83d6ab602ab3020d092f73bdaed8696773693ff768c'
run 120 docker pull "$registry" >/dev/null
registry_possible=true
registry_id=$(run 15 docker create --name "${project}-registry" --label "dollhouse.fixture=$project" -p 127.0.0.1::5000 "$registry")
[[ "$registry_id" =~ ^[a-f0-9]{64}$ ]]
run 15 docker start "$registry_id" >/dev/null
port=$(run 15 docker port "$registry_id" 5000/tcp)
[[ "$port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]
endpoint="$port"
ready=false
for _ in {1..30}; do
  if run 3 curl --disable --noproxy '*' --proto '=http' --silent --fail --max-time 2 "http://${endpoint}/v2/" >/dev/null; then ready=true; break; fi
  run 2 sleep 1
done
[[ "$ready" == true ]]
tag_runtime="${endpoint}/${project}-runtime:owned"
tag_migration="${endpoint}/${project}-migration:owned"
for pair in "$runtime_id $tag_runtime" "$migration_id $tag_migration"; do
  read -r image tag <<< "$pair"
  if run 10 docker image inspect "$tag" >/dev/null 2>&1; then exit 1; fi
  run 15 docker tag "$image" "$tag"
  if [[ "$tag" == "$tag_runtime" ]]; then runtime_tagged=true; else migration_tagged=true; fi
  run 120 docker push "$tag" >/dev/null
done
reference() {
  local tag="$1" repository="${1%:*}"
  run 15 docker image inspect "$tag" | python3 -c 'import json,sys; items=json.load(sys.stdin)[0]["RepoDigests"]; prefix=sys.argv[1]+"@sha256:"; found=[x for x in items if x.startswith(prefix)]; assert len(found)==1; print(found[0])' "$repository"
}
runtime_ref=$(reference "$tag_runtime")
migration_ref=$(reference "$tag_migration")
run 150 python3 scripts/hosted-deploy/registry_image_admission.py prepare "$runtime_ref" "$migration_ref" > "$work/admission.json"
run 30 python3 scripts/hosted-deploy/registry_image_admission.py inspect "$runtime_ref" "$migration_ref" > "$work/recheck.json"
cmp "$work/admission.json" "$work/recheck.json"
pulled_runtime_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["id"])' "$work/admission.json")
pulled_migration_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[1]["id"])' "$work/admission.json")
for pair in "$runtime_id $pulled_runtime_id" "$migration_id $pulled_migration_id"; do
  read -r built pulled <<< "$pair"
  run 15 docker image inspect "$built" > "$work/built.json"
  run 15 docker image inspect "$pulled" > "$work/pulled.json"
  python3 - "$work/built.json" "$work/pulled.json" <<'PY_COMPARE'
import json, sys
with open(sys.argv[1], encoding='utf-8') as stream: built = json.load(stream)[0]
with open(sys.argv[2], encoding='utf-8') as stream: pulled = json.load(stream)[0]
for key in ('Config', 'RootFS', 'Os', 'Architecture'):
    if built.get(key) != pulled.get(key): raise SystemExit('pulled image differs from built image: ' + key)
PY_COMPARE
done
printf 'FIXTURE_CONFIG_REVISION=original\n' > "$work/fixture.env"
cat > "$work/compose.yml" <<YAML
services:
  sentinel:
    container_name: ${project}-sentinel
    image: ${runtime_ref}
    env_file: [fixture.env]
    network_mode: none
    command: ["node", "-e", "process.on('SIGTERM',()=>process.exit(0)); require('fs').writeFileSync('/app/.memory-upgrade-control/fixture-ready','ready'); setInterval(()=>{},1000)"]
  maintenance:
    image: ${migration_ref}
    env_file: [fixture.env]
    network_mode: none
    depends_on: [sentinel]
    command: ["node", "-e", "if(process.env.FIXTURE_CONFIG_REVISION!=='changed') process.exit(1)"]
  app:
    container_name: ${project}-app
    image: ${runtime_ref}
    network_mode: none
    depends_on: [sentinel]
    command: ["node", "-e", "process.on('SIGTERM',()=>process.exit(0)); require('fs').writeFileSync('/app/.memory-upgrade-control/fixture-ready','ready'); setInterval(()=>{},1000)"]
YAML
sentinel_possible=true
run 30 docker compose -p "$project" -f "$work/compose.yml" up -d --pull never --no-build sentinel
app_possible=true
run 30 docker compose -p "$project" -f "$work/compose.yml" up -d --pull never --no-build --no-deps app
old_id=$(run 15 docker compose -p "$project" -f "$work/compose.yml" ps -q app)
dependency_id=$(run 15 docker compose -p "$project" -f "$work/compose.yml" ps -q sentinel)
[[ "$old_id" =~ ^[a-f0-9]{64}$ && "$dependency_id" =~ ^[a-f0-9]{64}$ ]]
old_started=$(run 15 docker inspect --format '{{.State.StartedAt}}' "$old_id")
dependency_started=$(run 15 docker inspect --format '{{.State.StartedAt}}' "$dependency_id")
# A shared env-file change changes the sentinel's desired configuration.
# The migration-image command override only checks that updated fixture input.
printf 'FIXTURE_CONFIG_REVISION=changed\n' > "$work/fixture.env"
maintenance_possible=true
run 30 docker compose -p "$project" -f "$work/compose.yml" run --name "${project}-maintenance" --rm --pull never --no-deps maintenance
[[ "$(run 15 docker inspect --format '{{.State.Running}}|{{.State.StartedAt}}' "$dependency_id")" == "true|$dependency_started" ]]
[[ "$(run 15 docker compose -p "$project" -f "$work/compose.yml" ps -q sentinel)" == "$dependency_id" ]]
[[ "$(run 15 docker image inspect --format '{{.Id}}' "$runtime_ref")" == "$pulled_runtime_id" ]]
[[ "$(run 15 docker image inspect --format '{{.Id}}' "$migration_ref")" == "$pulled_migration_id" ]]
missing="${endpoint}/${project}-missing@sha256:$(printf '0%.0s' {1..64})"
if run 90 python3 scripts/hosted-deploy/registry_image_admission.py prepare "$runtime_ref" "$missing" > /dev/null 2>&1; then exit 1; fi
[[ "$(run 15 docker inspect --format '{{.State.Running}}|{{.State.StartedAt}}' "$old_id")" == "true|$old_started" ]]
ready=false
for _ in {1..30}; do
  if run 5 docker exec "$old_id" node -e "require('fs').accessSync('/app/.memory-upgrade-control/fixture-ready')"; then ready=true; break; fi
  run 2 sleep 1
done
[[ "$ready" == true ]]
run 10 docker exec "$old_id" node -e "require('fs').writeFileSync('/app/.memory-upgrade-control/fixture-hold','held')"
run 15 docker stop --time -1 "$old_id" >/dev/null
[[ "$(run 15 docker inspect --format '{{.State.ExitCode}}' "$old_id")" == 0 ]]
run 30 docker compose -p "$project" -f "$work/compose.yml" up -d --pull never --no-build --no-deps --force-recreate app
new_id=$(run 15 docker compose -p "$project" -f "$work/compose.yml" ps -q app)
[[ "$new_id" =~ ^[a-f0-9]{64}$ && "$new_id" != "$old_id" ]]
[[ "$(run 15 docker inspect --format '{{.Image}}' "$new_id")" == "$pulled_runtime_id" ]]
[[ "$(run 15 docker inspect --format '{{.State.Running}}|{{.State.StartedAt}}' "$dependency_id")" == "true|$dependency_started" ]]
run 10 docker exec "$new_id" node -e "if(require('fs').existsSync('/app/.memory-upgrade-control/fixture-hold'))process.exit(1)"
completed=true
