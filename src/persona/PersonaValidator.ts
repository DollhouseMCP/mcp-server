/**
 * Persona validation and quality checks
 */

import { Persona, PersonaMetadata } from '../types/persona.js';
import { VALID_CATEGORIES } from '../config/constants.js';

export interface PersonaValidationResult {
  valid: boolean;
  issues: string[];
  warnings: string[];
  report: string;
}

export class PersonaValidator {
  
  /**
   * Validate a persona's metadata and content
   */
  validatePersona(persona: Persona): PersonaValidationResult {
    const issues: string[] = [];
    const warnings: string[] = [];
    const metadata = persona.metadata;
    
    // Required field checks
    if (!metadata.name || metadata.name.trim().length === 0) {
      issues.push("Missing or empty 'name' field");
    }
    if (!metadata.description || metadata.description.trim().length === 0) {
      issues.push("Missing or empty 'description' field");
    }
    if (!persona.content || persona.content.trim().length < 50) {
      issues.push("Persona content is too short (minimum 50 characters)");
    }
    
    // Category validation (optional)
    if (metadata.category && !VALID_CATEGORIES.includes(metadata.category)) {
      warnings.push(`Invalid category '${metadata.category}'. Valid categories are: ${VALID_CATEGORIES.join(', ')}`);
    }
    
    // Age rating validation
    const validAgeRatings = ['all', '13+', '18+'];
    if (metadata.age_rating && !validAgeRatings.includes(metadata.age_rating)) {
      warnings.push(`Invalid age_rating '${metadata.age_rating}'. Should be one of: ${validAgeRatings.join(', ')}`);
    }
    
    // Optional field warnings
    if (!metadata.triggers || metadata.triggers.length === 0) {
      warnings.push("No trigger keywords defined - users may have difficulty finding this persona");
    }
    if (!metadata.version) {
      warnings.push("No version specified - defaulting to '1.0'");
    }
    if (!metadata.unique_id) {
      warnings.push("No unique_id - one will be generated automatically");
    }
    
    // Content quality checks
    if (persona.content.length > 5000) {
      warnings.push("Persona content is very long - consider breaking it into sections");
    }
    if (metadata.name && metadata.name.length > 50) {
      warnings.push("Persona name is very long - consider shortening for better display");
    }
    if (metadata.description && metadata.description.length > 200) {
      warnings.push("Description is very long - consider keeping it under 200 characters");
    }
    
    // Generate validation report
    const report = this.generateReport(persona, issues, warnings);
    
    return {
      valid: issues.length === 0,
      issues,
      warnings,
      report
    };
  }
  
  /**
   * Validate persona metadata only
   */
  validateMetadata(metadata: PersonaMetadata): PersonaValidationResult {
    const issues: string[] = [];
    const warnings: string[] = [];
    
    if (!metadata.name || metadata.name.trim().length === 0) {
      issues.push("Missing or empty 'name' field");
    }
    if (!metadata.description || metadata.description.trim().length === 0) {
      issues.push("Missing or empty 'description' field");
    }
    
    if (metadata.category && !VALID_CATEGORIES.includes(metadata.category)) {
      warnings.push(`Invalid category '${metadata.category}'`);
    }
    
    return {
      valid: issues.length === 0,
      issues,
      warnings,
      report: ''
    };
  }
  
  /**
   * Generate a validation report
   */
  private generateReport(persona: Persona, issues: string[], warnings: string[]): string {
    const metadata = persona.metadata;
    let report = `📋 **Validation Report: ${metadata.name}**\n\n`;
    
    if (issues.length === 0 && warnings.length === 0) {
      report += `✅ **All Checks Passed!**\n\n` +
        `🎭 **Persona:** ${metadata.name}\n` +
        `📁 **Category:** ${metadata.category || 'general'}\n` +
        `📊 **Version:** ${metadata.version || '1.0'}\n` +
        `📝 **Content Length:** ${persona.content.length} characters\n` +
        `🔗 **Triggers:** ${metadata.triggers?.length || 0} keywords\n\n` +
        `This persona meets all validation requirements and is ready for use!`;
    } else {
      if (issues.length > 0) {
        report += `❌ **Issues Found (${issues.length}):**\n`;
        issues.forEach((issue, i) => {
          report += `   ${i + 1}. ${issue}\n`;
        });
        report += '\n';
      }
      
      if (warnings.length > 0) {
        report += `⚠️ **Warnings (${warnings.length}):**\n`;
        warnings.forEach((warning, i) => {
          report += `   ${i + 1}. ${warning}\n`;
        });
        report += '\n';
      }
      
      if (issues.length > 0) {
        report += `💡 **Fix Required:** Please address the issues above before using this persona.\n`;
      } else {
        report += `💚 **Status:** This persona is valid but could be improved. Consider addressing the warnings.\n`;
      }
    }
    
    return report;
  }
  
  /**
   * Check if a persona name is valid
   */
  isValidPersonaName(name: string): boolean {
    if (!name || name.trim().length === 0) return false;
    if (name.length > 50) return false;
    // Check for invalid characters
    return !/[<>:"/\\|?*]/.test(name);
  }
  
  /**
   * Suggest improvements for a persona
   */
  suggestImprovements(persona: Persona): string[] {
    const suggestions: string[] = [];
    const metadata = persona.metadata;
    
    if (!metadata.triggers || metadata.triggers.length < 3) {
      suggestions.push("Add more trigger keywords to improve discoverability");
    }
    
    if (!metadata.author) {
      suggestions.push("Add an author field for proper attribution");
    }
    
    if (persona.content.length < 200) {
      suggestions.push("Expand the persona instructions for better AI guidance");
    }
    
    if (!metadata.version) {
      suggestions.push("Add a version number for tracking updates");
    }
    
    // Category is now optional - removed suggestion
    
    return suggestions;
  }
}