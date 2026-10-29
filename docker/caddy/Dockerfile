# Only the reviewed linux/amd64 and linux/arm64/v8 children are qualified.
# Go 1.26.10 / Alpine 3.23, selected by immutable digest only.
FROM docker.io/library/golang@sha256:34414731924cf2263160f0021f5cf6e1807382d85248f7cb419d4187b96d5e43 AS builder
ENV GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 GO111MODULE=on
WORKDIR /src
COPY build/go.mod build/go.sum ./
RUN test "$(go env GOVERSION)" = go1.26.10 \
    && case "$(go env GOARCH)" in amd64|arm64) ;; *) exit 1 ;; esac \
    && sha256sum go.mod go.sum > /src/.qualified-module-locks.sha256 \
    && go mod download \
    && go mod verify \
    && sha256sum -c /src/.qualified-module-locks.sha256
COPY build/main.go ./main.go
# Match the official release recipe, preserving standard modules and tzdata.
RUN go build -trimpath -mod=readonly -tags=nobadger,nomysql,nopgx \
      -ldflags='-s -w' -o /out/caddy . \
    && sha256sum -c /src/.qualified-module-locks.sha256 \
    && go version -m /out/caddy > /out/build-info.txt

# Approved official Caddy 2.11.7 runtime input.
FROM docker.io/library/caddy@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489 AS production
LABEL org.dollhousemcp.caddy.distribution="source-rebuilt-security-candidate" \
      org.dollhousemcp.caddy.upstream-source="72dd0fb067f6d7826c7f79907670ba4a713bfe37" \
      org.dollhousemcp.caddy.go="1.26.10" \
      org.dollhousemcp.caddy.x-net="v0.60.0" \
      org.dollhousemcp.caddy.go-jose-v4="v4.1.6"
COPY remove-curl.sh approved-packages.txt runtime-packages.txt approved-world.txt runtime-world.txt /tmp/caddy-security/
RUN sh /tmp/caddy-security/remove-curl.sh / /tmp/caddy-security \
    && rm -rf /tmp/caddy-security
COPY --from=builder --chown=0:0 --chmod=0755 /out/caddy /usr/bin/caddy
COPY --from=builder /out/build-info.txt /usr/share/caddy/dollhouse-build-info.txt
# Deliberately harden the first-party output: immutable root-owned executable,
# dedicated non-login runtime identity and image-layer storage ownership only.
# Existing persistent volumes require a separate preflight/migration decision.
RUN test -z "$(awk -F: '$1 == "caddy" || $3 == 1001 {print}' /etc/passwd)" \
    && test -z "$(awk -F: '$1 == "caddy" || $3 == 1001 {print}' /etc/group)" \
    && addgroup -S -g 1001 caddy \
    && adduser -S -D -H -u 1001 -G caddy -h /config -s /sbin/nologin caddy \
    && test -f /usr/bin/caddy && test ! -L /usr/bin/caddy \
    && test "$(stat -c '%u:%g:%a:%h' /usr/bin/caddy)" = 0:0:755:1 \
    && setcap cap_net_bind_service=+ep /usr/bin/caddy \
    && test "$(getcap /usr/bin/caddy)" = '/usr/bin/caddy cap_net_bind_service=ep' \
    && for directory in /data /data/caddy /config /config/caddy; do \
         test -d "$directory" && test ! -L "$directory" || exit 1; \
       done \
    && for directory in /data /data/caddy /config /config/caddy; do \
         chown 1001:1001 "$directory" && chmod 0750 "$directory" \
           && test "$(stat -c '%u:%g:%a' "$directory")" = 1001:1001:750 || exit 1; \
       done \
    && /usr/bin/caddy version
USER 1001:1001
# Preserve upstream CMD, ENV, WORKDIR, assets and ports. Runtime USER and
# executable/storage ownership intentionally differ from the upstream base.
