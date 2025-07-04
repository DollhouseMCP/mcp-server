/**
 * Type definitions for persona-related structures
 */

export interface PersonaMetadata {
  name: string;
  description: string;
  unique_id?: string;
  author?: string;
  triggers?: string[];
  version?: string;
  category?: string;
  age_rating?: 'all' | '13+' | '18+';
  content_flags?: string[];
  ai_generated?: boolean;
  generation_method?: 'human' | 'ChatGPT' | 'Claude' | 'hybrid';
  price?: string;
  revenue_split?: string;
  license?: string;
  created_date?: string;
}

export interface Persona {
  metadata: PersonaMetadata;
  content: string;
  filename: string;
  unique_id: string;
}

export type AgeRating = 'all' | '13+' | '18+';
export type GenerationMethod = 'human' | 'ChatGPT' | 'Claude' | 'hybrid';
export type PersonaCategory = 'creative' | 'professional' | 'educational' | 'gaming' | 'personal';