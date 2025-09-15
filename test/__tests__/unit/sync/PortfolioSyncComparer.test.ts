/**
 * Unit tests for PortfolioSyncComparer
 * Tests sync comparison logic for portfolio synchronization
 */

import { jest } from '@jest/globals';
import { PortfolioSyncComparer } from '../../../../src/sync/PortfolioSyncComparer.js';
import { PortfolioElementData } from '../../../../src/sync/types.js';
import { ElementType } from '../../../../src/portfolio/types.js';

describe('PortfolioSyncComparer', () => {
  let comparer: PortfolioSyncComparer;

  beforeEach(() => {
    comparer = new PortfolioSyncComparer();
  });

  describe('compareElements', () => {
    const createLocalElement = (name: string, sha?: string): PortfolioElementData => ({
      name,
      type: ElementType.PERSONA,
      path: `personas/${name}.md`,
      sha,
      lastModified: new Date('2025-09-01').toISOString()
    });

    const createRemoteElement = (name: string, sha?: string): PortfolioElementData => ({
      name,
      type: ElementType.PERSONA,
      path: `personas/${name}.md`,
      sha: sha || `sha-${name}`,
      lastModified: new Date('2025-09-10').toISOString()
    });

    describe('additive mode', () => {
      it('should only add missing elements', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('existing', 'sha-existing')
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA, [
          createRemoteElement('existing', 'sha-existing'),
          createRemoteElement('new', 'sha-new')
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'additive');

        expect(result.toAdd).toHaveLength(1);
        expect(result.toAdd[0].name).toBe('new');
        expect(result.toUpdate).toHaveLength(0);
        expect(result.toDelete).toHaveLength(0);
        expect(result.toSkip).toHaveLength(1);
      });

      it('should not update existing elements even if different', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('existing', 'sha-old')
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA, [
          createRemoteElement('existing', 'sha-new')
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'additive');

        expect(result.toAdd).toHaveLength(0);
        expect(result.toUpdate).toHaveLength(0);
        expect(result.toDelete).toHaveLength(0);
        expect(result.toSkip).toHaveLength(1);
      });
    });

    describe('mirror mode', () => {
      it('should add, update, and delete to match remote exactly', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('keep', 'sha-keep'),
          createLocalElement('update', 'sha-old'),
          createLocalElement('delete', 'sha-delete')
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA, [
          createRemoteElement('keep', 'sha-keep'),
          createRemoteElement('update', 'sha-new'),
          createRemoteElement('add', 'sha-add')
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'mirror');

        expect(result.toAdd).toHaveLength(1);
        expect(result.toAdd[0].name).toBe('add');
        expect(result.toUpdate).toHaveLength(1);
        expect(result.toUpdate[0].name).toBe('update');
        expect(result.toDelete).toHaveLength(1);
        expect(result.toDelete[0].name).toBe('delete');
        expect(result.toSkip).toHaveLength(1);
        expect(result.toSkip[0].name).toBe('keep');
      });

      it('should handle empty remote by deleting all local', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('delete1'),
          createLocalElement('delete2')
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        // Empty remote - no elements

        const result = comparer.compareElements(remoteElements, localElements, 'mirror');

        expect(result.toAdd).toHaveLength(0);
        expect(result.toUpdate).toHaveLength(0);
        expect(result.toDelete).toHaveLength(2);
        expect(result.toSkip).toHaveLength(0);
      });
    });

    describe('backup mode', () => {
      it('should overwrite all local with remote', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('existing', 'sha-old'),
          createLocalElement('local-only', 'sha-local')
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA, [
          createRemoteElement('existing', 'sha-new'),
          createRemoteElement('new', 'sha-new')
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'backup');

        expect(result.toAdd).toHaveLength(1);
        expect(result.toAdd[0].name).toBe('new');
        expect(result.toUpdate).toHaveLength(1);
        expect(result.toUpdate[0].name).toBe('existing');
        expect(result.toDelete).toHaveLength(0); // Backup mode doesn't delete local-only files
        expect(result.toSkip).toHaveLength(0);
      });

      it('should update even if SHA matches (forced backup)', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('existing', 'sha-same')
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA, [
          createRemoteElement('existing', 'sha-same')
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'backup');

        expect(result.toAdd).toHaveLength(0);
        expect(result.toUpdate).toHaveLength(1);
        expect(result.toUpdate[0].name).toBe('existing');
        expect(result.toDelete).toHaveLength(0);
        expect(result.toSkip).toHaveLength(0);
      });
    });

    describe('edge cases', () => {
      it('should handle empty local and remote', () => {
        const localElements = new Map<ElementType, any[]>();
        const remoteElements = new Map<ElementType, any[]>();
        
        const result = comparer.compareElements(remoteElements, localElements, 'mirror');

        expect(result.toAdd).toHaveLength(0);
        expect(result.toUpdate).toHaveLength(0);
        expect(result.toDelete).toHaveLength(0);
        expect(result.toSkip).toHaveLength(0);
      });

      it('should handle elements without SHA', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('no-sha', undefined)
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA, [
          createRemoteElement('no-sha', undefined)
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'mirror');

        // Without SHA, should compare by modified date
        expect(result.toUpdate).toHaveLength(1);
        expect(result.toUpdate[0].name).toBe('no-sha');
      });

      it('should handle different element types correctly', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.SKILL, [
          { ...createLocalElement('test'), type: ElementType.SKILL }
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.SKILL, [
          { ...createRemoteElement('test'), type: ElementType.SKILL }
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'additive');

        expect(result.toSkip).toHaveLength(1);
        expect(result.toSkip[0].type).toBe(ElementType.SKILL);
      });

      it('should normalize names for comparison', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, [
          createLocalElement('Test-Element', 'sha-old')
        ]);
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA, [
          { ...createRemoteElement('test-element', 'sha-new'), name: 'test-element' }
        ]);

        const result = comparer.compareElements(remoteElements, localElements, 'mirror');

        // Should recognize as same element and update
        expect(result.toUpdate).toHaveLength(1);
        expect(result.toAdd).toHaveLength(0);
        expect(result.toDelete).toHaveLength(0);
      });
    });

    describe('performance', () => {
      it('should handle large element lists efficiently', () => {
        const localElements = new Map<ElementType, any[]>();
        localElements.set(ElementType.PERSONA, 
          Array.from({ length: 1000 }, (_, i) => 
            createLocalElement(`element-${i}`, `sha-${i}`)
          )
        );
        
        const remoteElements = new Map<ElementType, any[]>();
        remoteElements.set(ElementType.PERSONA,
          Array.from({ length: 1000 }, (_, i) => 
            createRemoteElement(`element-${i}`, i % 2 === 0 ? `sha-${i}` : `sha-new-${i}`)
          )
        );

        const startTime = Date.now();
        const result = comparer.compareElements(remoteElements, localElements, 'mirror');
        const endTime = Date.now();

        expect(endTime - startTime).toBeLessThan(100); // Should complete in under 100ms
        expect(result.toUpdate).toHaveLength(500); // Half should need updates
        expect(result.toSkip).toHaveLength(500); // Half should be skipped
      });
    });
  });
});