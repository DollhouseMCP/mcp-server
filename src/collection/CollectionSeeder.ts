/**
 * Collection seeder for anonymous/offline browsing
 * Provides basic collection data that doesn't require GitHub authentication
 */

import { CollectionItem } from '../cache/CollectionCache.js';

/**
 * Basic collection data that can be used without GitHub API access
 * This provides a minimal set of well-known collection items
 */
export class CollectionSeeder {
  
  /**
   * Get seed data for the collection cache
   * This includes popular/essential items that are commonly requested
   */
  static getSeedData(): CollectionItem[] {
    return [
      // Popular Personas
      {
        name: 'creative-writer.md',
        path: 'library/personas/creative-writer.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'eli5-explainer.md',
        path: 'library/personas/eli5-explainer.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'debug-detective.md',
        path: 'library/personas/debug-detective.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'technical-analyst.md',
        path: 'library/personas/technical-analyst.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'business-consultant.md',
        path: 'library/personas/business-consultant.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'security-analyst.md',
        path: 'library/personas/security-analyst.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      
      // Popular Skills
      {
        name: 'code-review.md',
        path: 'library/skills/code-review.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'creative-writing.md',
        path: 'library/skills/creative-writing.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'data-analysis.md',
        path: 'library/skills/data-analysis.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'research.md',
        path: 'library/skills/research.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'translation.md',
        path: 'library/skills/translation.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'threat-modeling.md',
        path: 'library/skills/threat-modeling.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'penetration-testing.md',
        path: 'library/skills/penetration-testing.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      
      // Popular Agents
      {
        name: 'code-reviewer.md',
        path: 'library/agents/code-reviewer.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'research-assistant.md',
        path: 'library/agents/research-assistant.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'task-manager.md',
        path: 'library/agents/task-manager.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      
      // Popular Templates
      {
        name: 'code-documentation.md',
        path: 'library/templates/code-documentation.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'email-professional.md',
        path: 'library/templates/email-professional.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'meeting-notes.md',
        path: 'library/templates/meeting-notes.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'project-brief.md',
        path: 'library/templates/project-brief.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'report-executive.md',
        path: 'library/templates/report-executive.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'penetration-test-report.md',
        path: 'library/templates/penetration-test-report.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'security-vulnerability-report.md',
        path: 'library/templates/security-vulnerability-report.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'threat-assessment-report.md',
        path: 'library/templates/threat-assessment-report.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      
      // Popular Ensembles
      {
        name: 'business-advisor.md',
        path: 'library/ensembles/business-advisor.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'creative-studio.md',
        path: 'library/ensembles/creative-studio.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'development-team.md',
        path: 'library/ensembles/development-team.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      },
      {
        name: 'security-analysis-team.md',
        path: 'library/ensembles/security-analysis-team.md',
        sha: 'seed-data',
        last_modified: new Date().toISOString()
      }
    ];
  }
  
  /**
   * Get collection statistics from seed data
   */
  static getSeedStats() {
    const seedData = this.getSeedData();
    const typeCount = new Map<string, number>();
    
    seedData.forEach(item => {
      // Extract type from path (library/personas/name.md -> personas)
      const pathParts = item.path.split('/');
      const type = pathParts[1] || 'unknown';
      typeCount.set(type, (typeCount.get(type) || 0) + 1);
    });
    
    return {
      total: seedData.length,
      byType: Object.fromEntries(typeCount)
    };
  }
  
  /**
   * Check if an item is available in seed data
   */
  static isItemInSeedData(path: string): boolean {
    return this.getSeedData().some(item => item.path === path);
  }
  
  /**
   * Get seed item by path
   */
  static getSeedItem(path: string): CollectionItem | undefined {
    return this.getSeedData().find(item => item.path === path);
  }
}