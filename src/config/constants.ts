/**
 * Application-wide constants and configuration
 */

// Repository configuration
export const REPO_OWNER = 'mickdarling';
export const REPO_NAME = 'DollhouseMCP';
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

// Marketplace repository configuration
export const MARKETPLACE_REPO_OWNER = 'mickdarling';
export const MARKETPLACE_REPO_NAME = 'DollhouseMCP-Personas';

// Dependency version requirements
export const DEPENDENCY_REQUIREMENTS = {
  git: {
    minimum: '2.20.0',    // Required for modern features and security
    maximum: '2.50.0',    // Latest tested working version
    recommended: '2.40.0' // Optimal version for stability
  },
  npm: {
    minimum: '8.0.0',     // Required for package-lock v2 and modern features  
    maximum: '12.0.0',    // Latest tested working version
    recommended: '10.0.0' // Optimal version for stability
  }
};

// Anonymous ID generation
export const ADJECTIVES = ['clever', 'swift', 'bright', 'bold', 'wise', 'calm', 'keen', 'witty', 'sharp', 'cool'];
export const ANIMALS = ['fox', 'owl', 'cat', 'wolf', 'bear', 'hawk', 'deer', 'lion', 'eagle', 'tiger'];

// Valid persona categories
export const VALID_CATEGORIES = ['creative', 'professional', 'educational', 'gaming', 'personal'];