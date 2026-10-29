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
mkdir -p "$proof/native"
chmod 0777 "$proof/native"
tag="${platform//\//-}"
container="node-qualification-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-$tag"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$proof" "$platform" <<'PY'
import json,os,sys
from pathlib import Path
Path(sys.argv[1],'invocation.json').write_text(json.dumps({
    'source':os.environ['GITHUB_SHA'],'run_id':os.environ['GITHUB_RUN_ID'],
    'run_attempt':os.environ['GITHUB_RUN_ATTEMPT'],'platform':sys.argv[2],
    'security_scope':'PARTIAL runtime only; scanner authority absent; release HOLD'},indent=2)+'\n')
PY
base="dollhousemcp:qualification-base-$tag"
builder="dollhousemcp:builder-$tag"
production="dollhousemcp:latest-$tag"
# Existing Buildx stage cache is reused; production recipes and pins are unchanged.
timeout 120 docker buildx build --platform "$platform" --target node-base --load \
  --tag "$base" --file docker/Dockerfile . > "$proof/node-base-build.log" 2>&1
common=(--rm --name "$container" --platform "$platform" --network none --read-only --no-healthcheck
  --cap-drop ALL --security-opt no-new-privileges --user 1001:1001
  --pids-limit 64 --memory 512m --memory-swap 512m --cpus 1
  --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777'
  --tmpfs '/app/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'
  --mount "type=bind,src=$root/tests/qualification/node-runtime,dst=/qualification,readonly"
  --mount "type=bind,src=$root/scripts/ci/prepare-global-npm.mjs,dst=/proof/inventory.mjs,readonly"
  --mount "type=bind,src=$root/docker/node-runtime-security-refresh.json,dst=/proof/recipe.json,readonly"
  --mount "type=bind,src=$root/tests/fixtures/tls/pinned-outbound,dst=/tls,readonly")
timeout 60 docker run "${common[@]}" --entrypoint /usr/local/bin/node "$base" \
  /qualification/runtime-proof.mjs node-base > "$proof/node-base-runtime.json"
# Compile a minimal legacy ABI addon offline, using the candidate's actual headers.
timeout 30 docker run "${common[@]}" \
  --mount "type=bind,src=$proof/native,dst=/native" --entrypoint /usr/bin/g++ "$builder" \
  -shared -fPIC -DNODE_GYP_MODULE_NAME=qualification -I/usr/local/include/node \
  /qualification/addon.cc -o /native/qualification.node > "$proof/native-compile.log" 2>&1
for stage in builder production; do
  image="$builder"; test "$stage" != production || image="$production"
  timeout 60 docker run "${common[@]}" \
    --mount "type=bind,src=$proof/native,dst=/native,readonly" \
    --entrypoint /usr/local/bin/node "$image" /qualification/runtime-proof.mjs "$stage" \
    > "$proof/$stage-runtime.json"
done
timeout 20 docker run "${common[@]}" --entrypoint /usr/local/bin/node "$production" \
  /qualification/application-proof.mjs > "$proof/application-runtime.json"
# Capture selected facts only, never complete inspect Env or credentials.
python3 - "$proof" "$platform" "$base" "$builder" "$production" <<'PY'
import hashlib, json, os, subprocess, sys
from pathlib import Path
out=Path(sys.argv[1]); images={}
for stage, image in zip(['node-base','builder','production'],sys.argv[3:]):
    raw=subprocess.check_output(['docker','image','inspect',image],timeout=10)
    value=json.loads(raw)[0]
    images[stage]={k:value.get(k) for k in ['Id','Architecture','Os','Size','RootFS']}
    images[stage]['labels']=value.get('Config',{}).get('Labels',{})
    images[stage]['tag']=image
files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.glob('*.json')}
(out/'source-image-binding.json').write_text(json.dumps({'source':os.environ['GITHUB_SHA'],
    'run_id':os.environ['GITHUB_RUN_ID'],'run_attempt':os.environ['GITHUB_RUN_ATTEMPT'],
    'platform':sys.argv[2],'images':images,'report_sha256':files,
    'scope':'Runtime qualification only; independent artifact review and all security/release gates remain HOLD.'},indent=2)+'\n')
PY
