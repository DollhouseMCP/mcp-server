/**
 * Docker Container Security Tests
 * 
 * Validates security hardening measures implemented for SEC-005
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

describe('Docker Security Hardening', () => {
  const dockerfilePath = path.join(process.cwd(), 'docker/Dockerfile');
  const dockerComposePath = path.join(process.cwd(), 'docker/docker-compose.yml');
  
  describe('Dockerfile Security', () => {
    let dockerfileContent: string;
    
    beforeAll(() => {
      dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
    });
    
    it('should use a non-root user', () => {
      expect(dockerfileContent).toContain('USER 1001:1001');
      expect(dockerfileContent).toContain('COPY --from=runtime-assets --chown=1001:1001 /app /app');
    });
    
    it('keeps the final runtime free of shell and global npm setup', () => {
      const production = dockerfileContent.split(' AS production')[1];
      expect(production).toBeDefined();
      const commands = production.match(/^RUN .+$/gm) ?? [];
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('RUN ["/nodejs/bin/node", "-e",');
      expect(production).not.toContain('/usr/local/lib/node_modules/npm');
    });
    
    it('should use --no-install-recommends flag', () => {
      expect(dockerfileContent).toContain('--no-install-recommends');
    });
    
    it('should clean up package lists and caches', () => {
      expect(dockerfileContent).toContain('rm -rf /var/lib/apt/lists/*');
      expect(dockerfileContent).toContain('apt-get clean');
    });
    
    it('should record a non-login account for the runtime user', () => {
      expect(dockerfileContent).toContain('dollhouse:x:1001:1001:Dollhouse:/home/dollhouse:/sbin/nologin');
    });
    
    it('should set proper directory permissions', () => {
      expect(dockerfileContent).toContain('chmod -R 750 /app');
    });
    
    it('should create writable directories with restricted permissions', () => {
      expect(dockerfileContent).toContain('mkdir -p /app/tmp /app/logs');
      expect(dockerfileContent).toContain('chmod 700 /app/tmp /app/logs /app/.memory-upgrade-control /home/dollhouse');
    });
    
    it('should include security labels', () => {
      expect(dockerfileContent).toContain('LABEL security.non-root=\"true\"');
      expect(dockerfileContent).toContain('security.no-new-privileges=\"true\"');
      expect(dockerfileContent).toContain('security.read-only-root=\"true\"');
    });
    
    it('should set DOLLHOUSE_SECURITY_MODE environment variable', () => {
      expect(dockerfileContent).toContain('DOLLHOUSE_SECURITY_MODE=strict');
    });
    
    it('should use multi-stage build', () => {
      expect(dockerfileContent).toMatch(/FROM.*AS builder/);
      expect(dockerfileContent).toMatch(/FROM.*AS production/);
    });
  });
  
  describe('Docker Compose Security', () => {
    let composeContent: string;
    
    beforeAll(() => {
      composeContent = fs.readFileSync(dockerComposePath, 'utf-8');
    });
    
    it('should specify non-root user', () => {
      expect(composeContent).toContain('user: "1001:1001"');
    });
    
    it('should drop all capabilities', () => {
      expect(composeContent).toContain('cap_drop:');
      expect(composeContent).toContain('- ALL');
    });
    
    it('should prevent privilege escalation', () => {
      expect(composeContent).toContain('security_opt:');
      expect(composeContent).toContain('- no-new-privileges:true');
    });
    
    it('should use read-only root filesystem', () => {
      expect(composeContent).toContain('read_only: true');
    });
    
    it('should define tmpfs mounts with security flags', () => {
      expect(composeContent).toContain('tmpfs:');
      expect(composeContent).toContain('/tmp:noexec,nosuid');
      expect(composeContent).toContain('/app/tmp:noexec,nosuid');
      expect(composeContent).toContain('/app/logs:noexec,nosuid');
    });
    
    it('should set memory and CPU limits', () => {
      expect(composeContent).toContain('mem_limit: 512m');
      expect(composeContent).toContain('cpus: 0.5');
    });
    
    it('should disable inter-container communication', () => {
      expect(composeContent).toContain('ipc: private');
    });
    
    it('should mount volumes as read-only', () => {
      expect(composeContent).toMatch(/custom-personas.*:ro/);
    });
    
    it('should set DOLLHOUSE_SECURITY_MODE in environment', () => {
      expect(composeContent).toContain('DOLLHOUSE_SECURITY_MODE=strict');
    });
  });
  
  // Native build success, UID and missing-tool checks run against the exact
  // built image on both CI architectures in runtime-contract.cjs.

  describe('Security Best Practices', () => {
    let composeContent: string;

    beforeAll(() => {
      composeContent = fs.readFileSync(dockerComposePath, 'utf-8');
    });
    
    it('should not expose ports in stdio compose (HTTP has its own compose)', () => {
      expect(composeContent).not.toContain('ports:');
    });
    
    it('should not use privileged mode', () => {
      expect(composeContent).not.toContain('privileged: true');
    });
    
    it('should not mount Docker socket', () => {
      expect(composeContent).not.toContain('/var/run/docker.sock');
    });
    
    it('should not use host network mode', () => {
      expect(composeContent).not.toContain('network_mode: host');
    });
    
    it('should not add capabilities in production', () => {
      const productionService = composeContent.split('dollhousemcp:')[0];
      expect(productionService).not.toContain('cap_add:');
    });
  });
  
  describe('Development Service Security', () => {
    let composeContent: string;
    
    beforeAll(() => {
      composeContent = fs.readFileSync(dockerComposePath, 'utf-8');
    });
    
    it('should still run as non-root in development', () => {
      const devSection = composeContent.split('dollhousemcp-dev:')[1];
      expect(devSection).toContain('user: "1001:1001"');
    });
    
    it('should drop all capabilities and add only necessary ones', () => {
      const devSection = composeContent.split('dollhousemcp-dev:')[1];
      expect(devSection).toContain('cap_drop:');
      expect(devSection).toContain('- ALL');
      expect(devSection).toContain('cap_add:');
      expect(devSection).toContain('- DAC_OVERRIDE');
      expect(devSection).toContain('- CHOWN');
    });
  });

  describe('HTTP Hosted Mode Docker Configuration', () => {
    let dockerfileContent: string;
    const httpComposePath = path.join(process.cwd(), 'docker/docker-compose.http.yml');

    beforeAll(() => {
      dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
    });

    it('should include HEALTHCHECK directive in Dockerfile', () => {
      expect(dockerfileContent).toContain('HEALTHCHECK');
      expect(dockerfileContent).toContain('/healthz');
    });

    it('should include EXPOSE directive for HTTP port', () => {
      expect(dockerfileContent).toMatch(/EXPOSE\s+3000/);
    });

    it('should have HTTP compose file', () => {
      expect(fs.existsSync(httpComposePath)).toBe(true);
    });

    it('should bind to 0.0.0.0 in HTTP compose (required for container networking)', () => {
      const httpCompose = fs.readFileSync(httpComposePath, 'utf-8');
      expect(httpCompose).toContain('DOLLHOUSE_HTTP_HOST=0.0.0.0');
    });

    it('should expose port in HTTP compose', () => {
      const httpCompose = fs.readFileSync(httpComposePath, 'utf-8');
      expect(httpCompose).toContain('ports:');
      expect(httpCompose).toMatch(/"3000:3000"/);
    });

    it('should set streamable-http transport in HTTP compose', () => {
      const httpCompose = fs.readFileSync(httpComposePath, 'utf-8');
      expect(httpCompose).toContain('DOLLHOUSE_TRANSPORT=streamable-http');
    });

    it('should maintain security hardening in HTTP compose', () => {
      const httpCompose = fs.readFileSync(httpComposePath, 'utf-8');
      expect(httpCompose).toContain('cap_drop:');
      expect(httpCompose).toContain('- ALL');
      expect(httpCompose).toContain('no-new-privileges:true');
      expect(httpCompose).toContain('read_only: true');
      expect(httpCompose).toContain('user: "1001:1001"');
    });

    it('should use restart policy suitable for long-running HTTP server', () => {
      const httpCompose = fs.readFileSync(httpComposePath, 'utf-8');
      expect(httpCompose).toContain('restart: unless-stopped');
    });
  });
});
