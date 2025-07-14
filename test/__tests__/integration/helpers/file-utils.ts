/**
 * File system utilities for integration tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { Persona } from '../../../../src/types/persona.js';
import { createPersonaFileContent } from './test-fixtures.js';

/**
 * Create a test persona file
 */
export async function createTestPersonaFile(
  personasDir: string,
  persona: Persona
): Promise<string> {
  const filePath = path.join(personasDir, persona.filename);
  const content = createPersonaFileContent(persona);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Create multiple test persona files
 */
export async function createTestPersonaFiles(
  personasDir: string,
  personas: Persona[]
): Promise<string[]> {
  return Promise.all(
    personas.map(persona => createTestPersonaFile(personasDir, persona))
  );
}

/**
 * Clean a directory
 */
export async function cleanDirectory(dir: string): Promise<void> {
  try {
    const files = await fs.readdir(dir);
    await Promise.all(
      files.map(file => fs.unlink(path.join(dir, file)))
    );
  } catch (error) {
    // Directory might not exist or be empty
  }
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a persona file and parse it
 */
export async function readPersonaFile(filePath: string): Promise<any> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = matter(content);
  
  return {
    metadata: parsed.data,
    content: parsed.content.trim()
  };
}

/**
 * Wait for a file to exist (useful for async operations)
 */
export async function waitForFile(
  filePath: string,
  timeout: number = 5000
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await fileExists(filePath)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  throw new Error(`File ${filePath} did not appear within ${timeout}ms`);
}

/**
 * Create a temporary directory for a test
 */
export async function createTempDir(prefix: string): Promise<string> {
  const baseDir = process.env.TEST_BASE_DIR;
  if (!baseDir) {
    throw new Error('TEST_BASE_DIR environment variable is not set. Ensure the test setup has run properly.');
  }
  
  const tempDir = path.join(baseDir, `${prefix}-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}