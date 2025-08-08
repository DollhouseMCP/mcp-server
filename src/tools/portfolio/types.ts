/**
 * Type definitions for portfolio tools
 * This file provides shared types to avoid circular dependencies
 */

import { ElementType } from '../../portfolio/types.js';
import { IElementMetadata } from '../../types/elements/IElement.js';

/**
 * Simple portfolio element for submission
 * This is a simplified version that doesn't require full IElement implementation
 */
export interface SimplePortfolioElement {
  type: ElementType;
  metadata: Partial<IElementMetadata>;
  content: string;
}

/**
 * Parameters for submitting content to portfolio
 */
export interface SubmitToPortfolioParams {
  name: string;
  type?: ElementType;
}

/**
 * Result from portfolio submission
 */
export interface SubmitToPortfolioResult {
  success: boolean;
  message: string;
  url?: string;
  error?: string;
}