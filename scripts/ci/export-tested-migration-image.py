#!/usr/bin/env python3
"""Retain the exact native-tested, source-bound migration image in CI."""
import hashlib
import json
import os
import pathlib
import platform
import re
import resource
import subprocess


def output(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def validate_environment(config, role):
    expected_environment = {
        'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt', 'HOME': '/home/dollhouse',
        'NODE_ENV': 'production', 'PERSONAS_DIR': '/app/data/personas',
        'NODE_OPTIONS': '--max-old-space-size=256', 'DOLLHOUSE_DISABLE_UPDATES': 'true',
        'DOLLHOUSE_SECURITY_MODE': 'strict',
        'PATH': '/app/node_modules/.bin:/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    }
    if role == 'migration':
        expected_environment.update(DOLLHOUSE_PORTFOLIO_DIR='/app/tmp/portfolio',
                                    DOLLHOUSE_CACHE_DIR='/app/tmp/cache')
    env = config.get('Env')
    require(isinstance(env, list) and all(isinstance(item, str) and '=' in item for item in env),
            'Invalid migration image environment')
    environment = dict(item.split('=', 1) for item in env)
    require(len(env) == len(expected_environment) and environment == expected_environment,
            'Unexpected migration image environment; do not upload')

def main():
    expected = os.environ['EVIDENCE_PLATFORM']
    require(expected in {'linux/amd64', 'linux/arm64'}, 'Unexpected platform')
    arch = expected.split('/')[1]
    require(platform.machine().lower() in {'amd64': {'x86_64', 'amd64'}, 'arm64': {'aarch64', 'arm64'}}[arch],
            'Migration image must be tested natively')
    root = pathlib.Path(os.environ['RUNNER_TEMP'])
    role = os.environ.get('MIGRATION_EVIDENCE_ROLE', 'migration')
    require(role in {'migration', 'prebuilt-migration'}, 'Unexpected migration role')
    image_id = (root / ('beta3-tested-' + role + '.id')).read_text().strip()
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image_id), 'Invalid migration image ID')
    tag = 'dollhousemcp:' + role + '-linux-' + arch
    require(output('docker', 'image', 'inspect', '--format', '{{.Id}}', tag) == image_id, 'Migration tag drift')
    image = json.loads(output('docker', 'image', 'inspect', image_id))[0]
    require(image['Id'] == image_id and image['Os'] + '/' + image['Architecture'] == expected, 'Image identity mismatch')
    source = output('git', 'rev-parse', 'HEAD')
    tree = output('git', 'rev-parse', 'HEAD^{tree}')
    head = os.environ['EVIDENCE_HEAD_SHA']
    require(all(re.fullmatch(r'[a-f0-9]{40}', value) for value in (source, tree, head)), 'Invalid source identity')
    headers = output('git', 'cat-file', 'commit', 'HEAD').split('\n\n', 1)[0]
    parents = [line.split(' ', 1)[1] for line in headers.splitlines() if line.startswith('parent ')]
    require(all(re.fullmatch(r'[a-f0-9]{40}', parent) for parent in parents), 'Invalid checkout parent')
    require(source == os.environ['GITHUB_SHA'] and
            (source == head or (os.environ['GITHUB_EVENT_NAME'] == 'pull_request' and head in parents)),
            'Source not bound to workflow')
    require(not output('git', 'status', '--porcelain', '--untracked-files=no'), 'Tracked source changed')
    config = image['Config']
    require(config.get('Labels', {}).get('org.dollhousemcp.engine-proof-source') == source, 'Source label mismatch')
    require(config.get('User') == '1001:1001' and config.get('Entrypoint') in (None, []) and
            config.get('Cmd') == ['node', 'dist/cli/migrate-database.js'] and
            config.get('Healthcheck', {}).get('Test') == ['NONE'], 'Unexpected migration runtime')
    validate_environment(config, role)
    proof_bytes = (root / ('slim-' + role + '-proof.json')).read_bytes()
    require(len(proof_bytes) <= 65536, 'Fixture proof exceeds limit')
    proof = json.loads(proof_bytes)
    require(proof.get('source') == source and proof.get('migration') == image_id and all(
        proof.get(key) is True for key in ('fresh', 'kitHistoryEqual', 'schemaEqual', 'existingHistory', 'adminGuard', 'noOp', 'failureRollback', 'bootstrap', 'grants')),
        'Migration fixture proof mismatch')
    folder = root / ('beta3-' + role + '-evidence')
    folder.mkdir(mode=0o700)
    archive = folder / f'{role}-linux-{arch}.docker.tar'
    maximum = 1024**3 + 128 * 1024**2

    def limit_archive():
        resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))

    subprocess.run(['docker', 'image', 'save', '--output', str(archive), image_id],
                   check=True, timeout=120, preexec_fn=limit_archive)
    size = archive.stat().st_size
    require(0 < size <= maximum, 'Migration archive exceeds scanner intake limit')
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    sha = digest.hexdigest()
    (folder / 'SHA256SUMS').write_text(sha + '  ' + archive.name + '\n')
    (folder / 'fixture-proof.json').write_bytes(proof_bytes)
    metadata = {'formatVersion': 1, 'role': role, 'imageId': image_id, 'platform': expected,
                'nativeRunnerArch': platform.machine(), 'sourceHeadSha': head, 'testedCheckoutSha': source,
                'testedCheckoutTree': tree, 'testedCheckoutParents': parents, 'runId': os.environ['GITHUB_RUN_ID'],
                'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'], 'rootFsDiffIds': image['RootFS']['Layers'],
                'archive': archive.name, 'archiveSha256': sha, 'archiveBytes': size,
                'fixtureProofSha256': hashlib.sha256(proof_bytes).hexdigest(), 'environmentVerified': True,
                'runtimeWritableLayerIncluded': False}
    if role == 'prebuilt-migration':
        source_bytes = (root / 'prebuilt-source-proof.json').read_bytes()
        dist_bytes = (root / 'prebuilt-dist-sha256.txt').read_bytes()
        drain_bytes = (root / 'prebuilt-drain-proof.json').read_bytes()
        require(len(source_bytes) <= 65536 and len(dist_bytes) <= 16 * 1024**2 and len(drain_bytes) <= 1024**2,
                'Prebuilt evidence exceeds limit')
        prebuilt = json.loads(source_bytes)
        drain = json.loads(drain_bytes)
        require(prebuilt.get('source') == source and prebuilt.get('tree') == tree and
                prebuilt.get('builder') == proof.get('builder') and prebuilt.get('migration') == image_id and
                prebuilt.get('distManifestSha256') == hashlib.sha256(dist_bytes).hexdigest() and
                re.fullmatch(r'[a-f0-9]{64}', prebuilt.get('sourceArchiveSha256', '')),
                'Prebuilt source evidence mismatch')
        require(drain.get('source') == source and drain.get('image') == prebuilt.get('production') and
                drain.get('success') is True and drain.get('phase') == 'complete' and
                drain.get('networkRemoved') is True and drain.get('unsettledHelperResourcesRetained') is False,
                'Prebuilt drain proof mismatch')
        for filename, data in (('prebuilt-source-proof.json', source_bytes),
                               ('prebuilt-dist-sha256.txt', dist_bytes), ('prebuilt-drain-proof.json', drain_bytes)):
            (folder / filename).write_bytes(data)
        metadata['prebuiltSourceProofSha256'] = hashlib.sha256(source_bytes).hexdigest()
        metadata['prebuiltDistManifestSha256'] = hashlib.sha256(dist_bytes).hexdigest()
        metadata['prebuiltDrainProofSha256'] = hashlib.sha256(drain_bytes).hexdigest()
    (folder / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata))


if __name__ == '__main__':
    main()
