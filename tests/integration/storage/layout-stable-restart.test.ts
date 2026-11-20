import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { DollhouseMCPServer } from '../../../src/index.js';
import { FileActivationStateStore } from '../../../src/state/FileActivationStateStore.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { createStdioSession } from '../../../src/context/StdioSession.js';
import { createHttpSession } from '../../../src/context/HttpSession.js';
import { SessionContainerRegistry } from '../../../src/di/SessionContainerRegistry.js';
import { createStreamableHttpRuntime } from '../../../src/server/StreamableHttpServer.js';
import { connectHttpClient } from '../../helpers/httpTransportHelper.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { PathService } from '../../../src/paths/PathService.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { logger } from '../../../src/utils/logger.js';
import { DefaultElementProvider } from '../../../src/portfolio/DefaultElementProvider.js';
import { SEED_MEMORY_FILENAME } from '../../../src/elements/memories/constants.js';
import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { LegacyDetectingPathResolver, PORTFOLIO_LAYOUT_MARKER_FILENAME } from '../../../src/paths/LegacyDetectingPathResolver.js';

const environmentKeys = ['DOLLHOUSE_HOME_DIR', 'DOLLHOUSE_PORTFOLIO_DIR', 'DOLLHOUSE_USER',
  'DOLLHOUSE_LOAD_TEST_DATA', 'DOLLHOUSE_SESSION_ID', 'DOLLHOUSE_ACTIVATION_PERSISTENCE', 'DOLLHOUSE_WEB_CONSOLE', 'DOLLHOUSE_PERMISSION_SERVER'] as const;

describe('Fresh storage layout across startup and restart', () => {
  let home: string;
  let saved: (string | undefined)[];
  const cleanups: (() => Promise<void>)[] = [];
  beforeEach(async () => {
    saved = environmentKeys.map(key => process.env[key]);
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-restart-'));
    process.env.DOLLHOUSE_HOME_DIR = home;
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    process.env.DOLLHOUSE_USER = 'restart-user';
    process.env.DOLLHOUSE_SESSION_ID = 'restart-session';
    process.env.DOLLHOUSE_ACTIVATION_PERSISTENCE = 'true';
    process.env.DOLLHOUSE_WEB_CONSOLE = 'false';
    process.env.DOLLHOUSE_PERMISSION_SERVER = 'false';
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await fs.rm(home, { recursive: true, force: true });
    environmentKeys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  });

  async function start(mode: 'stdio' | 'http') {
    const container = new DollhouseContainer();
    // Keep stdio's default legacy state location inside this test's isolated home.
    container.replace('ActivationStore', () => new FileActivationStateStore(
      container.resolve('FileOperationsService'), path.join(home, '.dollhouse', 'state'), 'restart-session'));
    let session = createStdioSession();
    let scoped: Pick<DollhouseContainer, 'resolve'> = container;
    let stopTransport: () => Promise<void>;
    if (mode === 'stdio') {
      const server = new DollhouseMCPServer(container);
      await server.listPersonas();
      await container.completeSinkSetup();
      stopTransport = () => server.dispose();
    } else {
      await container.preparePortfolio();
      await container.bootstrapHttpHandlers();
      await container.completeSinkSetup();
      const runtime = await createStreamableHttpRuntime(async transport => {
        session = createHttpSession({ userId: 'restart-user' });
        const instance = await container.createServerForHttpSession(session);
        await instance.server.connect(transport);
        return { dispose: instance.dispose, contextSessionId: session.sessionId };
      }, { host: '127.0.0.1', port: 0, mcpPath: '/mcp', registerSignalHandlers: false });
      const client = await connectHttpClient(runtime);
      scoped = container.resolve<SessionContainerRegistry>('SessionContainerRegistry').get(session.sessionId)!;
      stopTransport = async () => { await client.disconnect(); await runtime.close(); await container.dispose(); };
    }
    let stopped = false;
    const stop = async () => { if (!stopped) { stopped = true; await stopTransport(); } };
    cleanups.push(stop);
    const tracker = container.resolve<ContextTracker>('ContextTracker');
    const run = <T>(work: () => Promise<T>) => tracker.runAsync(tracker.createSessionContext('llm-request', session), work);
    return { stop, run, handler: scoped.resolve<ElementCRUDHandler>('ElementCRUDHandler'),
      manager: scoped.resolve<SkillManager>('SkillManager'),
      memory: scoped.resolve<MemoryManager>('MemoryManager'),
      store: scoped.resolve<FileActivationStateStore>('ActivationStore'),
      portfolio: container.resolve<PathService>('PathService').getUserPortfolioDir('restart-user') };
  }

  it('publishes the layout before startup can create legacy directories', async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const persist = LegacyDetectingPathResolver.prototype.persistLayoutDecision;
    jest.spyOn(LegacyDetectingPathResolver.prototype, 'persistLayoutDecision').mockImplementationOnce(async function (this: LegacyDetectingPathResolver) {
      entered();
      await blocked;
      await persist.call(this);
    });
    const starting = start('stdio');
    await waiting;
    try {
      await expect(fs.lstat(path.join(home, '.dollhouse'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(path.join(home, 'DollhouseMCP', PORTFOLIO_LAYOUT_MARKER_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(); }
    await starting;
    expect((await fs.lstat(path.join(home, 'DollhouseMCP', PORTFOLIO_LAYOUT_MARKER_FILENAME))).isFile()).toBe(true);
  });

  it('recovers an already flipped install and keeps the recovered record across restart', async () => {
    const root = path.join(home, 'DollhouseMCP');
    const portfolio = path.join(root, 'users', 'restart-user', 'portfolio');
    process.env.DOLLHOUSE_LOAD_TEST_DATA = 'true';
    await fs.mkdir(path.join(home, '.dollhouse', 'logs'), { recursive: true });
    const flat = await start('stdio');
    expect(flat.portfolio).toBe(path.join(home, '.dollhouse', 'portfolio'));
    // PortfolioManager skips default population under NODE_ENV=test; invoke its real provider.
    await new DefaultElementProvider().populateDefaults(flat.portfolio);
    await flat.run(() => flat.memory.installSeedMemories());
    const installedSeeds = (await fs.readdir(path.join(flat.portfolio, 'memories', 'system'))).filter(file => file.endsWith('.yaml'));
    expect(installedSeeds).toContain(SEED_MEMORY_FILENAME);
    // Current installation skips a populated seed; reproduce a historical upgrade backup.
    await fs.copyFile(path.join(flat.portfolio, 'memories', 'system', SEED_MEMORY_FILENAME),
      path.join(flat.portfolio, 'memories', 'system', SEED_MEMORY_FILENAME.replace('.yaml', '.backup-2025-11-14-22-40-57-303.yaml')));
    expect((await fs.readdir(path.join(flat.portfolio, 'skills'))).length).toBeGreaterThan(0);
    const sidecar = path.join(flat.portfolio, 'agents', '.state', 'runtime.state.yaml');
    await fs.mkdir(path.dirname(sidecar), { recursive: true });
    await fs.writeFile(sidecar, 'runtime: state');
    await flat.stop();
    await fs.mkdir(path.join(portfolio, 'skills'), { recursive: true });
    await fs.writeFile(path.join(portfolio, 'skills', 'recovered.md'),
      '---\nname: recovered-skill\ndescription: Skill stranded by the old layout detection\n---\nFollow these retained skill instructions.');
    await fs.mkdir(path.join(home, '.dollhouse', 'logs'), { recursive: true });
    const packageRoot = path.join(home, 'package');
    await fs.cp(path.join(new PackageResourceLocator().getPackageRoot(), 'data'), path.join(packageRoot, 'data'), {
      recursive: true, filter: async source => (await fs.stat(source)).isDirectory() || source.endsWith('.md'),
    });
    await expect(fs.lstat(path.join(packageRoot, 'data', 'HASHES.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    jest.spyOn(PackageResourceLocator.prototype, 'getPackageRoot').mockReturnValue(packageRoot);
    const warning = jest.spyOn(logger, 'warn');
    const recovered = await start('stdio');
    expect(recovered.portfolio).toBe(portfolio);
    await recovered.run(async () => {
      expect((await recovered.manager.list()).map(skill => skill.metadata.name)).toContain('recovered-skill');
    });
    const marker = path.join(root, PORTFOLIO_LAYOUT_MARKER_FILENAME);
    const oldTime = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(marker, oldTime, oldTime);
    await recovered.stop();
    const restarted = await start('stdio');
    expect(restarted.portfolio).toBe(portfolio);
    await restarted.run(async () => {
      expect((await restarted.manager.list()).map(skill => skill.metadata.name)).toContain('recovered-skill');
    });
    expect((await fs.stat(marker)).mtimeMs).toBe(oldTime.getTime());
    expect(warning.mock.calls.filter(([message]) => message.startsWith('Ignoring legacy portfolio'))).toEqual([]);
  });

  it.each(['stdio', 'http'] as const)('keeps skill storage after %s restarts with an incidental legacy directory', async mode => {
    const first = await start(mode);
    const expected = path.join(home, 'DollhouseMCP', 'users', 'restart-user', 'portfolio');
    expect(first.portfolio).toBe(expected);
    await first.run(async () => {
      const created = await first.handler.createElement({ name: 'restart-skill', type: 'skill',
        description: 'Skill surviving a server restart', content: 'Follow these persistent skill instructions.' });
      expect(created.content[0].text).not.toContain('❌');
      expect((await first.handler.activateElement('restart-skill', 'skill')).content[0].text).not.toContain('❌');
      expect((await first.manager.getActiveSkills()).map(skill => skill.metadata.name)).toContain('restart-skill');
      await first.store['persist']();
    });
    await first.stop();
    // These directories are normally created by server subsystems after detection.
    await fs.mkdir(path.join(home, '.dollhouse', 'logs'), { recursive: true });
    await fs.mkdir(path.join(home, '.dollhouse', 'run'), { recursive: true });
    const restarted = await start(mode);
    expect(restarted.portfolio).toBe(expected);
    await restarted.run(async () => {
      expect((await restarted.manager.list()).map(skill => skill.metadata.name)).toContain('restart-skill');
      const active = (await restarted.manager.getActiveSkills()).map(skill => skill.metadata.name);
      if (mode === 'stdio') expect(active).toContain('restart-skill');
      else {
        // HTTP activation is intentionally ephemeral per connection; stored definitions survive.
        expect(active).toEqual([]);
        expect((await restarted.handler.activateElement('restart-skill', 'skill')).content[0].text).not.toContain('❌');
        expect((await restarted.manager.getActiveSkills()).map(skill => skill.metadata.name)).toContain('restart-skill');
      }
    });
    expect((await fs.lstat(path.join(home, 'DollhouseMCP', PORTFOLIO_LAYOUT_MARKER_FILENAME))).isFile()).toBe(true);
  });
});
