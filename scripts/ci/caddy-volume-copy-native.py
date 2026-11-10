"""Exercise the real copier on disposable CI volumes; no admission claim."""
import json
from pathlib import Path
import re
import secrets
import sys
import time

if sys.version_info < (3, 11):
    raise RuntimeError('native copier fixture requires Python 3.11 or newer')

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'hosted-deploy'))
sys.path.insert(0, str(ROOT / 'scripts'))
from caddy_clone_action import docker_run
from caddy_image_admission import scanner
from caddy_volume_migration import (HELPER_IMAGE, require_helper_image, run_owned_helper,
                                    validate_copy_receipt, validate_helper_mounts)

ID = re.compile(r'[a-f0-9]{64}\Z')
CAPABILITY = re.compile(r'[A-Z0-9_]{1,48}\Z')


def name_filter(name):
    return 'name=^/' + name + '$'


class FixtureRunner:
    def __init__(self, image, names, started=None):
        self.image, self.names = image, names
        self.work_end = (time.monotonic() if started is None else started) + 90
        self.cleanup_end = self.work_end + 110
        self.active = {}
        self.start_stderr = ''
        self.capabilities = []

    def call(self, command, timeout, maximum, work=False):
        remaining = (self.work_end if work else self.cleanup_end) - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('native copier fixture budget exhausted')
        status, out, err, error = scanner.bounded_process(command, min(timeout, remaining), maximum,
                                                           stderr_maximum=65536)
        message = err.decode('utf-8', errors='replace')[:1024]
        if command[:2] == ['docker', 'start']:
            self.start_stderr = message
        if status != 0 or error:
            raise ValueError('fixture helper failed: ' + message)
        return out

    def observe(self, raw):
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
            return
        item = values[0]
        name = item.get('Name', '').removeprefix('/')
        if name not in self.active:
            return
        host = item.get('HostConfig')
        if not isinstance(host, dict):
            return
        identifier = item.get('Id')
        record = {'id': identifier if isinstance(identifier, str) and ID.fullmatch(identifier) else None, 'name': name}
        for key in ('CapAdd', 'CapDrop'):
            value = host.get(key)
            record[key] = value if isinstance(value, list) and len(value) <= 32 and all(
                isinstance(cap, str) and CAPABILITY.fullmatch(cap) for cap in value) else None
        self.capabilities.append(record)

    def run(self, command, timeout, maximum):
        raw = self.call(command, timeout, maximum, work=command[:2] in (['docker', 'create'], ['docker', 'start']))
        if command[:3] == ['docker', 'container', 'inspect']:
            self.observe(raw)
        if command[:2] == ['docker', 'create']:
            name = command[command.index('--name') + 1]
            identifier = raw.decode('ascii').strip()
            if name not in self.active or not ID.fullmatch(identifier):
                raise ValueError('helper create returned an invalid identity')
            self.active[name]['id'] = identifier
        return raw

    def cleanup(self, name):
        item = self.active[name]
        raw = self.call(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', name_filter(name)], 15, 65536)
        ids = raw.decode('ascii').splitlines()
        if not ids:
            del self.active[name]
            return
        if len(ids) != 1 or not ID.fullmatch(ids[0]) or (item['id'] is not None and ids[0] != item['id']):
            raise ValueError('owned helper identity is ambiguous')
        raw = self.call(['docker', 'container', 'inspect', ids[0]], 15, 1024 * 1024)
        self.observe(raw)
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != 1:
            raise ValueError('owned helper inspection is ambiguous')
        obj = values[0]
        config = obj.get('Config') or {}
        if (obj.get('Id') != ids[0] or obj.get('Name') != '/' + name or obj.get('Image') != self.image
                or config.get('Image') != HELPER_IMAGE or config.get('Labels', {}).get('org.dollhousemcp.caddy-clone-token') != item['token']
                or config.get('User') != '0:0' or config.get('Cmd') != ['node', '/caddy-volume-copy.mjs'] + ([item['mode']] if item['mode'] else [])):
            raise ValueError('refusing to remove an unverified helper')
        validate_helper_mounts(obj.get('Mounts'), self.names, ROOT / 'scripts/hosted-deploy/caddy_volume_copy.mjs', item['mode'])
        self.call(['docker', 'rm', '--force', ids[0]], 15, 65536)
        remaining = self.call(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', name_filter(name)], 15, 65536)
        if remaining.strip():
            raise ValueError('owned helper removal is not confirmed')
        del self.active[name]


def require_nonempty_refusal(error, runner):
    if runner.active:
        raise RuntimeError('owned helper cleanup remains UNKNOWN') from error
    if 'Caddy destination volume is not empty' not in str(error) + runner.start_stderr:
        raise error


def invoke(runner, helper, mode=None):
    runner.start_stderr = ''
    token = secrets.token_hex(16)
    name = 'dollhouse-caddy-copy-' + token
    existing = runner.call(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', name_filter(name)],
                           15, 65536, work=True)
    if existing.strip():
        raise ValueError('fixture helper name is already in use')
    runner.active[name] = {'token': token, 'id': None, 'mode': mode}
    try:
        raw = run_owned_helper(runner.run, runner.names, helper, token, runner.image, mode)
        result = validate_copy_receipt(json.loads(raw))
    except BaseException as original:
        if name in runner.active:
            try:
                runner.cleanup(name)
            except Exception as cleanup:
                original.add_note('Owned fixture helper cleanup is UNKNOWN: ' + str(cleanup))
        raise
    if name in runner.active:
        runner.cleanup(name)
    return result


def exercise_copy(runner, helper):
    before = invoke(runner, helper, '--verify-source')
    copied = invoke(runner, helper)
    after = invoke(runner, helper, '--verify-source')
    verified = invoke(runner, helper, '--verify')
    if before != copied or after != copied or verified != copied:
        raise ValueError('native source or copied inventory changed')
    try:
        invoke(runner, helper)
    except ValueError as error:
        require_nonempty_refusal(error, runner)
    else:
        raise ValueError('nonempty destination unexpectedly accepted a second copy')
    if invoke(runner, helper, '--verify') != copied:
        raise ValueError('refused reuse changed copied content')
    if runner.active:
        raise RuntimeError('owned helper cleanup remains UNKNOWN')
    return copied


def main():
    started = time.monotonic()
    negative = sys.argv[1:2] == ['--expect-unsafe-source']
    names = sys.argv[2:] if negative else sys.argv[1:]
    if len(names) != 4 or len(set(names)) != 4:
        raise ValueError('four distinct owned fixture volumes are required')
    helper = ROOT / 'scripts/hosted-deploy/caddy_volume_copy.mjs'
    image = require_helper_image(docker_run)
    runner = FixtureRunner(image, names[:2] if negative else names, started)

    try:
        if negative:
            try:
                invoke(runner, helper, '--verify-source')
            except ValueError as error:
                if runner.active or 'Unsafe Caddy volume directory' not in str(error) + runner.start_stderr:
                    raise
            else:
                raise ValueError('unsafe legacy mode was accepted')
            print(json.dumps({'unsafeSourceRefused': True, 'ownedCleanupConfirmed': not runner.active}))
            return
        # Same source-only production preflight; no target mounts or writes.
        preflight = FixtureRunner(image, names[:2], started)
        try:
            qualified = invoke(preflight, helper, '--verify-source')
            if qualified.get('legacy_directory_modes') != {'data/caddy': 0o1777, 'config/caddy': 0o1777}:
                raise ValueError('native fixture did not exercise exact root-owned legacy sticky dirs')
        finally:
            if preflight.capabilities:
                print(json.dumps({'sourceOnlyCapabilities': preflight.capabilities}), file=sys.stderr)
        copied = exercise_copy(runner, helper)
        if qualified != copied:
            raise ValueError('fixture source inventory changed between preflight and copy')
        print(json.dumps({'helperImageId': image, 'inventory': copied, 'sourceUnchanged': True,
                          'copiedVerified': True, 'nonemptyReuseRefused': True}, sort_keys=True))
    finally:
        if runner.capabilities:
            print(json.dumps({'ownedHelperCapabilities': runner.capabilities}, sort_keys=True), file=sys.stderr)


if __name__ == '__main__':
    main()
