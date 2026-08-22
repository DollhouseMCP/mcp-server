import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('permission hook Dockerfile', () => {
  const dockerfile = readFileSync(
    join(process.cwd(), 'tests/docker/permission-hooks/Dockerfile'),
    'utf8',
  );

  it('does not mask package or service-account creation failures', () => {
    expect(dockerfile).toContain('useradd --system --uid 1001');
    expect(dockerfile).not.toContain('|| true');
  });

  it('pins the reviewed Node base image by digest', () => {
    expect(dockerfile).toContain(
      'FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
    );
  });
});
