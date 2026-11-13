# Only the reviewed linux/amd64 and linux/arm64/v8 children are qualified.
# Go 1.26.10 / Alpine 3.23.8, selected by immutable digest only.
FROM docker.io/library/golang@sha256:78e7f1e419545bc4b8b5ee8a40a99ddb5df1216d38681dbab2eeb1fdb2427f43 AS builder
ENV GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 GO111MODULE=on \
    GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOENV=off \
    GOPRIVATE= GONOPROXY= GONOSUMDB= GOFLAGS=
WORKDIR /src
COPY caddy-overlay.go.mod ./caddy-overlay.go.mod
# Authenticate the exact source archive through Go proxy/SumDB and an
# independently pinned raw ZIP hash. No source archive or module is executed.
RUN test "$(go env GOVERSION)" = go1.26.10 \
    && case "$(go env GOARCH)" in amd64|arm64) ;; *) exit 1 ;; esac \
    && test ! -e /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.9 \
    && test ! -L /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.9 \
    && go mod download github.com/caddyserver/caddy/v2@v2.11.9 \
    && test \
      "$(cat /go/pkg/mod/cache/download/github.com/caddyserver/caddy/v2/@v/v2.11.9.ziphash)" \
      = 'h1:bhZtcRKQOq0fuLvEgCdPYvUxXyGn9kzjG4lh2332DTE=' \
    && printf '%s  %s\n' \
      'fdac2c0901e3e4064bf1da1558f9860cd175eecdf7179b17611d820008268e9b' \
      '/go/pkg/mod/cache/download/github.com/caddyserver/caddy/v2/@v/v2.11.9.zip' | sha256sum -c - \
    && test ! -e /src/caddy-overlay \
    && test -z "$(find /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.9 -type l -print -quit)" \
    && cp -a /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.9 /src/caddy-overlay \
    && diff -r /go/pkg/mod/github.com/caddyserver/caddy/v2@v2.11.9 /src/caddy-overlay \
    && chmod u+w /src/caddy-overlay/go.mod \
    && printf '%s  %s\n' \
      'fe72d06e42cd4d96a1f21a4316687bbb72445168f7b9b12c3b1a075d625abe2c' \
      '/src/caddy-overlay.go.mod' | sha256sum -c - \
    && cp /src/caddy-overlay.go.mod /src/caddy-overlay/go.mod \
    && cd /src/caddy-overlay \
    && find . -type f -print | LC_ALL=C sort > /src/.qualified-source-files \
    && test "$(wc -l < /src/.qualified-source-files)" -eq 740 \
    && xargs sha256sum < /src/.qualified-source-files > /src/.qualified-source.sha256
WORKDIR /src/build
COPY build/go.mod build/go.sum ./
RUN echo '087ac22fe587e30eb5394fd0c5ec037f053127c957595b2d28c24f7aea03a464  go.mod' | sha256sum -c - \
    && echo 'e5f08805a7472c49f427e9f027f9e275874a6da2af3704919c30102568861773  go.sum' | sha256sum -c - \
    && printf '%s  %s\n' \
      'fe72d06e42cd4d96a1f21a4316687bbb72445168f7b9b12c3b1a075d625abe2c' \
      '../caddy-overlay/go.mod' | sha256sum -c - \
    && sha256sum go.mod go.sum ../caddy-overlay/go.mod > /src/.qualified-module-locks.sha256 \
    && go mod download
RUN --network=none go mod verify \
    && sha256sum -c /src/.qualified-module-locks.sha256
COPY build/main.go ./main.go
COPY check-build-info.awk /src/check-build-info.awk
# Match the official release recipe, preserving standard modules and tzdata.
RUN --network=none echo 'ac320c3ac47ad8abed7a0d2595639d78f9ff55cf1dba8494a66cd8851c5d076e  main.go' | sha256sum -c - \
    && go build -trimpath -mod=readonly -tags=nobadger,nomysql,nopgx \
      -ldflags='-s -w' -o /out/caddy . \
    && sha256sum -c /src/.qualified-module-locks.sha256 \
    && (cd /src/caddy-overlay && sha256sum -c /src/.qualified-source.sha256 \
        && find . -type f -print | LC_ALL=C sort > /src/.qualified-source-after \
        && cmp /src/.qualified-source-files /src/.qualified-source-after \
        && test -z "$(find . -type l -print -quit)") \
    && go version -m /out/caddy > /out/build-info.txt \
    && awk -f /src/check-build-info.awk /out/build-info.txt

# This executable is mounted only by native qualification.
FROM builder AS qualification-tools-build
COPY inspect-runtime.go /tmp/inspect-runtime.go
RUN --network=none go build -trimpath -o /out/inspect-runtime /tmp/inspect-runtime.go

FROM scratch AS qualification-tools
COPY --from=qualification-tools-build /out/inspect-runtime /

# Use the OpenSSH-patched Alpine base to prepare the runtime files.
FROM docker.io/library/caddy@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee AS runtime-files
COPY prepare-runtime.sh approved-packages.txt approved-world.txt /tmp/caddy-security/
RUN --network=none sh /tmp/caddy-security/prepare-runtime.sh / /tmp/caddy-security /rootfs
COPY --from=builder --chown=0:0 --chmod=0755 /out/caddy /rootfs/usr/bin/caddy
COPY --from=builder /out/build-info.txt /rootfs/usr/share/caddy/dollhouse-build-info.txt
RUN --network=none chown 1001:1001 \
      /rootfs/data /rootfs/data/caddy /rootfs/config /rootfs/config/caddy \
    && setcap cap_net_bind_service=+ep /rootfs/usr/bin/caddy \
    && test "$(getcap /rootfs/usr/bin/caddy)" = '/rootfs/usr/bin/caddy cap_net_bind_service=ep'

# Copy the closed runtime filesystem without carrying any Alpine base layers.
FROM scratch AS production
LABEL org.dollhousemcp.caddy.distribution="source-rebuilt-security-candidate" \
      org.dollhousemcp.caddy.upstream-source="0d98caea58f794f88e709b1bef2880996a471bca" \
      org.dollhousemcp.caddy.go="1.26.10" \
      org.dollhousemcp.caddy.x-net="v0.62.0" \
      org.dollhousemcp.caddy.go-jose-v4="v4.1.9"
COPY --from=runtime-files /rootfs/ /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    CADDY_VERSION=v2.11.9 XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data
WORKDIR /srv
EXPOSE 2019/tcp 443/tcp 443/udp 80/tcp
USER 1001:1001
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
