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
  createElement(args: {name: string; type: string; description: string; content?: string; metadata?: Record<string, any>}): Promise<any>;
  editElement(args: {name: string; type: string; field: string; value: any}): Promise<any>;
  validateElement(args: {name: string; type: string; strict?: boolean}): Promise<any>;
  deleteElement(args: {name: string; type: string; deleteData?: boolean}): Promise<any>;
  
  // Element-specific tools
  renderTemplate(name: string, variables: Record<string, any>): Promise<any>;
  executeAgent(name: string, goal: string): Promise<any>;
  
  // Collection tools
  browseCollection(section?: string, type?: string): Promise<any>;
  searchCollection(query: string): Promise<any>;
  searchCollectionEnhanced(query: string, options?: any): Promise<any>;
  getCollectionContent(path: string): Promise<any>;
  installContent(path: string): Promise<any>;
  submitContent(content: string): Promise<any>;
  getCollectionCacheHealth(): Promise<any>;
  
  // User tools
  setUserIdentity(username: string, email?: string): Promise<any>;
  getUserIdentity(): Promise<any>;
  clearUserIdentity(): Promise<any>;
  
  // Authentication tools
  setupGitHubAuth(): Promise<any>;
  checkGitHubAuth(): Promise<any>;
  clearGitHubAuth(): Promise<any>;
  configureOAuth(client_id?: string): Promise<any>;
  getOAuthHelperStatus(verbose?: boolean): Promise<any>;
  
  
  // Config tools
  configureIndicator(config: any): Promise<any>;
  getIndicatorConfig(): Promise<any>;
  configureCollectionSubmission(autoSubmit: boolean): Promise<any>;
  getCollectionSubmissionConfig(): Promise<any>;
  
  // Export/Import tools
  exportPersona(persona: string): Promise<any>;
  exportAllPersonas(includeDefaults?: boolean): Promise<any>;
  importPersona(source: string, overwrite?: boolean): Promise<any>;
  
  // Portfolio tools
  portfolioStatus(username?: string): Promise<any>;
  initPortfolio(options: {repositoryName?: string; private?: boolean; description?: string}): Promise<any>;
  portfolioConfig(options: {autoSync?: boolean; defaultVisibility?: string; autoSubmit?: boolean; repositoryName?: string}): Promise<any>;
  syncPortfolio(options: {direction: string; mode?: string; force: boolean; dryRun: boolean; confirmDeletions?: boolean}): Promise<any>;
  searchPortfolio(options: {query: string; elementType?: string; fuzzyMatch?: boolean; maxResults?: number; includeKeywords?: boolean; includeTags?: boolean; includeTriggers?: boolean; includeDescriptions?: boolean}): Promise<any>;
  searchAll(options: {query: string; sources?: string[]; elementType?: string; page?: number; pageSize?: number; sortBy?: string}): Promise<any>;
  
  // New unified config and sync handlers
  handleConfigOperation(options: any): Promise<any>;
  handleSyncOperation(options: any): Promise<any>;

  // Enhanced Index tools
  findSimilarElements(options: {elementName: string; elementType?: string; limit: number; threshold: number}): Promise<any>;
  getElementRelationships(options: {elementName: string; elementType?: string; relationshipTypes?: string[]}): Promise<any>;
  searchByVerb(options: {verb: string; limit: number}): Promise<any>;
  getRelationshipStats(): Promise<any>;
}