/**
 * Rating management system for element evaluation and feedback processing.
 * Handles both AI evaluation and user feedback to drive continuous improvement.
 */

import { IElement, ElementRatings, UserFeedback, FeedbackContext } from './IElement.js';
import { ElementType } from '../../portfolio/types.js';

// Main rating manager interface
export interface IRatingManager {
  // AI evaluation
  evaluateElement(element: IElement, metrics: PerformanceMetrics): Promise<number>;
  
  // User feedback processing
  processFeedback(element: IElement, feedback: string, context?: FeedbackContext): Promise<void>;
  
  // Delta analysis
  analyzeDelta(element: IElement): DeltaAnalysis;
  
  // Improvement suggestions
  suggestImprovements(element: IElement): Improvement[];
  
  // Aggregate ratings (for collections)
  getAggregateRatings(elementType?: ElementType): AggregateRatings;
  
  // Rating history
  getRatingHistory(elementId: string): RatingHistoryEntry[];
  
  // Batch operations
  evaluateMany(elements: IElement[], metrics: PerformanceMetrics): Promise<Map<string, number>>;
}

// Performance metrics for AI evaluation
export interface PerformanceMetrics {
  taskCompletion: number;       // 0-1, did it complete the task?
  responseTime: number;         // milliseconds
  errorRate: number;           // 0-1, frequency of errors
  resourceUsage?: ResourceMetrics;
  customMetrics?: Record<string, number>;
}

// Resource usage metrics
export interface ResourceMetrics {
  tokenCount?: number;
  apiCalls?: number;
  computeTime?: number;
  memoryUsage?: number;
}

// Delta analysis between AI and user ratings
export interface DeltaAnalysis {
  delta: number;                // userRating - aiRating
  significance: 'high' | 'medium' | 'low' | 'none';
  possibleReasons: string[];
  recommendations: string[];
  confidence: number;          // 0-1
}

// Improvement suggestion
export interface Improvement {
  area: string;
  currentScore: number;
  targetScore: number;
  suggestion: string;
  priority: 'high' | 'medium' | 'low';
  estimatedImpact: number;     // 0-1
}

// Aggregate ratings for collections
export interface AggregateRatings {
  elementType?: ElementType;
  count: number;
  averageAiRating: number;
  averageUserRating: number;
  averageDelta: number;
  topRated: ElementRatingSummary[];
  bottomRated: ElementRatingSummary[];
  mostImproved: ElementRatingSummary[];
  distribution: RatingDistribution;
}

// Summary of element rating
export interface ElementRatingSummary {
  elementId: string;
  elementName: string;
  aiRating: number;
  userRating?: number;
  ratingCount: number;
  trend: 'improving' | 'declining' | 'stable';
}

// Rating distribution
export interface RatingDistribution {
  stars1: number;  // Count of 1-star ratings
  stars2: number;
  stars3: number;
  stars4: number;
  stars5: number;
}

// Rating history entry
export interface RatingHistoryEntry {
  timestamp: Date;
  aiRating: number;
  userRating?: number;
  metrics?: PerformanceMetrics;
  feedback?: UserFeedback;
  version: string;
}

// Feedback processor interface
export interface IFeedbackProcessor {
  // Process natural language feedback
  process(feedback: string): Promise<ProcessedFeedback>;
  
  // Extract sentiment
  analyzeSentiment(text: string): Promise<'positive' | 'negative' | 'neutral'>;
  
  // Infer rating from text
  inferRating(text: string): Promise<number | null>;
  
  // Extract improvement suggestions
  extractSuggestions(text: string): Promise<string[]>;
}

// Processed feedback result
export interface ProcessedFeedback {
  originalFeedback: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  inferredRating?: number;
  confidence: number;
  keywords: string[];
  suggestions: string[];
  entities: FeedbackEntity[];
}

// Entities extracted from feedback
export interface FeedbackEntity {
  type: 'feature' | 'issue' | 'praise' | 'criticism';
  text: string;
  relevance: number;  // 0-1
}

// Rating calculator for element-specific metrics
export interface IRatingCalculator<T extends IElement> {
  calculate(element: T, metrics: PerformanceMetrics): number;
  getWeights(): RatingWeights;
  adjustWeights(feedback: ProcessedFeedback[]): RatingWeights;
}

// Rating calculation weights
export interface RatingWeights {
  effectiveness: number;
  reliability: number;
  usability: number;
  [key: string]: number;  // Element-specific weights
}