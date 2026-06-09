# shellcheck shell=bash
# Generated deployment file rendering for hosted-deploy.

write_compose() {
  cat > "${COMPOSE_FILE}" <<EOF
name: ${INSTANCE_NAME}

services:
  postgres:
    image: postgres:17-alpine
    container_name: ${POSTGRES_CONTAINER_NAME}
    restart: unless-stopped
    env_file:
      - .env.production
    environment:
      POSTGRES_USER: dollhouse
      POSTGRES_PASSWORD: \${POSTGRES_ADMIN_PASSWORD}
      POSTGRES_DB: dollhousemcp
      DOLLHOUSE_APP_DB_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - ./pgdata:/var/lib/postgresql/data
      - ./init-db.sh:/docker-entrypoint-initdb.d/00-create-roles.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dollhouse -d dollhousemcp"]
      interval: 10s
      timeout: 3s
      retries: 10

  dollhousemcp:
    build:
      context: ./server
      dockerfile: docker/Dockerfile
      target: production
    image: ${IMAGE_TAG}
    container_name: ${APP_CONTAINER_NAME}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - .env.production
    environment:
      NODE_ENV: production
      DOLLHOUSE_DISABLE_UPDATES: "true"
      DOLLHOUSE_SECURITY_MODE: strict
      DOLLHOUSE_TRANSPORT: streamable-http
      DOLLHOUSE_HTTP_HOST: 0.0.0.0
      DOLLHOUSE_HTTP_PORT: "${MCP_PORT}"
      # The app is reachable only on the Compose network; Caddy owns the public socket.
      DOLLHOUSE_UNSAFE_NO_TLS: "true"
      DOLLHOUSE_HTTP_ALLOWED_HOSTS: ${ALLOWED_HOSTS}
      DOLLHOUSE_TRUSTED_PROXIES: ${TRUSTED_PROXIES}
      DOLLHOUSE_PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
      DOLLHOUSE_STORAGE_BACKEND: database
      DOLLHOUSE_DATABASE_URL: postgres://dollhouse_app:\${POSTGRES_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_ADMIN_URL: postgres://dollhouse:\${POSTGRES_ADMIN_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_SSL: disable
      DOLLHOUSE_DATABASE_POOL_SIZE: "20"
      DOLLHOUSE_AUTH_ENABLED: "true"
      DOLLHOUSE_AUTH_PROVIDER: ${AUTH_PROVIDER}
      DOLLHOUSE_AUTH_METHODS: "${AUTH_METHODS}"
      DOLLHOUSE_AUTH_ISSUER: \${DOLLHOUSE_AUTH_ISSUER:-}
      DOLLHOUSE_AUTH_AUDIENCE: \${DOLLHOUSE_AUTH_AUDIENCE:-}
      DOLLHOUSE_AUTH_JWKS_URI: \${DOLLHOUSE_AUTH_JWKS_URI:-}
      DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP: \${DOLLHOUSE_AUTH_OIDC_REQUIRE_TYP:-false}
      DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE: \${DOLLHOUSE_AUTH_ALLOWLIST_SEED_FILE:-}
      DOLLHOUSE_AUTH_STORAGE_BACKEND: postgres
      DOLLHOUSE_AUTH_OPEN_DCR: "${OPEN_DCR}"
      DOLLHOUSE_WEB_AUTH_ENABLED: "true"
      DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: "${ALLOWLIST_REQUIRED}"
    expose:
      - "${MCP_PORT}"
    volumes:
      - ./portfolio:/home/dollhouse/.dollhouse
    tmpfs:
      - /tmp:noexec,nosuid,size=200M,mode=1777
      - /app/tmp:noexec,nosuid,size=200M,mode=1777
      - /app/logs:noexec,nosuid,size=100M,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: ${MEM_LIMIT}
    cpus: ${CPU_LIMIT}

  dollhousemcp-migrate:
    build:
      context: ./server
      dockerfile: docker/Dockerfile
      target: builder
    image: ${IMAGE_TAG}-migrate
    profiles:
      - maintenance
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - .env.production
    environment:
      NODE_ENV: production
      DOLLHOUSE_DATABASE_URL: postgres://dollhouse_app:\${POSTGRES_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_ADMIN_URL: postgres://dollhouse:\${POSTGRES_ADMIN_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_SSL: disable
    command: ["npm", "run", "db:migrate"]

  caddy:
    # trusted_proxies_strict requires Caddy 2.8 or newer.
    image: caddy:2.8
    container_name: ${CADDY_CONTAINER_NAME}
    restart: unless-stopped
    depends_on:
      - dollhousemcp
    ports:
$(caddy_ports_yaml)
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
EOF

  return 0
}

caddy_ports_yaml() {
  # TLS mode maps host HTTP/HTTPS ports to Caddy's standard ports.
  # HTTP mode maps the selected LAN port through unchanged because Caddy
  # listens on that same port inside the container.
  case "${PROXY_MODE}" in
    caddy-tls)
      printf '      - "%s:%s:80"\n' "${BIND_ADDRESS}" "${HTTP_BIND_PORT}"
      printf '      - "%s:%s:443"\n' "${BIND_ADDRESS}" "${HTTPS_BIND_PORT}"
      ;;
    caddy-http)
      printf '      - "%s:%s:%s"\n' "${BIND_ADDRESS}" "${HTTP_BIND_PORT}" "${HTTP_BIND_PORT}"
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_PROXY_MODE: ${PROXY_MODE}"
      ;;
  esac

  return 0
}

caddy_trusted_proxies_args() {
  printf '%s\n' "${CADDY_TRUSTED_PROXIES//,/ }"

  return 0
}

caddy_global_options_block() {
  [[ -n "${CADDY_TRUSTED_PROXIES}" ]] || return 0

  cat <<EOF
{
	servers {
		trusted_proxies static $(caddy_trusted_proxies_args)
		trusted_proxies_strict
	}
}

EOF

  return 0
}

caddy_access_log_block() {
  [[ "${CADDY_ACCESS_LOG}" == "true" ]] || return 0

  cat <<'EOF'
	log {
		format filter {
			request>uri query {
				replace access_token REDACTED
				replace client_secret REDACTED
				replace code REDACTED
				replace id_token REDACTED
				replace invite REDACTED
				replace password REDACTED
				replace refresh_token REDACTED
				replace session REDACTED
				replace state REDACTED
				replace ticket REDACTED
				replace token REDACTED
			}
			request>headers>Authorization delete
			request>headers>Cookie delete
			wrap json
		}
	}

EOF

  return 0
}

write_caddyfile() {
  local site_address forwarded_proto
  case "${PROXY_MODE}" in
    caddy-tls)
      site_address="${HOSTNAME}"
      forwarded_proto="https"
      ;;
    caddy-http)
      site_address="http://${HOSTNAME}:${HTTP_BIND_PORT}"
      forwarded_proto="http"
      ;;
    *)
      die "unsupported DOLLHOUSE_HOSTED_PROXY_MODE: ${PROXY_MODE}"
      ;;
  esac

  cat > "${CADDY_FILE}" <<EOF
$(caddy_global_options_block)
${site_address} {
	encode gzip

$(caddy_access_log_block)
	reverse_proxy dollhousemcp:${MCP_PORT} {
		header_up Host {host}
		header_up X-Forwarded-Proto ${forwarded_proto}
		header_up X-Forwarded-For {client_ip}
		header_up X-Real-IP {client_ip}
		transport http {
			read_timeout 1h
			write_timeout 1h
			dial_timeout 30s
		}
	}
}
EOF

  return 0
}

write_init_db() {
  cat > "${INIT_DB_FILE}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${DOLLHOUSE_APP_DB_PASSWORD:?DOLLHOUSE_APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v app_password="${DOLLHOUSE_APP_DB_PASSWORD}" <<'SQL'
SELECT format(
  'CREATE ROLE dollhouse_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
  :'app_password'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dollhouse_app')
\gexec
ALTER ROLE dollhouse_app WITH PASSWORD :'app_password';
GRANT CONNECT ON DATABASE dollhousemcp TO dollhouse_app;
GRANT USAGE ON SCHEMA public TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dollhouse_app;
SQL
EOF
  chmod 0750 "${INIT_DB_FILE}"

  return 0
}

render_files() {
  resolve_public_base_url
  resolve_hostname
  resolve_allowed_hosts
  validate_render_inputs
  ensure_layout
  write_env_defaults
  load_env_file
  write_compose
  write_caddyfile
  write_init_db
  log "rendered deployment files in ${DEPLOY_DIR}"

  return 0
}
