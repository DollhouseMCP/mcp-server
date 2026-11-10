# shellcheck shell=bash
# Generated deployment file rendering for hosted-deploy.

app_image_yaml() {
  if [[ "${IMAGE_MODE}" == registry ]]; then
    printf '    image: %s\n' "${RUNTIME_IMAGE}"
  else
    printf '    build:\n      context: ./server\n      dockerfile: docker/Dockerfile\n      target: production\n    image: %s\n' "${IMAGE_TAG}"
  fi
}

migration_image_yaml() {
  if [[ "${IMAGE_MODE}" == registry ]]; then
    printf '    image: %s\n' "${MIGRATION_IMAGE}"
  else
    printf '    build:\n      context: ./server\n      dockerfile: docker/Dockerfile\n      target: migration\n    image: %s-migrate\n' "${IMAGE_TAG}"
  fi
}

write_compose() {
  cat > "${COMPOSE_FILE}" <<EOF
name: ${INSTANCE_NAME}

x-dollhouse-logging: &dollhouse-logging
  driver: json-file
  options:
    max-size: "${DOCKER_LOG_MAX_SIZE}"
    max-file: "${DOCKER_LOG_MAX_FILE}"

services:
  postgres:
    image: postgres:17-alpine
    container_name: ${POSTGRES_CONTAINER_NAME}
    restart: unless-stopped
    logging: *dollhouse-logging
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
      - ./apply-post-migration-grants.sh:/usr/local/bin/apply-post-migration-grants:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dollhouse -d dollhousemcp"]
      interval: 10s
      timeout: 3s
      retries: 10

  dollhousemcp:
$(app_image_yaml)
    container_name: ${APP_CONTAINER_NAME}
    restart: unless-stopped
    logging: *dollhouse-logging
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
      # Private per-container hold; outside tmpfs and customer mounts.
      DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR: /app/.memory-upgrade-control
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
      DOLLHOUSE_AUTH_GENERATION: "${AUTH_GENERATION}"
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
$(migration_image_yaml)
    profiles:
      - maintenance
    logging: *dollhouse-logging
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
      DOLLHOUSE_AUTH_STORAGE_BACKEND: postgres
    command: ["node", "dist/cli/migrate-database.js"]

  caddy:
    image: ${CADDY_IMAGE}
    user: "1001:1001"
    read_only: true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    sysctls:
      net.ipv4.ip_unprivileged_port_start: "1024"
    tmpfs:
      - /tmp:noexec,nosuid,nodev,size=64M,mode=1777
    container_name: ${CADDY_CONTAINER_NAME}
    restart: unless-stopped
    logging: *dollhouse-logging
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
    external: true
    name: ${CADDY_DATA_VOLUME}
  caddy_config:
    external: true
    name: ${CADDY_CONFIG_VOLUME}
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
  local verification="${1:-false}"
  [[ -n "${CADDY_TRUSTED_PROXIES}" || "${verification}" == true ]] || return 0
  printf '{\n\tservers {\n'
  if [[ "${verification}" == true ]]; then printf '\t\tprotocols h1\n'; fi
  if [[ -n "${CADDY_TRUSTED_PROXIES}" ]]; then
    printf '\t\ttrusted_proxies static %s\n\t\ttrusted_proxies_strict\n' "$(caddy_trusted_proxies_args)"
  fi
  printf '\t}\n}\n\n'

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
			request>headers>X-Onboarding-Csrf delete
			wrap json
		}
	}

EOF

  return 0
}

caddyfile_content() {
  local site_address forwarded_proto verification="${1:-false}" token="${2:-}"
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

  if [[ "${verification}" == true ]]; then
    [[ "${token}" =~ ^[0-9a-f]{32}$ ]] || die 'invalid Caddy verification token'
    cat <<EOF
$(caddy_global_options_block true)
${site_address} {
	encode gzip

$(caddy_access_log_block)
	@verification {
		protocol http/1.1
		method GET
		header Content-Length 0
		header !Authorization
		header !Cookie
		header !Upgrade
		header !Transfer-Encoding
		expression \`{http.request.orig_uri} == "/healthz" || {http.request.orig_uri} == "/readyz" || {http.request.orig_uri} == "/mcp"\`
	}
	route {
		header >X-Dollhouse-Verification ${token}
		reverse_proxy @verification dollhousemcp:${MCP_PORT} {
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
		respond 503
	}
}
EOF
    return 0
  fi

  cat <<EOF
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
}

write_caddyfile() {
  local generated
  [[ ! -L "${CADDY_FILE}" ]] || die "Caddyfile must not be a symlink"
  generated="$(mktemp "${DEPLOY_DIR}/.Caddyfile.XXXXXXXX")" || die "cannot prepare Caddyfile"
  caddyfile_content > "${generated}"
  chmod 0644 "${generated}"
  if [[ -f "${CADDY_FILE}" ]] && cmp -s "${generated}" "${CADDY_FILE}"; then
    rm -f "${generated}"
  else
    mv "${generated}" "${CADDY_FILE}"
  fi
  chmod 0644 "${CADDY_FILE}"

  return 0
}

require_safe_caddyfile_change() {
  if [[ "${CADDY_KEEP_PROXY:-false}" == true ]]; then
    [[ -f "${CADDY_FILE}" && ! -L "${CADDY_FILE}" ]] || die "the running Caddyfile is unavailable"
    caddyfile_content | cmp -s - "${CADDY_FILE}" || die "the unchanged Caddy proxy requires an unchanged Caddyfile"
  fi
  if [[ -d "${SERVER_DIR}" && -e "${CADDY_FILE}" && "${CADDY_RECOVERY_VERIFIED:-false}" != true ]]; then
    [[ ! -L "${CADDY_FILE}" ]] || die "Caddyfile must not be a symlink"
    caddyfile_content | cmp -s - "${CADDY_FILE}" || \
      die "Caddyfile changes require a protected proxy recovery receipt; use the qualified update path"
  fi
}

write_init_db() {
  cat > "${INIT_DB_FILE}" <<'EOF'
#!/bin/sh
set -eu

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
  chmod 0755 "${INIT_DB_FILE}"

  return 0
}

write_post_migration_grants_script() {
  cat > "${POST_MIGRATION_GRANTS_SCRIPT_FILE}" <<'EOF'
#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${DOLLHOUSE_APP_DB_PASSWORD:?DOLLHOUSE_APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v app_password="${DOLLHOUSE_APP_DB_PASSWORD}"
EOF
  chmod 0755 "${POST_MIGRATION_GRANTS_SCRIPT_FILE}"

  return 0
}

validate_rendered_runtime_files() {
  [[ -r "${INIT_DB_FILE}" && -x "${INIT_DB_FILE}" ]] || \
    die "rendered ${INIT_DB_FILE} must be readable and executable by the Postgres entrypoint; expected mode 0755 or equivalent"
  [[ -r "${POST_MIGRATION_GRANTS_FILE}" ]] || \
    die "rendered ${POST_MIGRATION_GRANTS_FILE} must be readable for post-migration grants; expected mode 0644 or equivalent"
  [[ -r "${POST_MIGRATION_GRANTS_SCRIPT_FILE}" && -x "${POST_MIGRATION_GRANTS_SCRIPT_FILE}" ]] || \
    die "rendered ${POST_MIGRATION_GRANTS_SCRIPT_FILE} must be readable and executable in the Postgres container; expected mode 0755 or equivalent"

  return 0
}

write_post_migration_grants() {
  cat > "${POST_MIGRATION_GRANTS_FILE}" <<'EOF'
-- Re-apply app-role grants after migrations create or alter objects.
--
-- The Postgres entrypoint init script runs only on first database creation.
-- Migrations run later, so hosted deploys re-run these grants after every
-- migration pass to make fresh installs and updates converge on the same role
-- privileges.

SELECT format(
  'CREATE ROLE dollhouse_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
  :'app_password'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dollhouse_app')
\gexec
ALTER ROLE dollhouse_app WITH PASSWORD :'app_password';

GRANT CONNECT ON DATABASE dollhousemcp TO dollhouse_app;
GRANT USAGE ON SCHEMA public TO dollhouse_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dollhouse_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dollhouse_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dollhouse_app;

REVOKE INSERT, UPDATE, DELETE ON TABLE users FROM dollhouse_app;

DO $$
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO dollhouse_app';
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO dollhouse_app';
EXCEPTION WHEN invalid_schema_name THEN
  NULL;
END
$$;
EOF
  chmod 0644 "${POST_MIGRATION_GRANTS_FILE}"

  return 0
}

render_files() {
  local expected_caddy_image expected_caddy_data expected_caddy_config
  local expected_image_mode expected_runtime_image expected_migration_image
  resolve_public_base_url
  resolve_hostname
  resolve_allowed_hosts
  validate_render_inputs
  ensure_supported_python
  require_safe_caddyfile_change
  expected_image_mode="${IMAGE_MODE}"; expected_runtime_image="${RUNTIME_IMAGE}"; expected_migration_image="${MIGRATION_IMAGE}"
  expected_caddy_image="${CADDY_IMAGE}"; expected_caddy_data="${CADDY_DATA_VOLUME}"; expected_caddy_config="${CADDY_CONFIG_VOLUME}"
  ensure_layout
  write_env_defaults
  load_env_file
  validate_registry_selection
  [[ "${IMAGE_MODE}" == "${expected_image_mode}" && "${RUNTIME_IMAGE}" == "${expected_runtime_image}" && "${MIGRATION_IMAGE}" == "${expected_migration_image}" ]] ||
    die "image selection changed while loading the deployment environment"
  validate_caddy_selection "${CADDY_IMAGE}" "${CADDY_DATA_VOLUME}" "${CADDY_CONFIG_VOLUME}"
  [[ "${CADDY_IMAGE}" == "${expected_caddy_image}" && "${CADDY_DATA_VOLUME}" == "${expected_caddy_data}" && "${CADDY_CONFIG_VOLUME}" == "${expected_caddy_config}" ]] ||
    die "Caddy selection changed while loading the deployment environment"
  require_safe_caddyfile_change
  write_compose
  write_caddyfile
  write_init_db
  write_post_migration_grants
  write_post_migration_grants_script
  validate_rendered_runtime_files
  log "rendered deployment files in ${DEPLOY_DIR}"

  return 0
}
