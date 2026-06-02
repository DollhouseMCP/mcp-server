# shellcheck shell=bash
# Generated deployment file rendering for hosted-deploy.

write_compose() {
  cat > "${COMPOSE_FILE}" <<EOF
services:
  postgres:
    image: postgres:17-alpine
    container_name: dollhousemcp-postgres
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
    container_name: dollhousemcp
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
      DOLLHOUSE_HTTP_ALLOWED_HOSTS: ${HOSTNAME}
      DOLLHOUSE_TRUSTED_PROXIES: 172.16.0.0/12
      DOLLHOUSE_PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
      DOLLHOUSE_STORAGE_BACKEND: database
      DOLLHOUSE_DATABASE_URL: postgres://dollhouse_app:\${POSTGRES_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_ADMIN_URL: postgres://dollhouse:\${POSTGRES_ADMIN_PASSWORD}@postgres:5432/dollhousemcp
      DOLLHOUSE_DATABASE_SSL: disable
      DOLLHOUSE_DATABASE_POOL_SIZE: "20"
      DOLLHOUSE_AUTH_ENABLED: "true"
      DOLLHOUSE_AUTH_PROVIDER: embedded
      DOLLHOUSE_AUTH_METHODS: github
      DOLLHOUSE_AUTH_STORAGE_BACKEND: postgres
      DOLLHOUSE_AUTH_OPEN_DCR: "${OPEN_DCR}"
      DOLLHOUSE_WEB_AUTH_ENABLED: "true"
      DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: \${DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED:-true}
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

  caddy:
    image: caddy:2
    container_name: dollhousemcp-caddy
    restart: unless-stopped
    depends_on:
      - dollhousemcp
    ports:
      - "80:80"
      - "443:443"
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

write_caddyfile() {
  cat > "${CADDY_FILE}" <<EOF
${HOSTNAME} {
    encode gzip

    reverse_proxy dollhousemcp:${MCP_PORT} {
        header_up Host {host}
        header_up X-Forwarded-Proto https
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
