// TEST ONLY. Run only inside a disposable, network-none Linux container.
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { createHash, createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { once } from 'node:events';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { inventory } from '/proof/inventory.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stage = process.argv[2];
assert.ok(['node-base', 'builder', 'production'].includes(stage));
assert.equal(process.platform, 'linux');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.modules, '137');
assert.equal(process.execPath, '/usr/local/bin/node');
const recipe = JSON.parse(await readFile('/proof/recipe.json', 'utf8'));
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const artifact = recipe.artifacts[arch];
assert.ok(artifact);
assert.equal(hash(await readFile(process.execPath)), artifact.nodeSha256);
assert.equal((await lstat(process.execPath)).size, artifact.nodeBytes);
const receipt = JSON.parse(await readFile('/usr/local/.dollhouse-node-runtime-refresh.json', 'utf8'));
assert.equal(receipt.schema, 'signed-node-hybrid-refresh-v1');
for (const key of ['nodeSha256', 'headerTreeSha256', 'headerFiles']) assert.equal(receipt[key], artifact[key]);
assert.equal(receipt.archiveSha256, artifact.sha256);
assert.equal(receipt.node, '24.22.1');
assert.equal(receipt.npmCore, '11.19.0');
assert.equal(receipt.officialImageClaim, false);
assert.equal(receipt.bundledNpm11191Copied, false);
assert.equal(receipt.candidateExecutedByHelper, false);
assert.match(receipt.unchangedOutsideBinaryHeadersSha256, /^[a-f0-9]{64}$/u);
const headers = await inventory('/usr/local/include/node');
const rows = Object.entries(headers).filter(([, entry]) => entry.kind === 'file')
  .map(([name, entry]) => [name, entry.sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
assert.equal(rows.length, 458);
assert.equal(hash(JSON.stringify(rows)), artifact.headerTreeSha256);
const require = createRequire('/app/package.json');
assert.equal(JSON.parse(await readFile('/usr/local/lib/node_modules/npm/package.json', 'utf8')).version, '11.19.0');
const npm = spawnSync(process.execPath, ['/usr/local/lib/node_modules/npm/bin/npm-cli.js', '--version'], {
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false' },
  timeout: 5000, maxBuffer: 32768, encoding: 'utf8' });
assert.ifError(npm.error); assert.equal(npm.status, 0, npm.stderr); assert.equal(npm.stdout.trim(), '11.19.0');
let unchangedPrefixRecomputed = false;
if (stage === 'node-base') {
  const prefix = await inventory('/usr/local');
  const keep = Object.fromEntries(Object.entries(prefix).filter(([name]) =>
    name !== '.dollhouse-node-runtime-refresh.json' && name !== 'bin/node' &&
    name !== 'include/node' && !name.startsWith('include/node/')));
  assert.equal(hash(JSON.stringify(keep)), receipt.unchangedOutsideBinaryHeadersSha256);
  unchangedPrefixRecomputed = true;
}

const report = { stage, platform: process.platform, arch: process.arch, version: process.version,
  modules: process.versions.modules, versions: process.versions, npm: '11.19.0',
  binaryHashVerified: true, headerFiles: rows.length, headerTreeVerified: true,
  refreshReceipt: receipt, unchangedPrefixRecomputed,
  prefixLimit: 'Prefix compared only in node-base; later npm preparation and production tool removal intentionally change it.' };

if (stage !== 'node-base') {
  const native = require('/native/qualification.node');
  assert.equal(native.answer(), 42);
  assert.equal(native.abi(), 137);
  report.nativeAddon = { loaded: true, answer: native.answer(), abi: native.abi(),
    sha256: hash(await readFile('/native/qualification.node')) };

  const plaintext = Buffer.from('signed Node runtime qualification\n'.repeat(256));
  const compressed = brotliCompressSync(plaintext);
  assert.deepEqual(brotliDecompressSync(compressed, { maxOutputLength: 16384 }), plaintext);
  assert.throws(() => brotliDecompressSync(compressed.subarray(0, compressed.length - 1), { maxOutputLength: 16384 }));
  report.brotli = { roundTrip: true, truncatedInputRejected: true,
    limit: 'No retained CVE-2026-111497 exploit fixture; this smoke does not establish exploit-specific closure.' };

  const key = Buffer.alloc(32, 7), iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const decode = authTag => {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  };
  assert.deepEqual(decode(tag), plaintext);
  const wrong = Buffer.from(tag); wrong[0] ^= 1;
  assert.throws(() => decode(wrong));
  assert.notDeepEqual(randomBytes(32), randomBytes(32));
  report.crypto = { aesGcmRoundTrip: true, badTagRejected: true, randomSmoke: true,
    limit: 'Random-byte inequality is not snapshot-entropy or cryptographic validation.' };

  const ca = await readFile('/tls/ca.pem');
  const cert = await readFile('/tls/address-cert.pem');
  const tlsKey = await readFile('/tls/address-key.pem');
  const legacy = new X509Certificate(cert).toLegacyObject();
  assert.equal(tls.checkServerIdentity('127.0.0.1', legacy), undefined);
  assert.equal(tls.checkServerIdentity('wrong.invalid', legacy)?.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end(request.url);
  });
  const secure = https.createServer({ key: tlsKey, cert, minVersion: 'TLSv1.2' }, (_request, response) => response.end('tls-ok'));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const request = (client, options) => new Promise((resolve, reject) => {
    const outgoing = client.get(options, response => {
      const authorized = response.socket.authorized;
      const chunks = []; let count = 0;
      response.on('data', chunk => { count += chunk.length; if (count > 4096) response.destroy(new Error('Bounded response exceeded')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), reusedSocket: outgoing.reusedSocket, authorized }));
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Bounded request timeout')));
    outgoing.on('error', reject);
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    secure.listen(0, '127.0.0.1'); await once(secure, 'listening');
    const first = await request(http, { host: '127.0.0.1', port: server.address().port, path: '/first', agent });
    await new Promise(resolve => setImmediate(resolve));
    const second = await request(http, { host: '127.0.0.1', port: server.address().port, path: '/second', agent });
    assert.equal(first.body, '/first'); assert.equal(second.body, '/second'); assert.equal(second.reusedSocket, true);
    const passed = await request(https, { host: '127.0.0.1', port: secure.address().port, ca, agent: false });
    assert.equal(passed.body, 'tls-ok'); assert.equal(passed.authorized, true);
    await assert.rejects(request(https, { host: '127.0.0.1', port: secure.address().port, ca, servername: 'wrong.invalid', agent: false }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    report.httpTls = { loopbackOnly: true, agentReusedSocket: true, trustedCertificateHandshake: true, wrongHostnameRejected: true };
  } finally {
    agent.destroy(); server.closeAllConnections(); secure.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => secure.close(resolve))]);
  }
}
console.log(JSON.stringify(report));
