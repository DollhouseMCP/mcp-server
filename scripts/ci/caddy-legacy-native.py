"""Rootful, disposable CI witness for the legacy proxy controls on real Caddy 2.8.4.

The recovery fixtures keep the private Caddy control boundary inert. This runs
the same production serving check against a real stock container and a private
receipt snapshot, then the exact stop and start that recovery issues, then the
serving check again on the new boot with no readiness wait, as recovery does.
A changed snapshot must be refused, so the comparison cannot pass by default.
It ends with the bounded stop form that proxy compensation uses.
It is not an operation receipt.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hosted-deploy'))
from caddy_active_config import LIMIT, system_docker, validate_system
from caddy_recovery_receipt import private_directory, write_exclusive
from caddy_volume_migration import inspect_one
import legacy_recovery_checks as checks
from legacy_recovery_guards import exact_container, lifecycle
from legacy_recovery_profile import profile

DIFFERENT = b'\n# A different snapshot must never match the serving configuration.\n:8082 {\n\trespond 204\n}\n'


def snapshot(parent, name, caddyfile):
    """A private receipt directory holding one Caddyfile, as a recovery receipt does."""
    path = Path(parent) / name
    os.mkdir(path, 0o700)
    directory = private_directory(path)
    try:
        write_exclusive(directory, 'Caddyfile', caddyfile)
    finally:
        os.close(directory)
    return path, {'caddyfile_sha256': hashlib.sha256(caddyfile).hexdigest()}


def acknowledged(output, identifier, operation):
    if output != (identifier + '\n').encode():
        raise ValueError('fixture Docker %s did not acknowledge its immutable ID' % operation)


def different_snapshot_refused(identifier, parent, caddyfile, boot):
    path, record = snapshot(parent, 'different', caddyfile + DIFFERENT)
    try:
        checks.serving_config(identifier, path, record, boot)
    except ValueError as error:
        if str(error) != 'recovered serving configuration differs from the original receipt':
            raise
        return True
    raise ValueError('a different receipt snapshot matched the serving configuration')


def witness(identifier, caddyfile, parent):
    before = inspect_one(system_docker, 'container', identifier)
    first, expected, name = lifecycle(before, True), profile(before), before['Name'][1:]
    receipt, record = snapshot(parent, 'receipt', caddyfile)
    checks.serving_config(identifier, receipt, record, first)
    refused = different_snapshot_refused(identifier, parent, caddyfile, first)
    acknowledged(system_docker(['docker', 'stop', '--signal', 'SIGTERM', '--timeout', '-1', identifier], 60, 65536),
                 identifier, 'stop')
    # lifecycle() requires exit status 0, so a forced or failed stop cannot pass.
    exact_container(system_docker, identifier, expected, name, False, first)
    acknowledged(system_docker(['docker', 'start', identifier], 30, 65536), identifier, 'start')
    started = time.monotonic()
    second = lifecycle(exact_container(system_docker, identifier, expected, name, True), True)
    if second['started_at'] == first['started_at'] or second['restart_count'] != first['restart_count']:
        raise ValueError('legacy start did not produce the expected single new boot')
    gap = time.monotonic() - started
    checks.serving_config(identifier, receipt, record, second)
    # Compensation stops a proxy with the older --time spelling, which current Docker deprecates.
    system_docker(['docker', 'stop', '--time', '5', identifier], 10, 65536)
    exact_container(system_docker, identifier, expected, name, False, second)
    return {'container': identifier, 'first_boot': first, 'second_boot': second, 'clean_stop': True,
            'bounded_stop': True, 'serving_checks': 2, 'different_snapshot_refused': refused,
            'seconds_between_start_and_serving_check': round(gap, 3),
            'caddyfile_sha256': record['caddyfile_sha256']}


def main():
    (identifier,) = sys.argv[1:]
    # The public fixture Caddyfile arrives on standard input; no path is taken from the caller.
    caddyfile = sys.stdin.buffer.read(LIMIT + 1)
    if not caddyfile or len(caddyfile) > LIMIT:
        raise ValueError('fixture Caddyfile is missing or exceeds its limit')
    validate_system()
    parent = tempfile.mkdtemp(prefix='caddy-legacy-witness-')
    try:
        print(json.dumps(witness(identifier, caddyfile, parent)))
    finally:
        shutil.rmtree(parent)


if __name__ == '__main__':
    main()
