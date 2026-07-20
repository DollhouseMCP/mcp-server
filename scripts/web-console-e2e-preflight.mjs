#!/usr/bin/env node

import { createServer } from 'node:net';

import { chromium } from '@playwright/test';
import postgres from 'postgres';

const host = '127.0.0.1';
const port = Number(process.env.E2E_PW_PORT ?? 3102);
const postgresUrl = process.env.E2E_PG_SUPERUSER_URL
  ?? 'postgres://dollhouse:dollhouse@localhost:5432/postgres';

const checks = [
  {
    name: 'PostgreSQL superuser connection',
    run: checkPostgres,
    help: [
      'Start the repository database:',
      '  docker compose -f docker/docker-compose.db.yml up -d',
      'Or set E2E_PG_SUPERUSER_URL to a reachable PostgreSQL superuser URL.',
    ],
  },
  {
    name: `Playwright port ${host}:${port}`,
    run: checkPort,
    help: [
      `Stop the process using port ${port}, or select another port:`,
      '  E2E_PW_PORT=<free-port> npm run test:console-e2e:auth:compiled',
    ],
  },
  {
    name: 'System Google Chrome',
    run: checkChrome,
    help: [
      'Install Google Chrome so Playwright channel "chrome" is available.',
      'Do not run `npx playwright install`; this suite intentionally uses system Chrome.',
    ],
  },
];

const failures = [];
for (const check of checks) {
  try {
    await check.run();
    console.log(`✓ ${check.name}`);
  } catch (error) {
    failures.push(check);
    console.error(`✗ ${check.name}`);
    if (process.env.E2E_DEBUG === '1') console.error(`  ${errorMessage(error)}`);
  }
}

if (failures.length > 0) {
  console.error('\nWeb-console browser E2E prerequisites are not ready.');
  for (const failure of failures) {
    console.error(`\n${failure.name}:`);
    for (const line of failure.help) console.error(`  ${line}`);
  }
  console.error('\nThis dedicated browser gate is not part of the normal `npm test` suite.');
  process.exitCode = 1;
} else {
  console.log('Web-console browser E2E prerequisites are ready.');
}

async function checkPostgres() {
  const sql = postgres(postgresUrl, {
    ssl: false,
    max: 1,
    connect_timeout: 3,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    await sql`SELECT 1`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function checkPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(port, host, () => server.close(error => error ? reject(error) : resolve()));
  });
}

async function checkChrome() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  await browser.close();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
