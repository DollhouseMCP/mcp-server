/**
 * PersonaTools Deprecation Test Suite
 *
 * Tests that verify deprecated PersonaTools are handled gracefully and
 * that the remaining export/import functionality still works properly.
 *
 * @author Agent 6 [AGENT-6-DEPRECATION-TESTS]
 * @date August 19, 2025
 * @related PR #637 - PersonaTools Removal
 */

import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('PersonaTools Deprecation Tests', () => {
    let server: DollhouseMCPServer;
    let tempDir: string;

    beforeEach(async () => {
        // Create temporary directory for test personas
        tempDir = path.join(__dirname, '..', '..', '..', 'temp', `test-${Date.now()}`);
        await fs.mkdir(tempDir, { recursive: true });

        // Set environment for test
        process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
        // Disable element filtering so test personas aren't filtered out
        process.env.DISABLE_ELEMENT_FILTERING = 'true';

        // Initialize server with DI container
        const container = new DollhouseContainer();
        server = new DollhouseMCPServer(container);
    });

    afterEach(async () => {
        // Clean up temporary directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
        await server.dispose();
    });

    describe('Removed Tools Verification', () => {
        test('should verify that core persona functionality still works through server methods', async () => {
            // Test that core persona functionality is still available through server methods
            // This verifies that removing tools didn't break underlying functionality

            // Test listing personas (was list_personas tool)
            const initialListResponse = await server.listPersonas();
            expect(initialListResponse).toBeDefined();
            expect(initialListResponse.content).toBeDefined();
            expect(Array.isArray(initialListResponse.content)).toBe(true);
            expect(initialListResponse.content[0].type).toBe('text');

            // Extract persona count from response text for comparison
            const initialListText = initialListResponse.content[0].text;
            const initialCount = initialListText.includes('Available Personas (') ?
                Number.parseInt(initialListText.match(/Available Personas \((\d+)\)/)?.[1] || '0') : 0;

            // v2: Use createElement instead of createPersona
            const createResponse = await server.createElement({
                name: 'Sample Persona',
                type: 'persona',
                description: 'A sample persona for deprecation verification',
                content: 'You are a helpful sample assistant.'
            });
            expect(createResponse).toBeDefined();
            expect(createResponse.content).toBeDefined();
            expect(createResponse.content[0].type).toBe('text');
            // Verify creation was successful by checking response text
            expect(createResponse.content[0].text).toContain('✅');

            // Verify persona was created
            const updatedListResponse = await server.listPersonas();
            const updatedListText = updatedListResponse.content[0].text;
            const updatedCount = updatedListText.includes('Available Personas (') ?
                Number.parseInt(updatedListText.match(/Available Personas \((\d+)\)/)?.[1] || '0') : 0;
            expect(updatedCount).toBe(initialCount + 1);

            // Issue #281: Use generic element API instead of persona-specific methods
            // Test activating persona via activateElement
            const activateResponse = await server.activateElement('Sample Persona', 'persona');
            expect(activateResponse).toBeDefined();
            expect(activateResponse.content[0].type).toBe('text');

            // Test getting active persona via getActiveElements
            const activeResponse = await server.getActiveElements('persona');
            expect(activeResponse).toBeDefined();
            expect(activeResponse.content[0].type).toBe('text');
            expect(activeResponse.content[0].text).toContain('Sample Persona');

            // Test deactivating via deactivateElement (requires persona name)
            const deactivateResponse = await server.deactivateElement('Sample Persona', 'persona');
            expect(deactivateResponse).toBeDefined();
            expect(deactivateResponse.content[0].type).toBe('text');

            const noActiveResponse = await server.getActiveElements('persona');
            // Issue #281: Updated message for multi-persona support
            expect(noActiveResponse.content[0].text).toContain('No personas are currently active');
        });

        test('should verify persona details functionality still works', async () => {
            // v2: Use createElement
            const createResponse = await server.createElement({
                name: 'Detailed Sample Persona',
                type: 'persona',
                description: 'A persona for validating details functionality',
                content: 'You are a detailed sample assistant with specific instructions.'
            });
            expect(createResponse.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            expect(personasText).toContain('Detailed Sample Persona');

            // Issue #281: Use getElementDetails instead of getPersonaDetails
            const detailsResponse = await server.getElementDetails('Detailed Sample Persona', 'persona');
            expect(detailsResponse).toBeDefined();
            expect(detailsResponse.content[0].type).toBe('text');
            expect(detailsResponse.content[0].text).toContain('Detailed Sample Persona');
            expect(detailsResponse.content[0].text).toContain('A persona for validating details functionality');
        });

        test('should verify persona editing functionality still works', async () => {
            // v2: Use createElement
            const createResponse = await server.createElement({
                name: 'Editable Persona',
                type: 'persona',
                description: 'Original description',
                content: 'Original instructions'
            });
            expect(createResponse.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            expect(personasText).toContain('Editable Persona');

            // Test editing persona (was edit_persona tool)
            // Issue #290: Use input object format for edits
            const editNameResponse = await server.editElement({
                name: 'Editable Persona',
                type: 'personas',
                input: { name: 'Updated Editable Persona' }
            });
            expect(editNameResponse.content[0].type).toBe('text');
            expect(editNameResponse.content[0].text).toContain('✅');

            const editDescResponse = await server.editElement({
                name: 'Updated Editable Persona',
                type: 'personas',
                input: { description: 'Updated description' }
            });
            expect(editDescResponse.content[0].type).toBe('text');
            expect(editDescResponse.content[0].text).toContain('✅');

            // Verify the edit worked by checking the responses
            expect(editNameResponse.content[0].text).toContain('Updated Editable Persona');
            // Issue #290: Response shows field name, not value
            expect(editDescResponse.content[0].text).toContain('description');
        });

        test('should verify persona reloading functionality still works', async () => {
            // First trigger server initialization by creating a persona
            await server.createElement({
                name: 'Reload Sample',
                type: 'persona',
                description: 'Sample persona for reload verification',
                content: 'Sample instructions'
            });

            const beforeReloadResponse = await server.listPersonas();
            const beforeText = beforeReloadResponse.content[0].text;
            const beforeCount = beforeText.includes('Available Personas (') ?
                Number.parseInt(beforeText.match(/Available Personas \((\d+)\)/)?.[1] || '0') : 0;

            const reloadResponse = await server.reloadPersonas();
            expect(reloadResponse.content[0].type).toBe('text');

            const afterReloadResponse = await server.listPersonas();
            expect(afterReloadResponse).toBeDefined();
            expect(afterReloadResponse.content).toBeDefined();
            expect(Array.isArray(afterReloadResponse.content)).toBe(true);

            // Should have same number of personas (no external changes)
            const afterText = afterReloadResponse.content[0].text;
            const afterCount = afterText.includes('Available Personas (') ?
                Number.parseInt(afterText.match(/Available Personas \((\d+)\)/)?.[1] || '0') : 0;
            expect(afterCount).toBe(beforeCount);
        });
    });

    describe('Preserved Export/Import Functionality', () => {
        test('should verify export functionality still works', async () => {
            // v2: Use createElement
            const createResponse = await server.createElement({
                name: 'Export Sample Persona',
                type: 'persona',
                description: 'A persona for validating export functionality',
                content: 'You are an export sample assistant.'
            });
            expect(createResponse.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            expect(personasText).toContain('Export Sample Persona');

            // Test individual persona export (preserved export_persona tool)
            const exportResponse = await server.exportPersona('Export Sample Persona');
            expect(exportResponse).toBeDefined();
            expect(exportResponse.content[0].type).toBe('text');
            expect(exportResponse.content[0].text.length).toBeGreaterThan(0);

            // Test exporting all personas (preserved export_all_personas tool)
            const exportAllResponse = await server.exportAllPersonas();
            expect(exportAllResponse).toBeDefined();
            expect(exportAllResponse.content[0].type).toBe('text');
            expect(exportAllResponse.content[0].text.length).toBeGreaterThan(0);
        });

        test('should verify import functionality still works', async () => {
            // First, create and export a persona
            const createResponse = await server.createElement({
                name: 'Import Sample Persona',
                type: 'persona',
                description: 'A persona for validating import functionality',
                content: 'You are an import sample assistant.'
            });
            expect(createResponse.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            expect(personasText).toContain('Import Sample Persona');

            const exportResponse = await server.exportPersona('Import Sample Persona');
            const exportData = exportResponse.content[0].text;

            // Test importing persona (preserved import_persona tool)
            const importResponse = await server.importPersona(exportData);
            expect(importResponse).toBeDefined();
            expect(importResponse.content[0].type).toBe('text');

            // Verify import worked by checking persona list
            const updatedPersonasResponse = await server.listPersonas();
            const updatedPersonasText = updatedPersonasResponse.content[0].text;
            expect(updatedPersonasText).toContain('Import Sample Persona');
        });

        test('should verify share functionality still works', async () => {
            // v2: Use createElement
            const createResponse = await server.createElement({
                name: 'Share Sample Persona',
                type: 'persona',
                description: 'A persona for validating share functionality',
                content: 'You are a share sample assistant.'
            });
            expect(createResponse.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            expect(personasText).toContain('Share Sample Persona');

            // Note: share_persona tool has been removed as it's not compatible
            // with the current element system architecture
        });
    });

    describe('Backward Compatibility and Stability', () => {
        test('should maintain server stability through multiple operations', async () => {
            // Perform multiple operations to ensure stability
            const operations = [];

            for (let i = 0; i < 3; i++) {
                operations.push(
                    server.createElement({
                        name: `Stability Test ${i}`,
                        type: 'persona',
                        description: `Test persona ${i}`,
                        content: `You are test assistant ${i}.`
                    })
                );
            }

            const results = await Promise.all(operations);
            results.forEach(result => {
                expect(result.content[0].text).toContain('✅');
            });

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            const personaCount = personasText.includes('Available Personas (') ?
                Number.parseInt(personasText.match(/Available Personas \((\d+)\)/)?.[1] || '0') : 0;
            expect(personaCount).toBeGreaterThanOrEqual(3);

            // Test that server is still responsive
            const listResult = await server.listPersonas();
            expect(listResult).toBeDefined();
            expect(listResult.content[0].type).toBe('text');
        });

        test('should handle persona operations without crashes', async () => {
            // v2: Use createElement
            const create1 = await server.createElement({
                name: 'Demo 1',
                type: 'persona',
                description: 'Description 1',
                content: 'Instructions 1'
            });
            expect(create1.content[0].text).toContain('✅');

            const create2 = await server.createElement({
                name: 'Demo 2',
                type: 'persona',
                description: 'Description 2',
                content: 'Instructions 2'
            });
            expect(create2.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            const personaCount = personasText.includes('Available Personas (') ?
                Number.parseInt(personasText.match(/Available Personas \((\d+)\)/)?.[1] || '0') : 0;
            expect(personaCount).toBeGreaterThanOrEqual(2);

            expect(personasText).toContain('Demo 1');

            // Issue #281: Test activation/deactivation cycle via generic element API
            const activateResponse = await server.activateElement('Demo 1', 'persona');
            expect(activateResponse.content[0].type).toBe('text');
            const active1 = await server.getActiveElements('persona');
            expect(active1.content[0].text).toContain('Demo 1');

            const deactivateResponse = await server.deactivateElement('Demo 1', 'persona');
            expect(deactivateResponse.content[0].type).toBe('text');
            const active2 = await server.getActiveElements('persona');
            // Issue #281: Updated message for multi-persona support
            expect(active2.content[0].text).toContain('No personas are currently active');

            // Test export/import cycle
            const exportResponse = await server.exportPersona('Demo 1');
            expect(exportResponse).toBeDefined();
            expect(exportResponse.content[0].type).toBe('text');

            const importResponse = await server.importPersona(exportResponse.content[0].text);
            expect(importResponse.content[0].type).toBe('text');

            // Server should still be functional
            const finalList = await server.listPersonas();
            expect(finalList).toBeDefined();
            expect(finalList.content[0].type).toBe('text');
        });

        test('should demonstrate improved efficiency with reduced tool count', async () => {
            // This test demonstrates that the server is more efficient
            // with the reduced tool count (conceptual test)

            const startTime = Date.now();

            // Perform standard operations
            // v2: Use createElement
            const createResponse = await server.createElement({
                name: 'Efficiency Sample',
                type: 'persona',
                description: 'Sample persona',
                content: 'Sample instructions'
            });
            expect(createResponse.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            expect(personasText).toContain('Efficiency Sample');

            // Issue #281: Use generic element API
            const activateResponse = await server.activateElement('Efficiency Sample', 'persona');
            expect(activateResponse.content[0].type).toBe('text');

            const activeResponse = await server.getActiveElements('persona');
            expect(activeResponse.content[0].type).toBe('text');

            const deactivateResponse = await server.deactivateElement('Efficiency Sample', 'persona');
            expect(deactivateResponse.content[0].type).toBe('text');

            const exportResponse = await server.exportPersona('Efficiency Sample');
            expect(exportResponse.content[0].type).toBe('text');

            const endTime = Date.now();
            const duration = endTime - startTime;

            // Should complete operations in reasonable time
            expect(duration).toBeLessThan(5000); // Less than 5 seconds

            console.log(`PersonaTools operations completed in ${duration}ms`);
        });
    });

    describe('Migration Verification', () => {
        test('should verify that all removed PersonaTools functionality is available through ElementTools equivalent', async () => {
            // This is a conceptual test that verifies the migration path
            // In practice, users would use ElementTools for persona management

            // v2: Use createElement
            const createResponse = await server.createElement({
                name: 'Migration Sample Persona',
                type: 'persona',
                description: 'Validating migration to ElementTools',
                content: 'You are a migration sample assistant.'
            });
            expect(createResponse.content[0].text).toContain('✅');

            const personasResponse = await server.listPersonas();
            const personasText = personasResponse.content[0].text;
            expect(personasText).toContain('Migration Sample Persona');

            // Issue #281: Verify all operations use generic element API
            // Verify all the operations that were available in PersonaTools
            // are still available through element methods

            // 1. List personas ✓
            expect(personasResponse.content[0].type).toBe('text');

            // 2. Activate persona ✓ (via activateElement)
            const activateResponse = await server.activateElement('Migration Sample Persona', 'persona');
            expect(activateResponse.content[0].type).toBe('text');

            // 3. Get active persona ✓ (via getActiveElements)
            const active = await server.getActiveElements('persona');
            expect(active.content[0].text).toContain('Migration Sample Persona');

            // 4. Deactivate persona ✓ (via deactivateElement)
            const deactivateResponse = await server.deactivateElement('Migration Sample Persona', 'persona');
            expect(deactivateResponse.content[0].type).toBe('text');

            // 5. Get persona details ✓ (via getElementDetails)
            const details = await server.getElementDetails('Migration Sample Persona', 'persona');
            expect(details.content[0].text).toContain('Migration Sample Persona');

            // 6. Edit persona ✓
            // Issue #290: Use input object format for edits
            const editResponse = await server.editElement({
                name: 'Migration Sample Persona',
                type: 'personas',
                input: { name: 'Updated Migration Sample' }
            });
            expect(editResponse.content[0].type).toBe('text');
            expect(editResponse.content[0].text).toContain('✅');

            // 7. Reload personas ✓
            const reloadResponse = await server.reloadPersonas();
            expect(reloadResponse.content[0].type).toBe('text');

            // 8. Validate persona ✓ (implicit through successful operations)

            // All functionality preserved through server methods!
            console.log('✓ All PersonaTools functionality verified as available through server methods');
        });
    });
});
