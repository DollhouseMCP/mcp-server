#!/bin/sh
# A build-only guard for the two approved Caddy 2.11.7 runtime children.
# APK performs its normal offline dependency/trigger processing. No force,
# package upgrade, index download, or hand-written library deletion is used.
set -eu

root=${1:-/}
contracts=${2:-$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)}
case "$root" in /*) ;; *) echo 'runtime root must be absolute' >&2; exit 1 ;; esac
root=$(CDPATH='' cd -- "$root" && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/caddy-curl-removal.XXXXXXXX")
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

# Preserve critical inherited data through normal package triggers. Detailed
# modes, ownership, capabilities and the complete rootfs are qualified later.
for path in etc/ssl/certs/ca-certificates.crt etc/mime.types etc/caddy/Caddyfile usr/share/caddy/index.html; do
  test -f "$root/$path" && test ! -L "$root/$path" || exit 1
  mkdir -p "$work/assets/$(dirname -- "$path")"
  cp "$root/$path" "$work/assets/$path"
done

"$root/sbin/apk" --root "$root" --no-network del curl

inventory > "$work/after-packages"
LC_ALL=C sort "$root/etc/apk/world" > "$work/after-world"
cmp "$contracts/runtime-packages.txt" "$work/after-packages"
cmp "$contracts/runtime-world.txt" "$work/after-world"
for path in etc/ssl/certs/ca-certificates.crt etc/mime.types etc/caddy/Caddyfile usr/share/caddy/index.html; do
  test -f "$root/$path" && test ! -L "$root/$path" || exit 1
  cmp "$work/assets/$path" "$root/$path"
done
if test -e "$root/usr/bin/curl" || test -L "$root/usr/bin/curl"; then
  echo 'curl command remains after package removal' >&2
  exit 1
fi
echo 'Caddy runtime: exactly nine curl-chain removals; 23 unchanged package versions and inherited data verified.'
