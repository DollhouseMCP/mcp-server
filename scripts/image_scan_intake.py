"""Validate retained-image identity. This record does not grant execution authority."""
import hashlib
import json
import re
import subprocess
from pathlib import Path
from image_archive_identity import verify_saved_image

DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
HEX = re.compile(r'[0-9a-f]{64}')
COMMIT = re.compile(r'[0-9a-f]{40}')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate intake field')
        result[key] = value
    return result


def validate_intake(document, expected_hash, archive, scanner_head, scanner_tree, github_sha, checkout, approved_target):
    if not HEX.fullmatch(expected_hash) or not COMMIT.fullmatch(scanner_head) or not COMMIT.fullmatch(scanner_tree):
        raise ValueError('Invalid independent intake or scanner source binding')
    with Path(document).open('rb') as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError('Intake hash or size mismatch')
    record = json.loads(raw, object_pairs_hook=unique_object)
    fields = {'schema', 'source', 'tree', 'run_id', 'attempt', 'runtime_receipt_sha256', 'archive_sha256',
              'archive_bytes', 'platform', 'store_id', 'store_id_role', 'root_digest', 'manifest_digest',
              'config_digest', 'diff_ids', 'descriptor'}
    if not isinstance(record, dict) or set(record) != fields or record['schema'] != 'retained-image-intake-v1':
        raise ValueError('Unexpected or missing intake fields')
    if (set(approved_target) != {'source', 'tree', 'run_id', 'attempt', 'runtime_receipt_sha256'} or
        any(record[k] != approved_target[k] for k in approved_target) or
        not COMMIT.fullmatch(record['source']) or not COMMIT.fullmatch(record['tree']) or
        not isinstance(record['run_id'], str) or not re.fullmatch(r'[1-9][0-9]*', record['run_id']) or
        type(record['attempt']) is not int or record['attempt'] < 1):
        raise ValueError('Target approved source, run, attempt or receipt mismatch')
    if (not HEX.fullmatch(record['runtime_receipt_sha256']) or not HEX.fullmatch(record['archive_sha256']) or
        type(record['archive_bytes']) is not int or not 0 < record['archive_bytes'] <= 1024**3 + 128 * 1024**2 or
        record['platform'] not in ('linux/amd64', 'linux/arm64') or record['store_id_role'] not in ('index', 'manifest', 'config') or
        not DIGEST.fullmatch(record['store_id']) or not DIGEST.fullmatch(record['config_digest']) or
        any(x is not None and not DIGEST.fullmatch(x) for x in (record['root_digest'], record['manifest_digest'])) or
        not isinstance(record['diff_ids'], list) or not record['diff_ids'] or len(record['diff_ids']) > 256 or
        any(not isinstance(x, str) or not DIGEST.fullmatch(x) for x in record['diff_ids'])):
        raise ValueError('Malformed target identity tuple')
    if Path(__file__).resolve().parent != Path(checkout).resolve() / 'scripts':
        raise ValueError('Intake helper does not belong to scanner checkout')
    def git(*args):
        return subprocess.run(['git', '-C', str(checkout), *args], check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=10).stdout.decode().strip()
    if github_sha != scanner_head or git('rev-parse', 'HEAD') != scanner_head or git('rev-parse', 'HEAD^{tree}') != scanner_tree:
        raise ValueError('Scanner source head/tree/GITHUB_SHA mismatch')
    if git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Scanner checkout has modified or untracked files')
    archive = Path(archive)
    if archive.stat().st_size != record['archive_bytes']:
        raise ValueError('Archive size mismatch')
    with archive.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != record['archive_sha256']:
            raise ValueError('Archive hash mismatch')
    graph = verify_saved_image(archive, record['store_id'], 1024**3, record['descriptor'],
                               platform=record['platform'], expected_source=record['source'])
    for field in ('store_id', 'store_id_role', 'root_digest', 'manifest_digest', 'config_digest'):
        if graph[field] != record[field]: raise ValueError('Typed archive identity mismatch: ' + field)
    if [x['diff_id'] for x in graph['layers']] != record['diff_ids']:
        raise ValueError('Ordered DiffIDs mismatch')
    return record, graph
