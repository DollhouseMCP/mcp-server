#!/usr/bin/env node
import { PersonaExporter } from './src/persona/export-import/PersonaExporter.js';
import { PersonaImporter } from './src/persona/export-import/PersonaImporter.js';
import { PersonaSharer } from './src/persona/export-import/PersonaSharer.js';
import { Persona } from './src/types/persona.js';
import { GitHubClient } from './src/marketplace/GitHubClient.js';
import { logger } from './src/utils/logger.js';

// Test data
const testPersona: Persona = {
  metadata: {
    name: "Test Persona",
    description: "A test persona for export/import functionality",
    version: "1.0",
    author: "test-user",
    category: "test",
    unique_id: "test-persona_20250711-180000_test-user",
    created_date: new Date().toISOString()
  },
  content: "You are a helpful test assistant.",
  filename: "test-persona.md",
  unique_id: "test-persona_20250711-180000_test-user"
};

async function testExportImport() {
  logger.info("Starting export/import tests...");
  
  // Test 1: Export single persona
  logger.info("\n=== Test 1: Export Single Persona ===");
  const exporter = new PersonaExporter("test-user");
  const exportResult = await exporter.exportPersona(testPersona);
  console.log("Export result:", JSON.stringify(exportResult, null, 2));
  
  // Test 2: Export to base64
  logger.info("\n=== Test 2: Export to Base64 ===");
  const base64Result = await exporter.toBase64(testPersona);
  console.log("Base64 result:", base64Result.substring(0, 50) + "...");
  
  // Test 3: Import from JSON
  logger.info("\n=== Test 3: Import from JSON ===");
  const importer = new PersonaImporter("/tmp/test-personas", "test-user");
  const importResult = await importer.importPersona(
    JSON.stringify(exportResult),
    new Map(),
    false
  );
  console.log("Import result:", importResult);
  
  // Test 4: Import from base64
  logger.info("\n=== Test 4: Import from Base64 ===");
  const base64ImportResult = await importer.importPersona(
    base64Result,
    new Map(),
    false
  );
  console.log("Base64 import result:", base64ImportResult);
  
  // Test 5: Share persona (requires GITHUB_TOKEN)
  if (process.env.GITHUB_TOKEN) {
    logger.info("\n=== Test 5: Share Persona ===");
    const githubClient = new GitHubClient();
    const sharer = new PersonaSharer(githubClient, "test-user");
    const shareResult = await sharer.sharePersona(testPersona, 7);
    console.log("Share result:", shareResult);
  } else {
    logger.info("\n=== Test 5: Share Persona (Skipped - No GITHUB_TOKEN) ===");
  }
  
  logger.info("\n✅ All tests completed!");
}

// Run tests
testExportImport().catch(error => {
  logger.error("Test failed:", error);
  process.exit(1);
});