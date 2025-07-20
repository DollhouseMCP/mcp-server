/**
 * Element-specific rating breakdown interfaces.
 * Each element type can extend the base RatingBreakdown with specific metrics.
 */

import { RatingBreakdown } from './IElement.js';

// Personas - Focus on character and interaction quality
export interface PersonaRatingBreakdown extends RatingBreakdown {
  characterConsistency: number;  // Stays in character
  responseQuality: number;       // Quality of responses
  adaptability: number;         // Adapts to context
  personalityDepth: number;     // Richness of personality
  engagement: number;           // How engaging the persona is
}

// Skills - Focus on task performance
export interface SkillRatingBreakdown extends RatingBreakdown {
  accuracy: number;             // Correctness of outputs
  speed: number;               // Performance/response time
  coverage: number;            // Handles edge cases
  precision: number;           // Exactness of results
  errorHandling: number;       // Graceful failure
}

// Templates - Focus on structure and flexibility
export interface TemplateRatingBreakdown extends RatingBreakdown {
  flexibility: number;          // Adaptable to uses
  outputQuality: number;       // Quality of rendered output
  easeOfUse: number;          // How intuitive
  completeness: number;        // Has all needed sections
  clarity: number;            // Clear structure and instructions
}

// Agents - Focus on autonomy and decision-making
export interface AgentRatingBreakdown extends RatingBreakdown {
  goalAchievement: number;      // Success rate
  decisionQuality: number;     // Quality of decisions
  autonomyAppropriate: number; // Right level of independence
  riskManagement: number;      // Handles risks well
  taskPrioritization: number;  // Effective priority management
  contextAwareness: number;    // Understanding of situation
}

// Memories - Focus on information management
export interface MemoryRatingBreakdown extends RatingBreakdown {
  relevance: number;           // Returns relevant info
  accuracy: number;            // Information is correct
  recallSpeed: number;         // Quick retrieval
  contextRetention: number;    // Maintains context over time
  storageEfficiency: number;   // Efficient use of storage
}

// Ensembles - Focus on coordination and synergy
export interface EnsembleRatingBreakdown extends RatingBreakdown {
  coordination: number;         // Elements work well together
  synergyEffect: number;       // Better than sum of parts
  conflictResolution: number;  // Handles conflicts well
  loadBalancing: number;       // Distributes work effectively
  cohesion: number;           // Unified experience
}