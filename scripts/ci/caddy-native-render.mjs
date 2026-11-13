// Invoke the hosted renderer with the same directory and error helpers it expects.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('../hosted-deploy/render.sh', import.meta.url));
const logging = fileURLToPath(new URL('../hosted-deploy/logging.sh', import.meta.url));

export function writeNativeCaddyfile(work, file, mode, trusted) {
  execFileSync('/bin/bash', ['-e', '-c', 'source "$1"; source "$2"; write_caddyfile', 'render', logging, renderer], {
    env: { ...process.env, DEPLOY_DIR: work, PROXY_MODE: mode, HOSTNAME: 'fixture.local',
      HTTP_BIND_PORT: '80', MCP_PORT: '8081', CADDY_FILE: file,
      CADDY_ACCESS_LOG: 'true', CADDY_TRUSTED_PROXIES: trusted },
    encoding: 'utf8', timeout: 10_000,
  });
}
