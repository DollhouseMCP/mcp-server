#!/usr/bin/env python3
"""Bind a locally pulled digest reference to the retained native Caddy graphs."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.dont_write_bytecode = True
from image_archive_identity import verify_saved_image_file
from image_scan_intake import unique_object

spec = importlib.util.spec_from_file_location('hosted_caddy_scanner_helpers', SCRIPTS / 'scan-built-image.py')
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)

REFERENCE = re.compile(r'[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}')
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}')
GRAPH_LIMIT = 1024 ** 3
ARCHIVE_LIMIT = GRAPH_LIMIT + 128 * 1024 ** 2
CONFIG_FIELDS = ('User', 'Env', 'Cmd', 'WorkingDir', 'Labels', 'ExposedPorts', 'Entrypoint', 'Volumes', 'OnBuild')


def native_architecture(daemon):
    if not isinstance(daemon, dict) or daemon.get('OSType') != 'linux': raise ValueError('Docker daemon is not Linux')
    arch = {'x86_64':'amd64', 'amd64':'amd64', 'aarch64':'arm64', 'arm64':'arm64'}.get(daemon.get('Architecture'))
    if arch is None: raise ValueError('Docker daemon architecture is unqualified')
    return arch


def validate_observation(reference, image, graph, approved, daemon):
    if not isinstance(reference, str) or not REFERENCE.fullmatch(reference):
        raise ValueError('Caddy image must be a registry digest reference')
    if not isinstance(image, dict) or not isinstance(image.get('Id'), str) or not IMAGE_ID.fullmatch(image['Id']):
        raise ValueError('Invalid inspected image identity')
    if not isinstance(image.get('RepoDigests'), list) or image['RepoDigests'].count(reference) != 1:
        raise ValueError('Inspected image is not bound to the exact registry digest reference')
    arch = image.get('Architecture')
    if image.get('Os') != 'linux' or arch not in approved['architectures'] or arch != native_architecture(daemon):
        raise ValueError('Unqualified Caddy architecture or operating system')
    expected = approved['architectures'][arch]
    actual_config = image.get('Config'); expected_config = expected['image_config']
    if not isinstance(actual_config, dict) or any(actual_config.get(k) != expected_config.get(k) for k in CONFIG_FIELDS):
        raise ValueError('Inspected Caddy image configuration differs from retained evidence')
    rootfs = image.get('RootFS')
    if not isinstance(rootfs, dict) or rootfs.get('Type') != 'layers' or rootfs.get('Layers') != expected['diff_ids']:
        raise ValueError('Inspected Caddy image layers differ from retained evidence')
    role = graph.get('store_id_role')
    role_digest = {'config': graph.get('config_digest'), 'manifest': graph.get('manifest_digest'), 'index': graph.get('root_digest')}.get(role)
    if (graph.get('store_id') != image['Id'] or role_digest != image['Id'] or graph.get('format') not in ('classic-docker', 'oci-with-docker-manifest') or
            graph.get('config_digest') != expected['config_digest'] or
            [layer.get('diff_id') for layer in graph.get('layers', [])] != expected['diff_ids']):
        raise ValueError('Saved Caddy image graph differs from retained evidence')
    return {'reference':reference, 'platform':'linux/'+arch, 'store_id':image['Id'],
            'store_id_role':graph['store_id_role'], 'manifest_digest':graph['manifest_digest'],
            'config_digest':graph['config_digest'], 'root_digest':graph.get('root_digest'),
            'admission_descriptor':graph.get('admission_descriptor'), 'diff_ids':expected['diff_ids'],
            'tested_checkout':approved['tested_checkout'], 'source_head':approved['source_head'],
            'workflow_run':approved['workflow_run'], 'workflow_attempt':approved['attempt']}


def qualify(reference):
    if not REFERENCE.fullmatch(reference): raise ValueError('Invalid Caddy reference')
    status, raw, _, error = scanner.bounded_process(['docker', 'info', '--format', '{{json .}}'], 10, 1024 * 1024, stderr_maximum=65536)
    if status != 0 or error: raise ValueError('Docker daemon identity unavailable')
    daemon = json.loads(raw, object_pairs_hook=unique_object)
    native_architecture(daemon)
    status, raw, _, error = scanner.bounded_process(['docker', 'image', 'inspect', reference], 10, 1024 * 1024, stderr_maximum=65536)
    if status != 0 or error: raise ValueError('Caddy image inspection unavailable')
    values = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise ValueError('Caddy image inspection must return one object')
    image = values[0]; arch = image.get('Architecture')
    if arch not in ('amd64', 'arm64') or image.get('Os') != 'linux': raise ValueError('Unqualified Caddy platform')
    with tempfile.TemporaryDirectory(prefix='hosted-caddy-archive-') as directory:
        path = Path(directory) / 'image.tar'
        status, _, _, error = scanner.bounded_process(['docker', 'image', 'save', reference], 180, ARCHIVE_LIMIT, path, stderr_maximum=65536)
        if status != 0 or error: raise ValueError('Bounded Caddy image export failed')
        with path.open('rb') as stream:
            graph = verify_saved_image_file(stream, image.get('Id'), GRAPH_LIMIT, image.get('Descriptor'), platform='linux/'+arch)
    approved_path = Path(__file__).with_name('caddy-qualified-native-graphs.json')
    approved = json.loads(approved_path.read_bytes(), object_pairs_hook=unique_object)
    return validate_observation(reference, image, graph, approved, daemon)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise ValueError('Expected one digest-qualified Caddy reference')
        print(json.dumps(qualify(sys.argv[1]), separators=(',', ':')))
    except Exception as error:
        print('Caddy image admission failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
