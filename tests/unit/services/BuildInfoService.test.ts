/**
 * Tests for BuildInfoService
 * Integration test coverage for build information service including:
 * - Singleton pattern
 * - Package info retrieval
 * - Git info detection
 * - Docker detection
 * - Build timestamp parsing
 * - Formatting methods
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BuildInfoService, BuildInfo } from '../../../src/services/BuildInfoService.js';
import { DollhouseContainer } from '../../../src/di/Container.js';

describe('BuildInfoService', () => {
  let service: BuildInfoService;
  let container: DollhouseContainer;

  beforeEach(() => {
    container = new DollhouseContainer();
    service = container.resolve<BuildInfoService>('BuildInfoService');
  });

  afterEach(async () => {
    await container.dispose();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('getBuildInfo - Integration Tests', () => {
    it('should return complete build info structure', async () => {
      const info = await service.getBuildInfo();

      // Verify the structure exists
      expect(info).toHaveProperty('sessionId');
      expect(info).toHaveProperty('runtimeSessionId');
      expect(info).toHaveProperty('sessionSource');
      expect(info).toHaveProperty('package');
      expect(info).toHaveProperty('build');
      expect(info).toHaveProperty('runtime');
      expect(info).toHaveProperty('environment');
      expect(info).toHaveProperty('server');
    });

    it('should populate session identity information', async () => {
      const info = await service.getBuildInfo();

      expect(info.sessionId).toMatch(/^local-[a-f0-9]{10}$/);
      expect(info.runtimeSessionId).toMatch(new RegExp(`^${info.sessionId}-[a-z0-9]+$`));
      expect(info.sessionSource).toBe('derived');
    });

    it('should populate package information', async () => {
      const info = await service.getBuildInfo();

      expect(info.package).toHaveProperty('name');
      expect(info.package).toHaveProperty('version');
      expect(typeof info.package.name).toBe('string');
      expect(typeof info.package.version).toBe('string');
      expect(info.package.name).toBe('@dollhousemcp/mcp-server');
      expect(info.package.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should populate build information', async () => {
      const info = await service.getBuildInfo();

      expect(info.build).toHaveProperty('type');
      expect(['git', 'npm', 'unknown']).toContain(info.build.type);
      
      // Optional fields
      if (info.build.gitCommit) {
        expect(typeof info.build.gitCommit).toBe('string');
        expect(info.build.gitCommit.length).toBeGreaterThan(0);
      }
      
      if (info.build.gitBranch) {
        expect(typeof info.build.gitBranch).toBe('string');
        expect(info.build.gitBranch.length).toBeGreaterThan(0);
      }
    });

    it('should populate runtime information', async () => {
      const info = await service.getBuildInfo();

      expect(info.runtime.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
      expect(typeof info.runtime.platform).toBe('string');
      expect(typeof info.runtime.arch).toBe('string');
      expect(typeof info.runtime.uptime).toBe('number');
      expect(info.runtime.uptime).toBeGreaterThanOrEqual(0);
      
      expect(info.runtime.memoryUsage).toHaveProperty('rss');
      expect(info.runtime.memoryUsage).toHaveProperty('heapTotal');
      expect(info.runtime.memoryUsage).toHaveProperty('heapUsed');
      expect(typeof info.runtime.memoryUsage.rss).toBe('number');
      expect(typeof info.runtime.memoryUsage.heapTotal).toBe('number');
      expect(typeof info.runtime.memoryUsage.heapUsed).toBe('number');
    });

    it('should populate environment information', async () => {
      const info = await service.getBuildInfo();

      expect(typeof info.environment.isProduction).toBe('boolean');
      expect(typeof info.environment.isDevelopment).toBe('boolean');
      expect(typeof info.environment.isDebug).toBe('boolean');
      expect(typeof info.environment.isDocker).toBe('boolean');
      
      // Docker info is optional
      if (info.environment.dockerInfo) {
        expect(typeof info.environment.dockerInfo).toBe('string');
      }
    });

    it('should populate server information', async () => {
      const info = await service.getBuildInfo();

      expect(info.server.startTime).toBeInstanceOf(Date);
      expect(typeof info.server.uptime).toBe('number');
      expect(info.server.uptime).toBeGreaterThanOrEqual(0);
      expect(info.server.mcpConnection).toBe(true);
    });

    it('includes permission hook audit summary in build info', async () => {
      const info = await service.getBuildInfo();

      expect(info.permissionHooks).toBeDefined();
      expect(Array.isArray(info.permissionHooks?.installedHosts)).toBe(true);
      expect(Array.isArray(info.permissionHooks?.currentHosts)).toBe(true);
      expect(Array.isArray(info.permissionHooks?.repairedHosts)).toBe(true);
      expect(Array.isArray(info.permissionHooks?.needsRepairHosts)).toBe(true);
    });

    it('should have consistent results across calls', async () => {
      const info1 = await service.getBuildInfo();
      const info2 = await service.getBuildInfo();

      // Package info should be the same (cached)
      expect(info1.package).toEqual(info2.package);
      
      // Start time should be the same (set at construction)
      expect(info1.server.startTime).toEqual(info2.server.startTime);
      
      // Build type should be consistent
      expect(info1.build.type).toBe(info2.build.type);
    });

    it('should handle test environment correctly', async () => {
      const info = await service.getBuildInfo();

      // In test environment, NODE_ENV should be 'test'
      expect(info.environment.nodeEnv).toBe('test');
      expect(info.environment.isProduction).toBe(false);
      
      // Development flag depends on explicit setting
      if (process.env.NODE_ENV === 'development') {
        expect(info.environment.isDevelopment).toBe(true);
      } else {
        expect(info.environment.isDevelopment).toBe(false);
      }
    });
  });

  describe('formatBuildInfo', () => {
    let sampleBuildInfo: BuildInfo;

    beforeEach(() => {
      sampleBuildInfo = {
        sessionId: 'workspace-a1b2c3d4e5',
        runtimeSessionId: 'workspace-a1b2c3d4e5-k9',
        sessionSource: 'derived',
        package: {
          name: '@dollhousemcp/mcp-server',
          version: '1.3.2'
        },
        build: {
          timestamp: '2024-01-01T12:00:00.000Z',
          type: 'git',
          gitCommit: 'abc123def',
          gitBranch: 'main'
        },
        runtime: {
          nodeVersion: 'v18.17.0',
          platform: 'linux',
          arch: 'x64',
          uptime: 7200, // 2 hours
          memoryUsage: {
            rss: 104857600,
            heapTotal: 83886080,
            heapUsed: 52428800,
            external: 8388608,
            arrayBuffers: 1048576
          }
        },
        environment: {
          nodeEnv: 'production',
          isProduction: true,
          isDevelopment: false,
          isDebug: false,
          isDocker: true,
          dockerInfo: 'Container ID: 123456789012'
        },
        server: {
          startTime: new Date('2024-01-01T10:00:00.000Z'),
          uptime: 7200000, // 2 hours in ms
          mcpConnection: true
        },
        permissionHooks: {
          installedHosts: [],
          currentHosts: [],
          repairedHosts: [],
          needsRepairHosts: [],
        },
      };
    });

    it('should format complete build info as markdown', () => {
      const formatted = service.formatBuildInfo(sampleBuildInfo);

      expect(formatted).toContain('# 🔧 Build Information');
      expect(formatted).toContain('## 📦 Package');
      expect(formatted).toContain('**Name**: @dollhousemcp/mcp-server');
      expect(formatted).toContain('**Version**: 1.3.2');
      expect(formatted).toContain('## 🪪 Session');
      expect(formatted).toContain('**Session ID**: workspace-a1b2c3d4e5');
      expect(formatted).toContain('**Runtime Session ID**: workspace-a1b2c3d4e5-k9');
      expect(formatted).toContain('**Identity Source**: Derived from workspace context');
      expect(formatted).toContain('## 🏗️ Build');
      expect(formatted).toContain('**Type**: git');
      expect(formatted).toContain('**Timestamp**: 2024-01-01T12:00:00.000Z');
      expect(formatted).toContain('**Git Commit**: `abc123def`');
      expect(formatted).toContain('**Git Branch**: main');
      expect(formatted).toContain('## 💻 Runtime');
      expect(formatted).toContain('**Node.js**: v18.17.0');
      expect(formatted).toContain('**Platform**: linux');
      expect(formatted).toContain('**Architecture**: x64');
      expect(formatted).toContain('**Process Uptime**: 2h');
      expect(formatted).toContain('**Memory Usage**: 50.0 MB / 80.0 MB');
      expect(formatted).toContain('## ⚙️ Environment');
      expect(formatted).toContain('**NODE_ENV**: production');
      expect(formatted).toContain('**Mode**: Production');
      expect(formatted).toContain('**Debug**: Disabled');
      expect(formatted).toContain('**Docker**: Yes');
      expect(formatted).toContain('**Container**: Container ID: 123456789012');
      expect(formatted).toContain('## 🚀 Server');
      expect(formatted).toContain('**Started**: 2024-01-01T10:00:00.000Z');
      expect(formatted).toContain('**Uptime**: 2h');
      expect(formatted).toContain('**MCP Connection**: ✅ Connected');
      expect(formatted).toContain('## 🔐 Permission Hooks');
      expect(formatted).toContain('**Installed Hosts**: None');
      expect(formatted).toContain('**Current Assets**: None');
      expect(formatted).toContain('**Needs Repair**: None');
    });

    it('should handle missing optional fields gracefully', () => {
      const minimalInfo: BuildInfo = {
        sessionId: 'session-from-env',
        runtimeSessionId: 'session-from-env',
        sessionSource: 'env',
        package: {
          name: 'test-app',
          version: '1.0.0'
        },
        build: {
          type: 'unknown'
        },
        runtime: {
          nodeVersion: 'v18.17.0',
          platform: 'darwin',
          arch: 'arm64',
          uptime: 60,
          memoryUsage: {
            rss: 1048576,
            heapTotal: 1048576,
            heapUsed: 524288,
            external: 0,
            arrayBuffers: 0
          }
        },
        environment: {
          isProduction: false,
          isDevelopment: false,
          isDebug: false,
          isDocker: false
        },
        server: {
          startTime: new Date(),
          uptime: 60000,
          mcpConnection: false
        }
      };

      const formatted = service.formatBuildInfo(minimalInfo);

      expect(formatted).toContain('**NODE_ENV**: not set');
      expect(formatted).toContain('**Mode**: Unknown');
      expect(formatted).toContain('**Docker**: No');
      expect(formatted).toContain('**MCP Connection**: ❌ Disconnected');
      expect(formatted).toContain('**Session ID**: session-from-env');
      expect(formatted).toContain('**Identity Source**: Explicit environment');
      expect(formatted).not.toContain('**Runtime Session ID**:');
      expect(formatted).not.toContain('**Timestamp**:');
      expect(formatted).not.toContain('**Git Commit**:');
      expect(formatted).not.toContain('**Git Branch**:');
      expect(formatted).not.toContain('**Container**:');
    });

    it('should format development mode correctly', () => {
      sampleBuildInfo.environment.isProduction = false;
      sampleBuildInfo.environment.isDevelopment = true;

      const formatted = service.formatBuildInfo(sampleBuildInfo);

      expect(formatted).toContain('**Mode**: Development');
    });

    it('should format debug enabled correctly', () => {
      sampleBuildInfo.environment.isDebug = true;

      const formatted = service.formatBuildInfo(sampleBuildInfo);

      expect(formatted).toContain('**Debug**: Enabled');
    });

    it('should format real build info correctly', async () => {
      const realInfo = await service.getBuildInfo();
      const formatted = service.formatBuildInfo(realInfo);

      expect(formatted).toContain('# 🔧 Build Information');
      expect(formatted).toContain('## 📦 Package');
      expect(formatted).toContain('## 🏗️ Build');
      expect(formatted).toContain('## 💻 Runtime');
      expect(formatted).toContain('## ⚙️ Environment');
      expect(formatted).toContain('## 🚀 Server');
      
      // Check that it's valid markdown
      expect(formatted.split('\n')).toContain('# 🔧 Build Information');
    });
  });

  describe('formatUptime', () => {
    it('should format various uptime durations correctly', () => {
      // Access private method through any cast for testing
      const formatUptime = (service as any).formatUptime.bind(service);

      expect(formatUptime(30)).toBe('30s');
      expect(formatUptime(90)).toBe('1m 30s');
      expect(formatUptime(3600)).toBe('1h');
      expect(formatUptime(3661)).toBe('1h 1m 1s');
      expect(formatUptime(86400)).toBe('1d');
      expect(formatUptime(90061)).toBe('1d 1h 1m 1s');
      expect(formatUptime(0)).toBe('0s');
    });

    it('should handle edge cases', () => {
      const formatUptime = (service as any).formatUptime.bind(service);

      expect(formatUptime(1)).toBe('1s');
      expect(formatUptime(59)).toBe('59s');
      expect(formatUptime(60)).toBe('1m');
      expect(formatUptime(3599)).toBe('59m 59s');
      expect(formatUptime(86399)).toBe('23h 59m 59s');
    });
  });

  describe('formatMemory', () => {
    it('should format memory in megabytes with one decimal', () => {
      // Access private method through any cast for testing
      const formatMemory = (service as any).formatMemory.bind(service);

      expect(formatMemory(1048576)).toBe('1.0 MB'); // 1MB
      expect(formatMemory(52428800)).toBe('50.0 MB'); // 50MB
      expect(formatMemory(1572864)).toBe('1.5 MB'); // 1.5MB
      expect(formatMemory(0)).toBe('0.0 MB');
    });

    it('should handle various memory sizes', () => {
      const formatMemory = (service as any).formatMemory.bind(service);

      expect(formatMemory(512 * 1024)).toBe('0.5 MB'); // 512KB
      expect(formatMemory(1024 * 1024 * 100)).toBe('100.0 MB'); // 100MB
      expect(formatMemory(1024 * 1024 * 1024)).toBe('1024.0 MB'); // 1GB
    });
  });

  describe('Environment Detection', () => {
    it('should detect debug mode correctly', async () => {
      const originalDebug = process.env.DEBUG;

      // Test debug enabled
      process.env.DEBUG = 'true';
      let testContainer = new DollhouseContainer();
      let testService = testContainer.resolve<BuildInfoService>('BuildInfoService');
      let info = await testService.getBuildInfo();
      expect(info.environment.isDebug).toBe(true);
      await testContainer.dispose();

      // Test debug disabled
      process.env.DEBUG = 'false';
      testContainer = new DollhouseContainer();
      testService = testContainer.resolve<BuildInfoService>('BuildInfoService');
      info = await testService.getBuildInfo();
      expect(info.environment.isDebug).toBe(false);
      await testContainer.dispose();

      // Test debug with '1'
      process.env.DEBUG = '1';
      testContainer = new DollhouseContainer();
      testService = testContainer.resolve<BuildInfoService>('BuildInfoService');
      info = await testService.getBuildInfo();
      expect(info.environment.isDebug).toBe(true);
      await testContainer.dispose();

      // Restore original
      process.env.DEBUG = originalDebug;
    });

    it('should detect production mode correctly', async () => {
      const originalEnv = process.env.NODE_ENV;

      // Test production
      process.env.NODE_ENV = 'production';
      let testContainer = new DollhouseContainer();
      let testService = testContainer.resolve<BuildInfoService>('BuildInfoService');
      let info = await testService.getBuildInfo();
      expect(info.environment.isProduction).toBe(true);
      expect(info.environment.isDevelopment).toBe(false);
      await testContainer.dispose();

      // Test development
      process.env.NODE_ENV = 'development';
      testContainer = new DollhouseContainer();
      testService = testContainer.resolve<BuildInfoService>('BuildInfoService');
      info = await testService.getBuildInfo();
      expect(info.environment.isProduction).toBe(false);
      expect(info.environment.isDevelopment).toBe(true);
      await testContainer.dispose();

      // Restore original
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Integration and Resilience', () => {
    it('should handle concurrent calls correctly', async () => {
      const promises = [
        service.getBuildInfo(),
        service.getBuildInfo(),
        service.getBuildInfo()
      ];

      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result).toHaveProperty('package');
        expect(result).toHaveProperty('build');
        expect(result).toHaveProperty('runtime');
        expect(result).toHaveProperty('environment');
        expect(result).toHaveProperty('server');
      });
      
      // Package info should be the same for all (cached)
      expect(results[0].package).toEqual(results[1].package);
      expect(results[1].package).toEqual(results[2].package);
    });

    it('should provide fallback values for missing data', async () => {
      const info = await service.getBuildInfo();
      
      // Even if external tools fail, we should get basic structure
      expect(info.package.name).toBeDefined();
      expect(info.package.version).toBeDefined();
      expect(info.build.type).toBeDefined();
      expect(info.runtime.nodeVersion).toBeDefined();
      expect(info.runtime.platform).toBeDefined();
      expect(info.environment.isDocker).toBeDefined();
      expect(info.server.mcpConnection).toBe(true);
    });

    it('should produce deterministic output for same input', () => {
      const testInfo: BuildInfo = {
        package: { name: 'test', version: '1.0.0' },
        build: { type: 'git', gitCommit: 'abc123', gitBranch: 'main' },
        runtime: {
          nodeVersion: 'v18.17.0',
          platform: 'linux',
          arch: 'x64',
          uptime: 3600,
          memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 25 }
        },
        environment: {
          nodeEnv: 'test',
          isProduction: false,
          isDevelopment: true,
          isDebug: false,
          isDocker: false
        },
        server: {
          startTime: new Date('2024-01-01T00:00:00.000Z'),
          uptime: 3600000,
          mcpConnection: true
        }
      };

      const formatted1 = service.formatBuildInfo(testInfo);
      const formatted2 = service.formatBuildInfo(testInfo);

      expect(formatted1).toBe(formatted2);
    });
  });

  // Issue #706: Startup timing and readiness
  describe('Startup Timing (Issue #706)', () => {
    it('should include startup field in getBuildInfo when timer is wired', async () => {
      const { StartupTimer } = await import('../../../src/telemetry/StartupTimer.js');
      const timer = new StartupTimer();
      timer.startPhase('test', true);
      timer.endPhase('test');
      timer.markConnect();

      service.setStartupTimer(timer);
      service.setDeferredSetupChecker(() => true);

      const info = await service.getBuildInfo();
      expect(info.startup).toBeDefined();
      expect(info.startup!.status).toBe('ready');
      expect(info.startup!.deferredSetupComplete).toBe(true);
      expect(info.startup!.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(info.startup!.startupTimingMs).toBeDefined();
      expect(info.startup!.startupTimingMs!.phases).toHaveLength(1);
      expect(info.startup!.startupTimingMs!.connectAtMs).not.toBeNull();
    });

    it('should report initializing status when deferred setup is incomplete', async () => {
      service.setDeferredSetupChecker(() => false);

      const info = await service.getBuildInfo();
      expect(info.startup).toBeDefined();
      expect(info.startup!.status).toBe('initializing');
      expect(info.startup!.deferredSetupComplete).toBe(false);
    });

    it('should default to ready when no checker is wired', async () => {
      // Create a fresh service with no checker wired
      const { FileLockManager } = await import('../../../src/security/fileLockManager.js');
      const { FileOperationsService } = await import('../../../src/services/FileOperationsService.js');
      const freshService = new BuildInfoService(new FileOperationsService(new FileLockManager()));

      const info = await freshService.getBuildInfo();
      expect(info.startup).toBeDefined();
      expect(info.startup!.status).toBe('ready');
      expect(info.startup!.deferredSetupComplete).toBe(true);
    });

    it('should format startup timing section in formatBuildInfo', () => {
      const testInfo: BuildInfo = {
        package: { name: 'test', version: '1.0.0' },
        build: { type: 'git' },
        runtime: {
          nodeVersion: 'v20.0.0', platform: 'darwin', arch: 'arm64',
          uptime: 10, memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 50, arrayBuffers: 25 },
        },
        environment: { isProduction: false, isDevelopment: true, isDebug: false, isDocker: false },
        server: { startTime: new Date(), uptime: 10000, mcpConnection: true },
        startup: {
          status: 'ready',
          deferredSetupComplete: true,
          uptimeMs: 5000,
          startupTimingMs: {
            phases: [
              { name: 'config_checks', critical: true, durationMs: 50 },
              { name: 'memory_autoload', critical: false, durationMs: 1200 },
            ],
            criticalPathMs: 50,
            deferredMs: 1200,
            totalMs: 1250,
            connectAtMs: 80,
          },
        },
      };

      const formatted = service.formatBuildInfo(testInfo);
      expect(formatted).toContain('Startup');
      expect(formatted).toContain('Ready');
      expect(formatted).toContain('Critical Path');
      expect(formatted).toContain('50ms');
      expect(formatted).toContain('Deferred Work');
      expect(formatted).toContain('1200ms');
      expect(formatted).toContain('Time to Connect');
      expect(formatted).toContain('80ms');
      expect(formatted).toContain('config_checks');
      expect(formatted).toContain('memory_autoload');
    });
  });
});
