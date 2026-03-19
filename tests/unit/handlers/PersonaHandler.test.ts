import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

import { PersonaHandler } from '../../../src/handlers/PersonaHandler.js';
import { PathValidator } from '../../../src/security/pathValidator.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import * as yaml from 'js-yaml';

describe('PersonaHandler', () => {
  let handler: InstanceType<typeof PersonaHandler>;
  let mockPersonaManager: any;
  let mockPersonaExporter: any;
  let mockPersonaImporter: any;
  let mockInitService: any;
  let mockPersonaIndicatorService: any;
  let activePersonaState: { current: string | null };
  let container: InstanceType<typeof DollhouseContainer>;
  let tempDir: string;

const personaContent = (overrides: { name: string; description: string; uniqueId: string; version?: string }) => `---
name: "${overrides.name}"
description: "${overrides.description}"
version: "${overrides.version ?? '1.0'}"
unique_id: "${overrides.uniqueId}"
triggers:
  - analyze
category: general
---
This is a sample persona with enough instructional content to satisfy validation requirements.`;

  beforeEach(async () => {
    container = new DollhouseContainer();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-handler-'));
    PathValidator.initialize(tempDir);

    activePersonaState = { current: null as string | null };

    // Create persona files for testing
    await fs.writeFile(
      path.join(tempDir, 'sample-persona-1.md'),
      personaContent({ name: 'Sample Persona 1', description: 'A test persona', uniqueId: 'sample-1' }),
      'utf-8'
    );

    await fs.writeFile(
      path.join(tempDir, 'sample-persona-2.md'),
      personaContent({ name: 'Sample Persona 2', description: 'Another test persona', uniqueId: 'sample-2' }),
      'utf-8'
    );

    // Load mock personas data
    const personas = new Map();
    const files = await fs.readdir(tempDir);
    for (const file of files.filter(name => name.endsWith('.md'))) {
      const raw = await fs.readFile(path.join(tempDir, file), 'utf-8');
      const [, frontmatterRaw, ...contentParts] = raw.split('---\n');
      const body = contentParts.join('---\n');
      const metadata = yaml.load(frontmatterRaw) as any;
      personas.set(file, {
        filename: file,
        unique_id: metadata.unique_id,
        metadata: {
          ...metadata
        },
        content: body.trim()
      } as any);
    }

    // Create mock services for pure DI
    mockPersonaManager = {
      list: jest.fn().mockResolvedValue(Array.from(personas.values())),
      find: jest.fn().mockImplementation(async (predicate: any) => {
        const values = Array.from(personas.values());
        return values.find(predicate) || null;
      }),
      reload: jest.fn().mockResolvedValue(undefined),
      // v2: unified create() API instead of createNewPersona
      create: jest.fn(),
      editExistingPersona: jest.fn(),
      exportElement: jest.fn(),
      importPersona: jest.fn(),
      validatePersona: jest.fn(),
      deletePersona: jest.fn(),
    };

    mockPersonaExporter = {
      exportPersona: jest.fn(),
      toBase64: jest.fn(),
      formatExportResult: jest.fn(),
      exportBundle: jest.fn(),
      formatBundleResult: jest.fn(),
    };

    mockPersonaImporter = {
      importPersona: jest.fn(),
    };

    mockInitService = {
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
    };

    mockPersonaIndicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('>>'),
    };

    // Create the handler with pure DI
    handler = new PersonaHandler(
      mockPersonaManager,
      mockPersonaExporter,
      mockPersonaImporter,
      mockInitService,
      mockPersonaIndicatorService,
      {
        get: () => activePersonaState.current,
        set: (value: string | null) => { activePersonaState.current = value; }
      }
    );
  });

  afterEach(async () => {
    await container.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('listPersonas', () => {
    it('should list available personas and indicate none is active', async () => {
      const result = await handler.listPersonas();
      expect(result.content[0].text).toContain('Available Personas (2)');
      expect(result.content[0].text).toContain('**Sample Persona 1**');
      expect(result.content[0].text).toContain('**Sample Persona 2**');
      expect(result.content[0].text).not.toContain('🔹'); // No active persona indicator
    });

    it('should indicate the active persona', async () => {
      activePersonaState.current = 'sample-persona-1.md';
      const result = await handler.listPersonas();
      expect(result.content[0].text).toContain('🔹 **Sample Persona 1**');
    });
  });

  describe('activatePersona', () => {
    it('should activate a persona by its filename', async () => {
      const result = await handler.activatePersona('sample-persona-1.md');
      expect(activePersonaState.current).toBe('sample-persona-1.md');
      expect(result.content[0].text).toContain('Persona Activated: **Sample Persona 1**');
    });

    it('should activate a persona by its name', async () => {
      await handler.activatePersona('Sample Persona 2');
      expect(activePersonaState.current).toBe('sample-persona-2.md');
    });

    it('should return error response if persona is not found', async () => {
      mockPersonaManager.find.mockResolvedValue(null);
      const result = await handler.activatePersona('non-existent');
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Persona Not Found');
      expect(result.content[0].text).toContain('non-existent');
    });
  });

  describe('deactivatePersona', () => {
    it('should deactivate the active persona', async () => {
      activePersonaState.current = 'sample-persona-1.md';
      const result = await handler.deactivatePersona();
      expect(activePersonaState.current).toBe(null);
      expect(result.content[0].text).toContain('Persona deactivated');
    });

    it('should report that no persona was active', async () => {
      const result = await handler.deactivatePersona();
      expect(result.content[0].text).toBe('No persona was active.');
    });
  });

  describe('editPersona', () => {
    it('updates metadata and increments version', async () => {
      const updatedPersona = {
        filename: 'sample-persona-1.md',
        unique_id: 'sample-1',
        metadata: {
          name: 'Sample Persona 1',
          description: 'Updated description',
          version: '1.1',
          unique_id: 'sample-1',
        },
        content: 'Test content',
        version: '1.1',
      };
      mockPersonaManager.editExistingPersona.mockResolvedValue(updatedPersona);

      const result = await handler.editPersona('sample-persona-1', 'description', 'Updated description');
      expect(result.content[0].text).toContain('Persona Updated Successfully');
      expect(mockPersonaManager.editExistingPersona).toHaveBeenCalled();
    });

    it('returns not found when persona is missing', async () => {
      mockPersonaManager.find.mockResolvedValue(null);
      const result = await handler.editPersona('missing-persona', 'description', 'Updated');
      expect(result.content[0].text).toContain('Persona Not Found');
    });
  });

  describe('validatePersona', () => {
    it('produces a validation report', async () => {
      mockPersonaManager.validatePersona.mockReturnValue({
        success: true,
        message: 'Valid',
        report: {
          valid: true,
          issues: [],
          warnings: [],
          report: 'All checks passed'
        }
      });
      const result = await handler.validatePersona('sample-persona-1');
      expect(result.content[0].text).toContain('Validation Report');
    });

    it('reports missing persona identifiers', async () => {
      const result = await handler.validatePersona('');
      expect(result.content[0].text).toContain('Missing Persona Identifier');
    });
  });

  describe('deletePersona', () => {
    it('removes persona file and cache entry', async () => {
      mockPersonaManager.deletePersona.mockResolvedValue({
        success: true,
        message: "Successfully deleted persona 'sample-persona-1'"
      });
      const result = await handler.deletePersona('sample-persona-1');
      expect(result.content[0].text).toContain("Successfully deleted persona 'sample-persona-1'");
      expect(mockPersonaManager.deletePersona).toHaveBeenCalledWith('sample-persona-1.md');
    });

    it('returns not found when persona is missing', async () => {
      mockPersonaManager.find.mockResolvedValue(null);
      const result = await handler.deletePersona('non-existent');
      expect(result.content[0].text).toContain("Persona 'non-existent' not found");
    });
  });

  describe('getActivePersona', () => {
    it('should return details of the active persona', async () => {
      activePersonaState.current = 'sample-persona-1.md';
      const result = await handler.getActivePersona();
      expect(result.content[0].text).toContain('Active Persona: **Sample Persona 1**');
      expect(result.content[0].text).toContain('A test persona');
    });

    it('should report when no persona is active', async () => {
      const result = await handler.getActivePersona();
      expect(result.content[0].text).toContain('No persona is currently active');
    });

    it('should deactivate if active persona not found', async () => {
      activePersonaState.current = 'non-existent.md';
      mockPersonaManager.find.mockResolvedValue(null);
      const result = await handler.getActivePersona();
      expect(result.content[0].text).toContain('Active persona not found. Deactivated.');
      expect(activePersonaState.current).toBe(null);
    });
  });

  describe('getPersonaDetails', () => {
    it('should return detailed information about a persona by filename', async () => {
      const result = await handler.getPersonaDetails('sample-persona-1.md');
      expect(result.content[0].text).toContain('**Sample Persona 1** Details');
      expect(result.content[0].text).toContain('A test persona');
    });

    it('should return details by persona name', async () => {
      const result = await handler.getPersonaDetails('Sample Persona 2');
      expect(result.content[0].text).toContain('**Sample Persona 2** Details');
    });

    it('should return error response when persona not found', async () => {
      mockPersonaManager.find.mockResolvedValue(null);
      const result = await handler.getPersonaDetails('non-existent');
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toContain('Persona Not Found');
      expect(result.content[0].text).toContain('non-existent');
    });
  });

  describe('reloadPersonas', () => {
    it('should reload personas and return count', async () => {
      const result = await handler.reloadPersonas();
      expect(mockPersonaManager.reload).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Reloaded 2 personas');
    });
  });

  describe('createPersona', () => {
    it('should create a new persona successfully', async () => {
      const newPersona = {
        filename: 'new-persona.md',
        filePath: '/tmp/test/new-persona.md',
        unique_id: 'new-1',
        metadata: {
          name: 'New Persona',
          description: 'New description',
          author: 'test-user',
          unique_id: 'new-1',
        },
        content: 'New instructions',
      };
      // v2: unified create() API
      mockPersonaManager.create.mockResolvedValue(newPersona);
      mockPersonaManager.list.mockResolvedValue([newPersona]);

      const result = await handler.createPersona('New Persona', 'New description', 'New instructions', 'test,keywords');

      expect(mockInitService.ensureInitialized).toHaveBeenCalled();
      // v2: create() takes object parameter
      expect(mockPersonaManager.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'New Persona',
        description: 'New description',
        instructions: 'New instructions',
        triggers: ['test', 'keywords']
      }));
      expect(result.content[0].text).toContain('Persona Created Successfully');
      expect(result.content[0].text).toContain('New Persona');
    });

    it('should return error when required fields are missing', async () => {
      const result = await handler.createPersona('', '', '');
      expect(result.content[0].text).toContain('Missing Required Fields');
      expect(mockPersonaManager.create).not.toHaveBeenCalled();
    });

    it('should handle creation errors gracefully', async () => {
      mockPersonaManager.create.mockRejectedValue(new Error('Creation failed'));
      const result = await handler.createPersona('Test', 'Description', 'Instructions');
      expect(result.content[0].text).toContain('Error Creating Persona');
    });
  });

  describe('exportPersona', () => {
    it('should export a persona to base64', async () => {
      const persona = {
        filename: 'sample-persona-1.md',
        metadata: { name: 'Sample Persona 1' },
        content: 'test content'
      };
      mockPersonaManager.find.mockResolvedValue(persona);

      const exportData = JSON.stringify({ test: 'data' });
      mockPersonaManager.exportElement.mockResolvedValue(exportData);
      mockPersonaExporter.toBase64.mockReturnValue('base64data');
      mockPersonaExporter.formatExportResult.mockReturnValue('Export successful');

      const result = await handler.exportPersona('sample-persona-1');

      expect(mockPersonaManager.exportElement).toHaveBeenCalled();
      expect(mockPersonaExporter.toBase64).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Export successful');
    });

    it('should handle export errors', async () => {
      mockPersonaManager.find.mockResolvedValue(null);
      const result = await handler.exportPersona('non-existent');
      expect(result.content[0].text).toContain('Persona not found');
    });
  });

  describe('importPersona', () => {
    it('should import a persona successfully', async () => {
      const importedPersona = {
        filename: 'imported.md',
        metadata: { name: 'Imported Persona' },
      };
      mockPersonaManager.importPersona.mockResolvedValue({
        success: true,
        persona: importedPersona,
        message: 'Import successful'
      });
      mockPersonaManager.list.mockResolvedValue([importedPersona]);

      const result = await handler.importPersona('source.json', false);

      expect(mockPersonaManager.importPersona).toHaveBeenCalledWith('source.json', false);
      expect(result.content[0].text).toContain('imported successfully');
    });

    it('should handle import when PersonaImporter is undefined', async () => {
      const handlerWithoutImporter = new PersonaHandler(
        mockPersonaManager,
        mockPersonaExporter,
        undefined, // No importer
        mockInitService,
        mockPersonaIndicatorService,
        {
          get: () => activePersonaState.current,
          set: (value: string | null) => { activePersonaState.current = value; }
        }
      );

      const result = await handlerWithoutImporter.importPersona('source.json');
      expect(result.content[0].text).toContain('Import functionality not available');
    });

    it('should handle import errors', async () => {
      mockPersonaManager.importPersona.mockResolvedValue({
        success: false,
        message: 'Import failed: invalid format'
      });

      const result = await handler.importPersona('bad-source.json');
      expect(result.content[0].text).toContain('Import failed');
    });
  });

  describe('DI Integration', () => {
    it('should call InitializationService.ensureInitialized on createPersona', async () => {
      // v2: unified create() API
      mockPersonaManager.create.mockResolvedValue({
        filename: 'test.md',
        filePath: '/tmp/test/test.md',
        unique_id: 'test-1',
        metadata: { name: 'Test', unique_id: 'test-1' },
        content: 'Test'
      });

      await handler.createPersona('Test', 'Desc', 'Instructions');
      expect(mockInitService.ensureInitialized).toHaveBeenCalled();
    });

    it('should use PersonaIndicatorService for all response formatting', async () => {
      await handler.listPersonas();
      expect(mockPersonaIndicatorService.getPersonaIndicator).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle validatePersona with validation errors', async () => {
      const persona = {
        filename: 'invalid-persona.md',
        metadata: { name: 'Invalid Persona' },
        content: 'test'
      };
      mockPersonaManager.find.mockResolvedValue(persona);
      mockPersonaManager.validatePersona.mockReturnValue({
        success: false,
        message: 'Validation failed',
        report: {
          valid: false,
          errors: [
            { field: 'name', message: 'Missing name' },
            { field: 'content', message: 'Content too short' }
          ],
          warnings: [
            { field: 'triggers', message: 'No triggers defined' }
          ]
        }
      });

      const result = await handler.validatePersona('invalid-persona');
      expect(result.content[0].text).toContain('Issues Found (2)');
      expect(result.content[0].text).toContain('Missing name');
      expect(result.content[0].text).toContain('Warnings (1)');
      expect(result.content[0].text).toContain('No triggers defined');
    });

    it('should handle deletion failure', async () => {
      const persona = {
        filename: 'default-persona.md',
        metadata: { name: 'Default Persona' },
        content: 'test'
      };
      mockPersonaManager.find.mockResolvedValue(persona);
      mockPersonaManager.deletePersona.mockResolvedValue({
        success: false,
        message: 'Cannot delete default persona'
      });

      const result = await handler.deletePersona('default-persona');
      expect(result.content[0].text).toContain('Cannot delete default persona');
    });
  });
});
