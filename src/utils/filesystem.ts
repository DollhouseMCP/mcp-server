/**
 * Filesystem and string manipulation utilities
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ADJECTIVES, ANIMALS } from '../config/constants.js';

/**
 * Generate an anonymous ID for users without identity
 */
export function generateAnonymousId(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const random = Math.random().toString(36).substring(2, 6);
  return `anon-${adjective}-${animal}-${random}`;
}

/**
 * Generate a unique ID for personas
 */
export function generateUniqueId(personaName: string, author?: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const whatItIs = personaName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const whoMadeIt = author || generateAnonymousId();
  
  return `${whatItIs}_${dateStr}-${timeStr}_${whoMadeIt}`;
}

/**
 * Convert text to URL-safe slug
 */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Ensure a directory exists, create if it doesn't
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
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
 * Get file size in bytes
 */
export async function getFileSize(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.size;
}

/**
 * Create a backup of a directory
 */
export async function createBackup(sourcePath: string, backupPath: string): Promise<void> {
  // Ensure backup directory exists
  const backupDir = path.dirname(backupPath);
  await ensureDirectory(backupDir);
  
  // Copy directory recursively
  await fs.cp(sourcePath, backupPath, { recursive: true });
}