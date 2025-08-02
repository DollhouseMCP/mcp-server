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
// Pre-compiled regex for better performance (avoids creating regex on each character)
const ALPHANUMERIC_REGEX = /[a-z0-9]/;

export function generateUniqueId(personaName: string, author?: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  // SECURITY FIX: Prevent ReDoS by using a single-pass approach
  // Previously: Multiple replace() operations with unbounded quantifiers could cause exponential backtracking
  // Now: Single-pass transformation with built-in length limit
  const normalized = personaName.toLowerCase();
  const sanitizedName = normalized
    .split('')
    .map(char => ALPHANUMERIC_REGEX.test(char) ? char : '-')
    .join('')
    .substring(0, 100) // Limit after transformation to preserve structure
    .replace(/^-+|-+$/g, '') // Only trim leading/trailing hyphens
    .replace(/-{2,}/g, '-'); // Collapse multiple hyphens
  const whoMadeIt = author || generateAnonymousId();
  
  return `${sanitizedName}_${dateStr}-${timeStr}_${whoMadeIt}`;
}

/**
 * Convert text to URL-safe slug
 */
export function slugify(text: string): string {
  // SECURITY FIX: Prevent ReDoS by using a single-pass approach
  // Previously: Multiple replace() operations with unbounded quantifiers could cause exponential backtracking
  // Now: Single-pass transformation with built-in length limit
  const normalized = text.toLowerCase();
  const transformed = normalized
    .split('')
    .map(char => ALPHANUMERIC_REGEX.test(char) ? char : '-')
    .join('');
  
  // SECURITY FIX: Avoid polynomial regex by using separate operations
  // Trim leading hyphens
  let start = 0;
  while (start < transformed.length && transformed[start] === '-') {
    start++;
  }
  
  // Trim trailing hyphens
  let end = transformed.length - 1;
  while (end >= start && transformed[end] === '-') {
    end--;
  }
  
  // Extract the trimmed portion and collapse multiple hyphens
  const trimmed = transformed.slice(start, end + 1);
  return trimmed.replace(/-{2,}/g, '-'); // This is safe as it's linear
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