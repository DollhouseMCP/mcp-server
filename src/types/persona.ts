import { IElement, IElementMetadata } from './elements/IElement.js';

export interface PersonaMetadata extends IElementMetadata {
  name: string;
  description: string;
  unique_id?: string;
  filename?: string;  // Tracks the actual filename on disk for reliable retrieval after reload
  triggers?: string[];
  version?: string;
  author?: string;
  category?: string;
  age_rating?: string;
  price?: string;
  ai_generated?: boolean;
  generation_method?: string;
  license?: string;
  created_date?: string;
  content_flags?: string[];
  revenue_split?: string;
}

export interface Persona extends IElement {
  metadata: PersonaMetadata;
  instructions: string;  // Behavioral directives (command voice)
  content: string;       // Reference material (informational)
  filename: string;
  unique_id: string;
}
