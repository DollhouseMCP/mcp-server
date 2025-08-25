/**
 * Type definitions for portfolio tools
 * This file provides shared types to avoid circular dependencies
 * 
 * SECURITY NOTE: This file contains only TypeScript type definitions.
 * No actual user input processing occurs here. Any security scanner
 * warnings about Unicode normalization are false positives as these
 * are compile-time type definitions, not runtime code.
 * 
 * FIXES IMPLEMENTED (PR #503):
 * 1. TYPE SAFETY: Created shared type definitions to resolve circular dependencies
 * 2. FALSE POSITIVE: Added documentation to clarify no user input processing
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