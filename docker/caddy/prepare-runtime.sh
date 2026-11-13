#!/bin/sh
# Verify the pinned Alpine input and stage only the data Caddy needs.
set -eu

root=${1:-/}
contracts=${2:-$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)}
case "$root" in /*) ;; *) echo 'runtime root must be absolute' >&2; exit 1 ;; esac
root=$(CDPATH='' cd -- "$root" && pwd -P)
output=${3:?runtime output directory required}
work=$(mktemp -d "${TMPDIR:-/tmp}/caddy-runtime.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM

for path in lib/apk/db/installed etc/apk/world; do
  test -f "$root/$path" && test ! -L "$root/$path" || {
    echo "unexpected APK metadata identity: $path" >&2; exit 1;
  }
done

inventory() {
  awk '/^P:/ { name=substr($0,3) } /^V:/ { print name "=" substr($0,3); name="" }' \
    "$root/lib/apk/db/installed" | LC_ALL=C sort
}

inventory > "$work/before-packages"
LC_ALL=C sort "$root/etc/apk/world" > "$work/before-world"
cmp "$contracts/approved-packages.txt" "$work/before-packages"
cmp "$contracts/approved-world.txt" "$work/before-world"

assets='etc/ssl/certs/ca-certificates.crt etc/mime.types etc/caddy/Caddyfile usr/share/caddy/index.html'
for path in $assets; do
  test -f "$root/$path" && test ! -L "$root/$path" || {
    echo "unexpected Caddy input asset: $path" >&2; exit 1
  }
done

umask 022
mkdir "$output"
for path in $assets; do
  mkdir -p "$output/$(dirname -- "$path")"
  cp "$root/$path" "$output/$path"
  chmod 0644 "$output/$path"
done
mkdir -p "$output/data/caddy" "$output/config/caddy" "$output/srv" "$output/tmp"
chmod 1777 "$output/tmp"
chmod 0750 "$output/data" "$output/data/caddy" "$output/config" "$output/config/caddy"
printf '%s\n' 'root:x:0:0:root:/root:/sbin/nologin' 'caddy:x:1001:1001:Caddy:/config:/sbin/nologin' \
  > "$output/etc/passwd"
printf '%s\n' 'root:x:0:' 'caddy:x:1001:' > "$output/etc/group"
