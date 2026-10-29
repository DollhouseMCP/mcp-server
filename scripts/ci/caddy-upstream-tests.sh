#!/bin/sh
# Run inside the exact qualified builder, on a network-isolated container.
# These are full selected upstream unit packages, not the whole Caddy suite.
set -eu
test "$(go env GOVERSION)" = go1.26.10
test "${CGO_ENABLED:-}" = 0
test "${GOTOOLCHAIN:-}" = local
test "${GOWORK:-}" = off
work=$(mktemp -d /tmp/caddy-upstream.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
trap 'exit 1' HUP INT TERM
cp -a /root/.cache/go-build "$work/gocache"
mkdir "$work/tmp"
export GOCACHE="$work/gocache" GOTMPDIR="$work/tmp" GOMAXPROCS=2
export XDG_DATA_HOME="$work/pki-data" XDG_CONFIG_HOME="$work/pki-config"
sha256sum -c /tmp/qualified-module-locks.sha256
go mod verify
# Upstream parser tests create and remove fixture files in their source
# testdata directory. This container has its own writable overlay: neither
# the immutable builder image nor a host/shared module cache is modified.
module=$(go list -m -mod=readonly -f '{{.Dir}}' github.com/caddyserver/caddy/v2)
test "$module" = /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.7
test -d "$module/caddyconfig/caddyfile/testdata"
test ! -L "$module/caddyconfig/caddyfile/testdata"
chmod u+w "$module/caddyconfig/caddyfile/testdata"
go test -json -count=1 -mod=readonly -tags=nobadger,nomysql,nopgx -p 2 -parallel 2 \
  github.com/caddyserver/caddy/v2/caddyconfig/... \
  github.com/caddyserver/caddy/v2/modules/caddyhttp/reverseproxy \
  github.com/caddyserver/caddy/v2/modules/caddyhttp/headers \
  github.com/caddyserver/caddy/v2/modules/caddyhttp/encode/... \
  github.com/caddyserver/caddy/v2/modules/caddytls \
  github.com/go-jose/go-jose/v4/... \
  golang.org/x/net/http2
go mod verify
sha256sum -c /tmp/qualified-module-locks.sha256
