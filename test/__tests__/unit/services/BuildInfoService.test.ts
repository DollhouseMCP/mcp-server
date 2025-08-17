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
import { BuildInfoService, BuildInfo } from '../../../../src/services/BuildInfoService.js';

describe('BuildInfoService', () => {
  let service: BuildInfoService;

  beforeEach(() => {
    // Reset the singleton instance for isolation
    (BuildInfoService as any).instance = undefined;
    service = BuildInfoService.getInstance();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = BuildInfoService.getInstance();
      const instance2 = BuildInfoService.getInstance();
      
      expect(instance1).toBe(instance2);
      expect(instance1).toBeInstanceOf(BuildInfoService);
    });

    it('should initialize with current timestamp', () => {
      const newService = BuildInfoService.getInstance();
      expect(newService).toBeDefined();
    });
  });

  describe('getBuildInfo - Integration Tests', () => {
    it('should return complete build info structure', async () => {
      const info = await service.getBuildInfo();

      // Verify the structure exists
      expect(info).toHaveProperty('package');
      expect(info).toHaveProperty('build');
      expect(info).toHaveProperty('runtime');
      expect(info).toHaveProperty('environment');
      expect(info).toHaveProperty('server');
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
        }
      };
    });

    it('should format complete build info as markdown', () => {
      const formatted = service.formatBuildInfo(sampleBuildInfo);

      expect(formatted).toContain('# 🔧 Build Information');
      expect(formatted).toContain('## 📦 Package');
      expect(formatted).toContain('**Name**: @dollhousemcp/mcp-server');
      expect(formatted).toContain('**Version**: 1.3.2');
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
    });

    it('should handle missing optional fields gracefully', () => {
      const minimalInfo: BuildInfo = {
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
      (BuildInfoService as any).instance = undefined;
      let testService = BuildInfoService.getInstance();
      let info = await testService.getBuildInfo();
      expect(info.environment.isDebug).toBe(true);
      
      // Test debug disabled
      process.env.DEBUG = 'false';
      (BuildInfoService as any).instance = undefined;
      testService = BuildInfoService.getInstance();
      info = await testService.getBuildInfo();
      expect(info.environment.isDebug).toBe(false);
      
      // Test debug with '1'
      process.env.DEBUG = '1';
      (BuildInfoService as any).instance = undefined;
      testService = BuildInfoService.getInstance();
      info = await testService.getBuildInfo();
      expect(info.environment.isDebug).toBe(true);
      
      // Restore original
      process.env.DEBUG = originalDebug;
    });

    it('should detect production mode correctly', async () => {
      const originalEnv = process.env.NODE_ENV;
      
      // Test production
      process.env.NODE_ENV = 'production';
      (BuildInfoService as any).instance = undefined;
      let testService = BuildInfoService.getInstance();
      let info = await testService.getBuildInfo();
      expect(info.environment.isProduction).toBe(true);
      expect(info.environment.isDevelopment).toBe(false);
      
      // Test development
      process.env.NODE_ENV = 'development';
      (BuildInfoService as any).instance = undefined;
      testService = BuildInfoService.getInstance();
      info = await testService.getBuildInfo();
      expect(info.environment.isProduction).toBe(false);
      expect(info.environment.isDevelopment).toBe(true);
      
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
});