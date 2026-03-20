import { SkillManager } from '../../elements/skills/index.js';
import { TemplateManager } from '../../elements/templates/TemplateManager.js';
import { TemplateRenderer } from '../../utils/TemplateRenderer.js';
import { AgentManager } from '../../elements/agents/AgentManager.js';
import { MemoryManager } from '../../elements/memories/MemoryManager.js';
import { EnsembleManager } from '../../elements/ensembles/EnsembleManager.js';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { PersonaManager } from '../../persona/PersonaManager.js';
import { IFileOperationsService } from '../../services/FileOperationsService.js';
import { ElementQueryService } from '../../services/query/ElementQueryService.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import type { BackupService } from '../../services/BackupService.js';

export interface ElementCrudContext {
  ensureInitialized(): Promise<void>;
  getPersonaIndicator(): string;
  skillManager: SkillManager;
  templateManager: TemplateManager;
  templateRenderer: TemplateRenderer;
  agentManager: AgentManager;
  memoryManager: MemoryManager;
  ensembleManager: EnsembleManager;
  portfolioManager: PortfolioManager;
  personaManager: PersonaManager;
  fileOperations: IFileOperationsService;
  elementQueryService: ElementQueryService;
  validationRegistry: ValidationRegistry;
  backupService?: BackupService;
}
