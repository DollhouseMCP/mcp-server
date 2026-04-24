#!/usr/bin/env ts-node

/**
 * Database Setup
 *
 * One-command setup for PostgreSQL database mode. Handles:
 * - Checking Docker availability
 * - Starting the Postgres container if not running
 * - Waiting for healthy status
 * - Running migrations
 * - Printing the env vars to configure
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   npm run db:setup
 *   npm run db:setup -- --reset    Drop and recreate the database
 */

import { execSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';

const args = process.argv.slice(2);
const reset = args.includes('--reset');

const COMPOSE_FILE = path.join(process.cwd(), 'docker', 'docker-compose.db.yml');
const CONTAINER_NAME = 'dollhousemcp-postgres';
const DB_NAME = 'dollhousemcp';
const ADMIN_URL = `postgres://dollhouse:dollhouse@localhost:5432/${DB_NAME}`;
const APP_URL = `postgres://dollhouse_app:dollhouse_app@localhost:5432/${DB_NAME}`;

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: opts?.silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    throw new Error(message.trim());
  }
}

function check(label: string, fn: () => boolean): boolean {
  try {
    const ok = fn();
    console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}`);
    return ok;
  } catch {
    console.log(`  ✗ ${label}`);
    return false;
  }
}

function checkPrerequisites(): void {
  console.log('Checking prerequisites...');
  const hasDocker = check('Docker available', () => {
    run('docker info', { silent: true });
    return true;
  });
  if (!hasDocker) {
    console.error('\nDocker is required. Install it from https://docs.docker.com/get-docker/');
    process.exit(1);
  }

  const hasCompose = check('Docker Compose available', () => {
    run('docker compose version', { silent: true });
    return true;
  });
  if (!hasCompose) {
    console.error('\nDocker Compose is required (included with Docker Desktop).');
    process.exit(1);
  }
}

async function ensureContainer(): Promise<void> {
  console.log('\nPostgreSQL container...');
  const isRunning = (() => {
    try {
      const status = run(`docker inspect -f '{{.State.Status}}' ${CONTAINER_NAME}`, { silent: true });
      return status === 'running';
    } catch {
      return false;
    }
  })();

  if (isRunning) {
    console.log(`  ✓ Container '${CONTAINER_NAME}' is running`);
  } else {
    console.log(`  → Starting PostgreSQL container...`);
    try {
      run(`docker compose -f ${COMPOSE_FILE} up -d`);
      console.log(`  ✓ Container started`);
    } catch (err) {
      console.error(`  ✗ Failed to start container: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  console.log('\n  Waiting for PostgreSQL to be ready...');
  for (let i = 0; i < 30; i++) {
    try {
      const health = run(`docker inspect -f '{{.State.Health.Status}}' ${CONTAINER_NAME}`, { silent: true });
      if (health === 'healthy') {
        console.log('  ✓ PostgreSQL is healthy');
        break;
      }
    } catch { /* not ready yet */ }
    if (i === 29) {
      console.error('  ✗ PostgreSQL did not become healthy within 30 seconds');
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

function ensureDatabase(): void {
  if (reset) {
    console.log('\n  Resetting database...');
    try {
      run(`docker exec ${CONTAINER_NAME} psql -U dollhouse -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME}"`, { silent: true });
      run(`docker exec ${CONTAINER_NAME} psql -U dollhouse -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER dollhouse"`, { silent: true });
      console.log('  ✓ Database dropped and recreated');
    } catch (err) {
      console.error(`  ✗ Reset failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  try {
    run(`docker exec ${CONTAINER_NAME} psql -U dollhouse -d ${DB_NAME} -c "SELECT 1"`, { silent: true });
    console.log(`  ✓ Database '${DB_NAME}' exists`);
  } catch {
    console.log(`  → Creating database '${DB_NAME}'...`);
    try {
      run(`docker exec ${CONTAINER_NAME} psql -U dollhouse -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER dollhouse"`);
      console.log(`  ✓ Database created`);
    } catch (err) {
      console.error(`  ✗ Failed to create database: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}

function runInitSql(label: string): void {
  try {
    const initSql = path.join(process.cwd(), 'docker', 'init-db.sql');
    run(`docker exec -i ${CONTAINER_NAME} psql -U dollhouse -d ${DB_NAME} < ${initSql}`, { silent: true });
    console.log(`  ✓ ${label}`);
  } catch {
    // Best effort
  }
}

function runMigrations(): void {
  console.log('\nRunning migrations...');
  try {
    const result = spawnSync('npx', ['drizzle-kit', 'migrate'], {
      env: { ...process.env, DOLLHOUSE_DATABASE_ADMIN_URL: ADMIN_URL },
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 30000,
      cwd: process.cwd(),
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || 'Migration failed');
    }
    console.log('  ✓ Migrations applied');
  } catch (err) {
    console.error(`  ✗ Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function printConfig(): void {
  console.log('\n=== Setup Complete ===\n');
  console.log('Add these to your environment or .env.local:\n');
  console.log(`  DOLLHOUSE_STORAGE_BACKEND=database`);
  console.log(`  DOLLHOUSE_DATABASE_URL=${APP_URL}`);
  console.log(`  DOLLHOUSE_DATABASE_ADMIN_URL=${ADMIN_URL}`);
  console.log();
  console.log('To start with HTTP streaming:\n');
  console.log(`  DOLLHOUSE_STORAGE_BACKEND=database \\`);
  console.log(`  DOLLHOUSE_DATABASE_URL="${APP_URL}" \\`);
  console.log(`  DOLLHOUSE_DATABASE_ADMIN_URL="${ADMIN_URL}" \\`);
  console.log(`  DOLLHOUSE_TRANSPORT=streamable-http \\`);
  console.log(`  node dist/index.js`);
  console.log();
  console.log('To import your existing portfolio:\n');
  console.log(`  npm run db:import -- --user <your-username>`);
  console.log();
  if (reset) {
    console.log('Note: Database was reset. You will need to re-import your portfolio.\n');
  }
}

async function main(): Promise<void> {
  console.log('=== DollhouseMCP Database Setup ===\n');
  checkPrerequisites();
  await ensureContainer();
  ensureDatabase();
  console.log('\nConfiguring roles and permissions...');
  runInitSql('Partial (will complete after migrations)');
  runMigrations();
  runInitSql('Post-migration permissions applied');
  printConfig();
}

try {
  await main();
} catch (err) {
  console.error('Fatal error:', err);
  process.exit(1);
}
