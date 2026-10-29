#!/usr/bin/env bash
# TEST ONLY. Existing hosted CI images only; never run on the developer host/VM.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_OS:-}" = Linux
platform="${1:?exact platform required}"
case "$platform:${RUNNER_ARCH:-}" in
  linux/amd64:X64|linux/arm64:ARM64) ;;
  *) echo 'Native runner/platform mismatch' >&2; exit 1 ;;
esac
test "$(git rev-parse HEAD)" = "${GITHUB_SHA:?}"
root="$(pwd)"
proof="${RUNNER_TEMP:?}/node-runtime-qualification"
mkdir -m 0700 "$proof"
mkdir -m 0777 "$proof/native"
chmod 0777 "$proof/native"
tag="${platform//\//-}"
container="node-qualification-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-$tag"
evidence="$root/tests/qualification/node-runtime/evidence.py"
phase=initialize
finish() {
  status=$?
  trap - EXIT
  set +e
  timeout 25 python3 "$evidence" cleanup "$proof" "$platform" "$container" > "$proof/cleanup.log" 2>&1
  cleanup_status=$?
  timeout 15 python3 "$evidence" finalize "$proof" "$platform" "$status" "$phase" "$cleanup_status"
  receipt_status=$?
  if [ "$status" -eq 0 ] && { [ "$receipt_status" -ne 0 ] || [ "$cleanup_status" -ne 0 ]; }; then status=1; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
run_phase() {
  phase=$1; shift
  python3 "$evidence" phase "$proof" "$platform" "$phase" started -
  if "$@"; then phase_status=0; else phase_status=$?; fi
  if ! python3 "$evidence" phase "$proof" "$platform" "$phase" finished "$phase_status"; then
    if [ "$phase_status" -eq 0 ]; then phase_status=1; fi
  fi
  return "$phase_status"
}
python3 "$evidence" init "$proof" "$platform"
base="dollhousemcp:qualification-base-$tag"
builder="dollhousemcp:builder-$tag"
production="dollhousemcp:latest-$tag"
# Bind existing job-built images even if the additional base-stage load fails.
run_phase bind-existing-images python3 "$evidence" bind "$proof" "$platform" "$builder" "$production"
# Existing Buildx stage cache is reused; production recipes and pins are unchanged.
run_phase node-base-build timeout 120 docker buildx build --platform "$platform" --target node-base --load \
  --tag "$base" --file docker/Dockerfile . > "$proof/node-base-build.log" 2>&1
run_phase bind-all-images python3 "$evidence" bind "$proof" "$platform" "$builder" "$production" "$base"
# All probes execute immutable captured IDs, never mutable tags.
base_id=$(python3 "$evidence" image-id "$proof" "$platform" node-base)
builder_id=$(python3 "$evidence" image-id "$proof" "$platform" builder)
production_id=$(python3 "$evidence" image-id "$proof" "$platform" production)
common=(--rm --name "$container" --platform "$platform" --network none --read-only --no-healthcheck
  --cap-drop ALL --security-opt no-new-privileges --user 1001:1001
  --pids-limit 64 --memory 512m --memory-swap 512m --cpus 1
  --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777'
  --tmpfs '/app/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'
  --mount "type=bind,src=$root/tests/qualification/node-runtime,dst=/qualification,readonly"
  --mount "type=bind,src=$root/scripts/ci/prepare-global-npm.mjs,dst=/proof/inventory.mjs,readonly"
  --mount "type=bind,src=$root/docker/node-runtime-security-refresh.json,dst=/proof/recipe.json,readonly"
  --mount "type=bind,src=$root/tests/fixtures/tls/pinned-outbound,dst=/tls,readonly")
run_phase node-base-runtime timeout 60 docker run "${common[@]}" --entrypoint /usr/local/bin/node "$base_id" \
  /qualification/runtime-proof.mjs node-base > "$proof/node-base-runtime.json" 2> "$proof/node-base-runtime.stderr.log"
# Node24 V8 headers require C++20; the distribution compiler's default is insufficient.
run_phase native-compile timeout 30 docker run "${common[@]}" \
  --mount "type=bind,src=$proof/native,dst=/native" --entrypoint /usr/bin/g++ "$builder_id" \
  -std=c++20 -shared -fPIC -DNODE_GYP_MODULE_NAME=qualification -I/usr/local/include/node \
  /qualification/addon.cc -o /native/qualification.node > "$proof/native-compile.log" 2>&1
for stage in builder production; do
  image="$builder_id"; test "$stage" != production || image="$production_id"
  run_phase "$stage-runtime" timeout 60 docker run "${common[@]}" \
    --mount "type=bind,src=$proof/native,dst=/native,readonly" \
    --entrypoint /usr/local/bin/node "$image" /qualification/runtime-proof.mjs "$stage" \
    > "$proof/$stage-runtime.json" 2> "$proof/$stage-runtime.stderr.log"
done
run_phase application-runtime timeout 20 docker run "${common[@]}" --entrypoint /usr/local/bin/node "$production_id" \
  /qualification/application-proof.mjs > "$proof/application-runtime.json" 2> "$proof/application-runtime.stderr.log"
phase=complete
