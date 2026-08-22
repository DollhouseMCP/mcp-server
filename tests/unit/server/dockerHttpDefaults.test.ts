import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('streamable HTTP Docker defaults', () => {
  it('keeps the container listener reachable while publishing only on loopback by default', () => {
    const compose = readFileSync(join(process.cwd(), 'docker/docker-compose.http.yml'), 'utf8');

    expect(compose).toContain('DOLLHOUSE_HTTP_HOST=0.0.0.0');
    expect(compose).toContain('"${DOLLHOUSE_HTTP_PUBLISH_ADDRESS:-127.0.0.1}:3000:3000"');
    expect(compose).toContain('DOLLHOUSE_HTTP_ALLOWED_HOSTS=${DOLLHOUSE_HTTP_ALLOWED_HOSTS:-localhost,127.0.0.1}');
    expect(compose).not.toMatch(/^\s*-\s*["']?3000:3000["']?\s*$/m);
  });
});
