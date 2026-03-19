/**
 * Utilities module exports
 */

export * from './git.js';
export * from './filesystem.js';
export * from './version.js';
export * from './SecureDownloader.js';
export * from './RateLimiter.js';
export * from './deepMerge.js';
export { EvictingQueue } from './EvictingQueue.js';

const ELEMENT_TYPE_ICONS: Record<string, string> = {
  personas: '🎭',
  skills: '🎯',
  templates: '📄',
  agents: '🤖',
  memories: '🧠',
  ensembles: '🎼',
};

const SOURCE_ICONS: Record<string, string> = {
  local: '💻',
  github: '🐙',
  collection: '🌐',
};

export function getElementIcon(elementType: string): string {
  return ELEMENT_TYPE_ICONS[elementType] ?? '📁';
}

export function getSourceIcon(source: string): string {
  return SOURCE_ICONS[source] ?? '📁';
}
