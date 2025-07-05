/**
 * Server interface types to avoid circular dependencies
 */

export interface IToolHandler {
  // Persona tools
  listPersonas(): Promise<any>;
  activatePersona(persona: string): Promise<any>;
  getActivePersona(): Promise<any>;
  deactivatePersona(): Promise<any>;
  getPersonaDetails(persona: string): Promise<any>;
  reloadPersonas(): Promise<any>;
  createPersona(name: string, description: string, category: string, instructions: string, triggers?: string): Promise<any>;
  editPersona(persona: string, field: string, value: string): Promise<any>;
  validatePersona(persona: string): Promise<any>;
  
  // Marketplace tools
  browseMarketplace(category?: string): Promise<any>;
  searchMarketplace(query: string): Promise<any>;
  getMarketplacePersona(path: string): Promise<any>;
  installPersona(path: string): Promise<any>;
  submitPersona(persona: string): Promise<any>;
  
  // User tools
  setUserIdentity(username: string, email?: string): Promise<any>;
  getUserIdentity(): Promise<any>;
  clearUserIdentity(): Promise<any>;
  
  // Update tools
  checkForUpdates(): Promise<any>;
  updateServer(confirm: boolean): Promise<any>;
  rollbackUpdate(confirm: boolean): Promise<any>;
  getServerStatus(): Promise<any>;
  
  // Config tools
  configureIndicator(config: any): Promise<any>;
  getIndicatorConfig(): Promise<any>;
}