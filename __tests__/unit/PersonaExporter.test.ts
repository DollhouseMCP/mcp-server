import { PersonaExporter } from '../../src/persona/export-import/PersonaExporter.js';
import { Persona } from '../../src/types/persona.js';

describe('PersonaExporter', () => {
  let exporter: PersonaExporter;
  
  const mockPersona: Persona = {
    metadata: {
      name: "Test Persona",
      description: "Test description",
      version: "1.0",
      author: "test-author",
      category: "test",
      unique_id: "test-persona_20250711-120000_test-author",
      created_date: "2025-07-11T12:00:00.000Z"
    },
    content: "You are a test assistant.",
    filename: "test-persona.md",
    unique_id: "test-persona_20250711-120000_test-author"
  };
  
  beforeEach(() => {
    exporter = new PersonaExporter("test-user");
  });
  
  describe('exportPersona', () => {
    it('should export a persona with all metadata', async () => {
      const result = await exporter.exportPersona(mockPersona);
      
      expect(result).toHaveProperty('metadata');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('filename');
      expect(result).toHaveProperty('exportedAt');
      expect(result).toHaveProperty('exportedBy');
      
      expect(result.metadata).toEqual(mockPersona.metadata);
      expect(result.content).toBe(mockPersona.content);
      expect(result.filename).toBe(mockPersona.filename);
      expect(result.exportedBy).toBe('test-user');
    });
    
    it('should include timestamp in exportedAt', async () => {
      const before = new Date().toISOString();
      const result = await exporter.exportPersona(mockPersona);
      const after = new Date().toISOString();
      
      expect(new Date(result.exportedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(new Date(result.exportedAt).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
    });
  });
  
  describe('toBase64', () => {
    it('should encode persona to base64', async () => {
      const base64 = await exporter.toBase64(mockPersona);
      
      expect(typeof base64).toBe('string');
      expect(base64.length).toBeGreaterThan(0);
      
      // Verify it's valid base64
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      
      expect(parsed.metadata.name).toBe(mockPersona.metadata.name);
      expect(parsed.content).toBe(mockPersona.content);
    });
  });
  
  describe('exportBundle', () => {
    it('should export multiple personas as a bundle', () => {
      const personas = [
        mockPersona,
        {
          ...mockPersona,
          metadata: {
            ...mockPersona.metadata,
            name: "Test Persona 2",
            unique_id: "test-persona-2_20250711-120000_test-author"
          },
          unique_id: "test-persona-2_20250711-120000_test-author"
        }
      ];
      
      const bundle = exporter.exportBundle(personas);
      
      expect(bundle).toHaveProperty('version');
      expect(bundle).toHaveProperty('exportedAt');
      expect(bundle).toHaveProperty('exportedBy');
      expect(bundle).toHaveProperty('personas');
      expect(bundle).toHaveProperty('personaCount');
      
      expect(bundle.version).toBe('1.0.0');
      expect(bundle.exportedBy).toBe('test-user');
      expect(bundle.personaCount).toBe(2);
      expect(bundle.personas).toHaveLength(2);
      
      expect(bundle.personas[0].metadata.name).toBe("Test Persona");
      expect(bundle.personas[1].metadata.name).toBe("Test Persona 2");
    });
    
    it('should handle empty persona array', () => {
      const bundle = exporter.exportBundle([]);
      
      expect(bundle.personaCount).toBe(0);
      expect(bundle.personas).toHaveLength(0);
    });
  });
  
  
  describe('Edge cases', () => {
    it('should throw error for oversized persona', () => {
      const largePersona: Persona = {
        ...mockPersona,
        content: 'x'.repeat(200 * 1024) // 200KB of content
      };
      
      expect(() => exporter.exportPersona(largePersona)).toThrow('Persona too large');
    });
    
    it('should handle persona without optional fields', async () => {
      const minimalPersona: Persona = {
        metadata: {
          name: "Minimal",
          description: "Minimal persona",
          unique_id: "minimal_20250711-120000_test"
        },
        content: "Minimal content",
        filename: "minimal.md",
        unique_id: "minimal_20250711-120000_test"
      };
      
      const result = await exporter.exportPersona(minimalPersona);
      
      expect(result.metadata.name).toBe("Minimal");
      expect(result.metadata.version).toBeUndefined();
      expect(result.metadata.author).toBeUndefined();
    });
    
    it('should handle exporter without currentUser', async () => {
      const anonymousExporter = new PersonaExporter(null);
      const result = await anonymousExporter.exportPersona(mockPersona);
      
      expect(result.exportedBy).toBeUndefined();
    });
  });
});