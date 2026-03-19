#!/usr/bin/env node
/**
 * Performance benchmark for PersonaManager incremental reload
 *
 * Tests the performance improvement of incremental reload vs full reload
 *
 * Usage: npx tsx scripts/benchmark-persona-reload.ts [numFiles]
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PersonaManager } from '../src/persona/PersonaManager.js';
import { PortfolioManager, ElementType } from '../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../src/security/fileLockManager.js';
import { FileOperationsService } from '../src/services/FileOperationsService.js';
import { PersonaImporter } from '../src/persona/export-import/PersonaImporter.js';
import { StateChangeNotifier } from '../src/services/StateChangeNotifier.js';
import { DEFAULT_INDICATOR_CONFIG, IndicatorConfig } from '../src/config/indicator-config.js';
import { ValidationRegistry } from '../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../src/services/TriggerValidationService.js';
import { MetadataService } from '../src/services/MetadataService.js';

const NUM_FILES = parseInt(process.argv[2]) || 100;
const TEST_DIR = path.join(process.cwd(), 'test-tmp', `persona-benchmark-${Date.now()}`);

const indicatorConfig: IndicatorConfig = {
  ...DEFAULT_INDICATOR_CONFIG,
  enabled: true,
};

async function createPersonaFile(dir: string, filename: string): Promise<void> {
  const content = `---
name: Test Persona ${filename}
description: Performance test persona
unique_id: test-${filename}
author: benchmark
version: "1.0"
category: general
age_rating: all
price: free
license: CC-BY-SA-4.0
---

# Test Persona ${filename}

This is a test persona for performance benchmarking.`;

  await fs.writeFile(path.join(dir, filename), content, 'utf-8');
}

async function modifyPersonaFile(dir: string, filename: string): Promise<void> {
  const filePath = path.join(dir, filename);
  const content = await fs.readFile(filePath, 'utf-8');
  const modified = content.replace('This is a test persona', 'This is a MODIFIED test persona');
  await fs.writeFile(filePath, modified, 'utf-8');
}

async function waitForFileSystemSync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 100));
}

async function main() {
  console.log('='.repeat(70));
  console.log('PersonaManager Incremental Reload Performance Benchmark');
  console.log('='.repeat(70));
  console.log(`\nTesting with ${NUM_FILES} persona files\n`);

  // Setup - create dependencies
  await fs.mkdir(TEST_DIR, { recursive: true });

  const fileLockManager = new FileLockManager();
  const fileOperations = new FileOperationsService(fileLockManager);
  const portfolioManager = new PortfolioManager(fileOperations, { baseDir: TEST_DIR });
  await portfolioManager.initialize();

  const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
  const personaImporter = new PersonaImporter(personasDir, null, fileLockManager, fileOperations);
  const notifier = new StateChangeNotifier();
  const metadataService = new MetadataService();
  const validationService = new ValidationService();
  const triggerValidationService = new TriggerValidationService();
  const validationRegistry = new ValidationRegistry(validationService, triggerValidationService, metadataService);

  const personaManager = new PersonaManager(
    portfolioManager,
    indicatorConfig,
    fileLockManager,
    fileOperations,
    validationRegistry,
    metadataService,
    personaImporter,
    notifier
  );

  try {
    // Step 1: Create all files
    console.log(`Creating ${NUM_FILES} persona files...`);
    const createStart = performance.now();
    for (let i = 0; i < NUM_FILES; i++) {
      await createPersonaFile(personasDir, `persona${i}.md`);
    }
    const createTime = performance.now() - createStart;
    console.log(`  ✓ Created ${NUM_FILES} files in ${createTime.toFixed(2)}ms\n`);

    // Step 2: Initial load (always full)
    console.log('Initial Load (Full Reload):');
    const initStart = performance.now();
    await personaManager.initialize();
    const initTime = performance.now() - initStart;
    console.log(`  ✓ Loaded ${NUM_FILES} files in ${initTime.toFixed(2)}ms\n`);

    // Step 3: Reload with NO changes (should be instant)
    console.log('Reload with NO changes:');
    const noChangeStart = performance.now();
    await personaManager.reload();
    const noChangeTime = performance.now() - noChangeStart;
    console.log(`  ✓ Completed in ${noChangeTime.toFixed(2)}ms`);
    console.log(`  📊 Speedup vs initial: ${(initTime / noChangeTime).toFixed(1)}x faster\n`);

    // Step 4: Modify 1 file and reload (incremental)
    await waitForFileSystemSync();
    console.log('Reload with 1 changed file (1% change rate):');
    await modifyPersonaFile(personasDir, 'persona50.md');
    const oneChangeStart = performance.now();
    await personaManager.reload();
    const oneChangeTime = performance.now() - oneChangeStart;
    console.log(`  ✓ Completed in ${oneChangeTime.toFixed(2)}ms`);
    console.log(`  📊 Speedup vs initial: ${(initTime / oneChangeTime).toFixed(1)}x faster\n`);

    // Step 5: Modify 10% of files (incremental)
    await waitForFileSystemSync();
    const tenPercent = Math.floor(NUM_FILES * 0.1);
    console.log(`Reload with ${tenPercent} changed files (10% change rate):`);
    for (let i = 0; i < tenPercent; i++) {
      await modifyPersonaFile(personasDir, `persona${i}.md`);
    }
    const tenPercentStart = performance.now();
    await personaManager.reload();
    const tenPercentTime = performance.now() - tenPercentStart;
    console.log(`  ✓ Completed in ${tenPercentTime.toFixed(2)}ms`);
    console.log(`  📊 Speedup vs initial: ${(initTime / tenPercentTime).toFixed(1)}x faster\n`);

    // Step 6: Modify 50% of files (may trigger full reload depending on threshold)
    await waitForFileSystemSync();
    const fiftyPercent = Math.floor(NUM_FILES * 0.5);
    console.log(`Reload with ${fiftyPercent} changed files (50% change rate):`);
    for (let i = 0; i < fiftyPercent; i++) {
      await modifyPersonaFile(personasDir, `persona${i}.md`);
    }
    const fiftyPercentStart = performance.now();
    await personaManager.reload();
    const fiftyPercentTime = performance.now() - fiftyPercentStart;
    console.log(`  ✓ Completed in ${fiftyPercentTime.toFixed(2)}ms`);
    console.log(`  📊 Speedup vs initial: ${(initTime / fiftyPercentTime).toFixed(1)}x faster\n`);

    // Summary
    console.log('='.repeat(70));
    console.log('Summary:');
    console.log('='.repeat(70));
    console.log(`Portfolio Size: ${NUM_FILES} files`);
    console.log(`\nReload Times:`);
    console.log(`  Initial Load (full):     ${initTime.toFixed(2)}ms`);
    console.log(`  No Changes (cached):     ${noChangeTime.toFixed(2)}ms  (${(initTime / noChangeTime).toFixed(1)}x faster)`);
    console.log(`  1 File Changed:          ${oneChangeTime.toFixed(2)}ms  (${(initTime / oneChangeTime).toFixed(1)}x faster)`);
    console.log(`  10% Changed:             ${tenPercentTime.toFixed(2)}ms  (${(initTime / tenPercentTime).toFixed(1)}x faster)`);
    console.log(`  50% Changed:             ${fiftyPercentTime.toFixed(2)}ms  (${(initTime / fiftyPercentTime).toFixed(1)}x faster)`);

    console.log(`\nPerformance Targets:`);
    const noChangeTarget = noChangeTime < 10;
    const oneChangeTarget = oneChangeTime < 50;
    console.log(`  ${noChangeTarget ? '✓' : '✗'} No changes < 10ms: ${noChangeTarget ? 'PASS' : 'FAIL'} (${noChangeTime.toFixed(2)}ms)`);
    console.log(`  ${oneChangeTarget ? '✓' : '✗'} 1 change < 50ms:   ${oneChangeTarget ? 'PASS' : 'FAIL'} (${oneChangeTime.toFixed(2)}ms)`);

    console.log('\n' + '='.repeat(70));

  } finally {
    // Cleanup
    await personaManager.dispose();
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    console.log('Cleaned up test directory\n');
  }
}

main().catch(error => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
