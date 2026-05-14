import { describe, it, expect } from '@jest/globals';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const projectRoot = path.resolve(process.cwd());
const containerPath = path.join(projectRoot, 'src', 'di', 'Container.ts');

const CRITICAL_SESSION_OWNED_SERVICES = [
  'ActivationStore',
  'BackupService',
  'ChallengeStore',
  'ConfirmationStore',
  'DangerZoneEnforcer',
  'ElementEventDispatcher',
  'GatekeeperSession',
  'GitHubAuthManager',
  'GitHubPortfolioIndexer',
  'GitHubRateLimiter',
  'PathValidator',
  'PersonaIndicatorService',
  'PortfolioPullHandler',
  'PortfolioRepoManager',
  'PortfolioSyncManager',
  'SubmitToPortfolioTool',
  'TokenManager',
  'VerificationStore',
];

const HTTP_HANDLER_SERVICES = [
  'CollectionHandler',
  'ConfigHandler',
  'ElementCRUDHandler',
  'GitHubAuthHandler',
  'PortfolioHandler',
  'SyncHandler',
  'mcpAqlHandler',
];

describe('Per-session DI architecture', () => {
  it('keeps HTTP handler graph consumers from resolving session-owned services from the root container', async () => {
    const source = await readContainer();
    const sessionBody = extractMethodBody(source, 'createServerForHttpSession');
    const bundleBody = extractMethodBody(source, 'createHttpSessionHandlerBundle');
    const sessionRegisteredServices = extractChildRegistrations(sessionBody);
    const violations: string[] = [];

    for (const service of CRITICAL_SESSION_OWNED_SERVICES) {
      expect(sessionRegisteredServices).toContain(service);
    }

    for (const service of sessionRegisteredServices) {
      const rootResolve = new RegExp(`\\bthis\\.resolve(?:<[^>]+>)?\\(\\s*['"]${service}['"]\\s*\\)`, 'g');
      const matches = [...bundleBody.matchAll(rootResolve)];
      for (const match of matches) {
        violations.push(
          `${service}: createHttpSessionHandlerBundle uses root this.resolve(...) at ${lineFor(source, methodOffset(source, 'createHttpSessionHandlerBundle') + match.index!)}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('registers HTTP child handlers from the per-session bundle, never the cached root bundle', async () => {
    const source = await readContainer();
    const sessionBody = extractMethodBody(source, 'createServerForHttpSession');
    const violations: string[] = [];

    for (const service of HTTP_HANDLER_SERVICES) {
      const rootBundleRegistration = new RegExp(
        `child\\.register\\(\\s*['"]${service}['"]\\s*,\\s*\\(\\)\\s*=>\\s*(?:this\\.)?httpRootHandlerBundle[!?]?\\.`,
      );
      if (rootBundleRegistration.test(sessionBody)) {
        violations.push(`${service}: registered from cached root httpRootHandlerBundle`);
      }

      const rootResolveRegistration = new RegExp(
        `child\\.register\\(\\s*['"]${service}['"]\\s*,\\s*\\(\\)\\s*=>\\s*this\\.resolve(?:<[^>]+>)?\\(\\s*['"]${service}['"]\\s*\\)`,
      );
      if (rootResolveRegistration.test(sessionBody)) {
        violations.push(`${service}: registered by resolving root ${service}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps root MCPAQLHandler session-owned dependencies behind active-session lazy getters', async () => {
    const source = await readContainer();
    const bootstrapBody = extractMethodBody(source, 'bootstrapHandlers');

    expect(bootstrapBody).toContain("Object.defineProperty(handlerDeps, 'dangerZoneEnforcer'");
    expect(bootstrapBody).toContain("get: () => resolveActiveOrRoot<DangerZoneEnforcer>('DangerZoneEnforcer')");
    expect(bootstrapBody).not.toMatch(/\bdangerZoneEnforcer:\s*this\.resolve(?:<[^>]+>)?\(\s*['"]DangerZoneEnforcer['"]\s*\)/);

    expect(bootstrapBody).toContain("Object.defineProperty(handlerDeps, 'verificationStore'");
    expect(bootstrapBody).toContain("get: () => resolveActiveOrRoot<IChallengeStore>('ChallengeStore')");
    expect(bootstrapBody).not.toMatch(/\bverificationStore:\s*this\.resolve(?:<[^>]+>)?\(\s*['"](?:VerificationStore|ChallengeStore)['"]\s*\)/);
  });
});

async function readContainer(): Promise<string> {
  return fs.readFile(containerPath, 'utf8');
}

function methodOffset(source: string, methodName: string): number {
  return findMethodBody(source, methodName).start;
}

function extractMethodBody(source: string, methodName: string): string {
  const body = findMethodBody(source, methodName);
  return source.slice(body.start + 1, body.end - 1);
}

function lineFor(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function extractChildRegistrations(source: string): string[] {
  return [...source.matchAll(/child\.register(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/g)]
    .map(match => match[1])
    .sort();
}

function findMethodBody(source: string, methodName: string): { start: number; end: number } {
  const sourceFile = ts.createSourceFile(containerPath, source, ts.ScriptTarget.Latest, true);
  let body: ts.Block | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === methodName
      && node.body
    ) {
      body = node.body;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (!body) {
    throw new Error(`Could not find method ${methodName} in Container.ts`);
  }
  return { start: body.getStart(sourceFile), end: body.getEnd() };
}
