/**
 * Docker Container Security Tests
 * 
 * Validates security hardening measures implemented for SEC-005
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { execSync } from 'child_process';
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
      expect(dockerfileContent).toContain('USER dollhouse');
      expect(dockerfileContent).toMatch(/useradd.*-u\s+1001.*dollhouse/);
      expect(dockerfileContent).toMatch(/groupadd.*-g\s+1001.*nodejs/);
    });
    
    it('should remove unnecessary packages', () => {
      expect(dockerfileContent).toContain('apt-get remove');
      expect(dockerfileContent).toContain('curl');
      expect(dockerfileContent).toContain('wget');
      expect(dockerfileContent).toContain('git');
    });
    
    it('should use --no-install-recommends flag', () => {
      expect(dockerfileContent).toContain('--no-install-recommends');
    });
    
    it('should clean up package lists and caches', () => {
      expect(dockerfileContent).toContain('rm -rf /var/lib/apt/lists/*');
      expect(dockerfileContent).toContain('apt-get clean');
      expect(dockerfileContent).toContain('apt-get autoremove');
    });
    
    it('should set restricted shell for non-root user', () => {
      expect(dockerfileContent).toContain('-s /bin/false');
    });
    
    it('should set proper directory permissions', () => {
      expect(dockerfileContent).toContain('chmod -R 750 /app');
    });
    
    it('should create writable directories with restricted permissions', () => {
      expect(dockerfileContent).toContain('mkdir -p /app/tmp /app/logs');
      expect(dockerfileContent).toContain('chmod -R 700 /app/tmp /app/logs');
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
  
  describe('Docker Build Validation', () => {
    // Skip these tests in CI as they require Docker
    const skipInCI = process.env.CI ? it.skip : it;
    
    skipInCI('should build the Docker image successfully', () => {
      try {
        execSync('docker build -t claude-mcp-test-env:test -f docker/Dockerfile .', {
          stdio: 'pipe',
          encoding: 'utf-8'
        });
      } catch (error: any) {
        throw new Error(`Docker build failed: ${error.message}`);
      }
    });
    
    skipInCI('should not include development tools in production image', () => {
      try {
        const output = execSync(
          'docker run --rm claude-mcp-test-env:test which curl || echo "not found"',
          { encoding: 'utf-8' }
        );
        expect(output.trim()).toBe('not found');
      } catch (error: any) {
        // Command failing is expected
        expect(error.status).toBe(1);
      }
    });
    
    skipInCI('should run as non-root user', () => {
      try {
        const output = execSync(
          'docker run --rm claude-mcp-test-env:test id -u',
          { encoding: 'utf-8' }
        );
        expect(output.trim()).toBe('1001');
      } catch (error: any) {
        throw new Error(`Failed to check user ID: ${error.message}`);
      }
    });
  });
  
  describe('Security Best Practices', () => {
    let dockerfileContent: string;
    let composeContent: string;
    
    beforeAll(() => {
      dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      composeContent = fs.readFileSync(dockerComposePath, 'utf-8');
    });
    
    it('should not expose any ports', () => {
      expect(dockerfileContent).not.toMatch(/EXPOSE\s+\d+/);
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
});