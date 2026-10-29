#!/usr/bin/env python3
"""Test-only source/image/failure receipts. No target execution or secret capture."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def write(root, name, value):
    temporary = root / (name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(root / name)


def identity():
    return {key: os.environ[key] for key in
            ['GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']}


def main():
    mode, directory, platform, *arguments = sys.argv[1:]
    root = Path(directory)
    if mode == 'init':
        write(root, 'invocation.json', {'source': identity(), 'platform': platform,
              'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'security_scope': 'PARTIAL runtime only; scanner authority absent; release HOLD'})
        write(root, 'completion.json', {'source': identity(), 'platform': platform,
              'state': 'IN_PROGRESS_OR_TERMINATION_UNOBSERVED', 'exit_status': None})
    elif mode == 'phase':
        name, state, status = arguments
        path = root / 'phases.json'
        phases = json.loads(path.read_text()) if path.exists() else []
        phases.append({'phase': name, 'state': state, 'exit_status': None if status == '-' else int(status),
                       'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        write(root, 'phases.json', phases)
    elif mode == 'bind':
        images, errors = {}, {}
        # Select fields in the daemon; never retrieve Config.Env or credentials.
        template = '{"Id":{{json .Id}},"Architecture":{{json .Architecture}},"Os":{{json .Os}},"Size":{{json .Size}},"RootFS":{{json .RootFS}},"labels":{{json .Config.Labels}}}'
        for stage, image in zip(['builder', 'production', 'node-base'], arguments):
            try:
                raw = subprocess.check_output(['docker', 'image', 'inspect', '--format', template, image], timeout=10)
                if len(raw) > 1024 * 1024:
                    raise ValueError('Selected image facts exceed receipt bound')
                value = json.loads(raw)
                if (not re.fullmatch(r'sha256:[0-9a-f]{64}', value['Id']) or
                        value['Architecture'] != platform.split('/')[1] or value['Os'] != 'linux'):
                    raise ValueError('Actual image identity/platform differs')
                value['tag_at_binding'] = image
                value['probe_execution_id'] = value['Id']
                images[stage] = value
            except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
                errors[stage] = str(error)
        name = 'source-image-binding.json' if len(arguments) == 3 else 'source-images-before-base-build.json'
        write(root, name, {'source': identity(), 'platform': platform, 'images': images,
              'errors': errors, 'bound_before_runtime_probes': True})
        if errors:
            raise SystemExit('Image binding incomplete; probes refused')
    elif mode == 'image-id':
        value = json.loads((root / 'source-image-binding.json').read_text())
        print(value['images'][arguments[0]]['probe_execution_id'])
    elif mode == 'cleanup':
        name = arguments[0]
        result = {'container': name, 'state': 'UNKNOWN'}
        try:
            def present():
                raw = subprocess.check_output(['docker', 'container', 'ls', '-a', '--format', '{{.Names}}'], timeout=5)
                if len(raw) > 1024 * 1024:
                    raise ValueError('Container list exceeds cleanup bound')
                return name in raw.decode().splitlines()
            if present():
                subprocess.run(['docker', 'rm', '-f', name], timeout=10, check=True, stdout=subprocess.DEVNULL)
                if present():
                    raise ValueError('Owned container remains after removal')
                result['state'] = 'REMOVED_AND_ABSENCE_OBSERVED'
            else:
                result['state'] = 'ABSENCE_OBSERVED'
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            result['error'] = str(error)
        write(root, 'cleanup.json', result)
        if result['state'] == 'UNKNOWN':
            raise SystemExit(1)
    elif mode == 'finalize':
        status, phase, cleanup_status = arguments
        files, total, complete = {}, 0, True
        started = time.monotonic()
        for path in sorted(root.rglob('*')):
            if path.is_file() and path.name not in ['completion.json', 'completion.json.tmp']:
                size = path.stat().st_size
                if len(files) >= 64 or size > 32 * 1024 ** 2 or total + size > 64 * 1024 ** 2 or time.monotonic() - started > 10:
                    complete = False
                    break
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                files[str(path.relative_to(root))] = {'bytes': size, 'sha256': digest.hexdigest()}
                total += size
        write(root, 'completion.json', {'source': identity(), 'platform': platform,
              'state': 'TERMINAL_OBSERVED', 'hash_inventory_complete': complete,
              'exit_status': int(status) or (1 if int(cleanup_status) or not complete else 0),
              'probe_exit_status': int(status), 'last_phase': phase, 'cleanup_status': int(cleanup_status),
              'completed_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'files': files, 'qualification': 'PARTIAL runtime proof only; scanner/release HOLD'})
        if not complete:
            raise SystemExit('Evidence hash inventory exceeded explicit bounds; no complete claim')
    else:
        raise SystemExit('Unknown evidence operation')


if __name__ == '__main__':
    main()
