/**
 * Install AI customization elements from collection
 * Supports all element types: personas, skills, templates, agents, memories, ensembles
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { GitHubClient } from './GitHubClient.js';
import { IElementMetadata } from '../types/elements/IElement.js';
import { validatePath, validateFilename, validateContentSize } from '../security/InputValidator.js';
import { SECURITY_LIMITS } from '../security/constants.js';
import { ContentValidator } from '../security/contentValidator.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { SecurityError } from '../errors/SecurityError.js';
import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';

export class ElementInstaller {
  private githubClient: GitHubClient;
  private portfolioManager: PortfolioManager;
  private baseUrl = 'https://api.github.com/repos/DollhouseMCP/collection/contents';
  
  constructor(githubClient: GitHubClient) {
    this.githubClient = githubClient;
    this.portfolioManager = PortfolioManager.getInstance();
  }
  
  /**
   * Install AI customization element from the collection
   * Automatically detects element type from path structure
   */
  async installContent(inputPath: string): Promise<{ 
    success: boolean; 
    message: string;
    metadata?: IElementMetadata;
    elementType?: ElementType;
    filename?: string;
  }> {
    // Validate and sanitize the input path
    const sanitizedPath = validatePath(inputPath);
    
    // Detect element type from path structure
    // Expected format: library/[element-type]/[category]/[element].md
    const pathParts = sanitizedPath.split('/');
    if (pathParts.length < 3 || pathParts[0] !== 'library') {
      throw new Error('Invalid collection path format. Expected: library/[element-type]/[category]/[element].md');
    }
    
    const elementTypeStr = pathParts[1];
    const elementType = this.getElementTypeFromString(elementTypeStr);
    
    // Ensure the path ends with .md
    if (!sanitizedPath.endsWith('.md')) {
      throw new Error('Invalid file type. Only .md files are allowed.');
    }
    
    const url = `${this.baseUrl}/${sanitizedPath}`;
    const data = await this.githubClient.fetchFromGitHub(url);
    
    if (data.type !== 'file') {
      throw new Error('Path does not point to a file');
    }
    
    // Check file size before downloading
    if (data.size > SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES) {
      throw new Error(`File too large (${data.size} bytes, max ${SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES} bytes)`);
    }
    
    // Decode Base64 content
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    
    // Validate content size after decoding
    validateContentSize(content, SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES);
    
    // Sanitize content for security threats
    const sanitizedContent = ContentValidator.sanitizePersonaContent(content);
    
    // Use secure YAML parser
    let parsed;
    try {
      parsed = SecureYamlParser.safeMatter(sanitizedContent);
    } catch (error) {
      if (error instanceof SecurityError) {
        throw new Error(`Security threat in content: ${error.message}`);
      }
      throw error;
    }
    
    const metadata = parsed.data as IElementMetadata;
    
    // Additional metadata validation for injection attacks
    const metadataValidation = ContentValidator.validateMetadata(metadata);
    if (!metadataValidation.isValid) {
      throw new Error(`Security validation failed: ${metadataValidation.detectedPatterns?.join(', ')}`);
    }
    
    // Validate metadata
    if (!metadata.name || !metadata.description) {
      throw new Error('Invalid content: missing required name or description');
    }
    
    // Generate and validate local filename
    const originalFilename = sanitizedPath.split('/').pop() || 'downloaded-element.md';
    const filename = validateFilename(originalFilename);
    
    // Get appropriate directory for element type
    const elementDir = this.portfolioManager.getElementDir(elementType);
    const localPath = path.join(elementDir, filename);
    
    // Check if file already exists
    try {
      await fs.access(localPath);
      return {
        success: false,
        message: `AI customization element already exists: ${filename}\n\nThe element has already been installed.`
      };
    } catch {
      // File doesn't exist, proceed with installation
    }
    
    // Write the sanitized file
    await fs.writeFile(localPath, sanitizedContent, 'utf-8');
    
    return {
      success: true,
      message: `AI customization element installed successfully!`,
      metadata,
      filename,
      elementType
    };
  }
  
  /**
   * Get ElementType from string
   */
  private getElementTypeFromString(typeStr: string): ElementType {
    const typeMap: Record<string, ElementType> = {
      'personas': ElementType.PERSONA,
      'skills': ElementType.SKILL,
      'templates': ElementType.TEMPLATE,
      'agents': ElementType.AGENT
    };
    
    const elementType = typeMap[typeStr];
    if (!elementType) {
      throw new Error(`Unknown element type: ${typeStr}. Valid types: ${Object.keys(typeMap).join(', ')}`);
    }
    
    return elementType;
  }
  
  /**
   * Format installation success message
   */
  formatInstallSuccess(metadata: IElementMetadata, filename: string, elementType: ElementType): string {
    const typeEmojis: Record<ElementType, string> = {
      [ElementType.PERSONA]: '🎭',
      [ElementType.SKILL]: '🎯',
      [ElementType.TEMPLATE]: '📄',
      [ElementType.AGENT]: '🤖'
    };
    
    const emoji = typeEmojis[elementType] || '📦';
    const typeName = elementType.charAt(0).toUpperCase() + elementType.slice(1);
    
    return `✅ **AI Customization Element Installed Successfully!**\n\n` +
      `${emoji} **${metadata.name}** ${metadata.author ? `by ${metadata.author}` : ''}\n` +
      `📁 Type: ${typeName}\n` +
      `📄 Saved as: ${filename}\n\n` +
      `🚀 **Ready to use!**`;
  }
}