/**
 * Server interface types to avoid circular dependencies
 */

export interface IToolHandler {
  // Persona tools (legacy - will call element tools internally)
  listPersonas(): Promise<any>;
  activatePersona(persona: string): Promise<any>;
  getActivePersona(): Promise<any>;
  deactivatePersona(): Promise<any>;
  getPersonaDetails(persona: string): Promise<any>;
  reloadPersonas(): Promise<any>;
  createPersona(name: string, description: string, category: string, instructions: string, triggers?: string): Promise<any>;
  editPersona(persona: string, field: string, value: string): Promise<any>;
  validatePersona(persona: string): Promise<any>;
  
  // Element tools (generic for all element types)
  listElements(type: string): Promise<any>;
  activateElement(name: string, type: string): Promise<any>;
  getActiveElements(type: string): Promise<any>;
  deactivateElement(name: string, type: string): Promise<any>;
  getElementDetails(name: string, type: string): Promise<any>;
  reloadElements(type: string): Promise<any>;
  
  // Element-specific tools
  renderTemplate(name: string, variables: Record<string, any>): Promise<any>;
  executeAgent(name: string, goal: string): Promise<any>;
  
  // Collection tools
  browseCollection(section?: string, type?: string): Promise<any>;
  searchCollection(query: string): Promise<any>;
  getCollectionContent(path: string): Promise<any>;
  installContent(path: string): Promise<any>;
  submitContent(content: string): Promise<any>;
  
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
  
  // Export/Import/Share tools
  exportPersona(persona: string): Promise<any>;
  exportAllPersonas(includeDefaults?: boolean): Promise<any>;
  importPersona(source: string, overwrite?: boolean): Promise<any>;
  sharePersona(persona: string, expiryDays?: number): Promise<any>;
  importFromUrl(url: string, overwrite?: boolean): Promise<any>;
}