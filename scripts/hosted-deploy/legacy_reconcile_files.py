"""Durable, preserving source/control-file moves for qualified reconciliation."""
import os
from pathlib import Path
import shutil

from caddy_bundle_identity import bundle_identity
from caddy_recovery_receipt import private_directory, write_exclusive
import legacy_handoff as handoff
from legacy_recovery_boundary import FILES, read_configuration, verify_live_files


def absent(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise ValueError('reconciliation destination already exists')


def save(path, name, data):
    directory = private_directory(path)
    try:
        write_exclusive(directory, name, data)
        os.fsync(directory)
    finally:
        os.close(directory)


def record(path, name, value):
    save(path, name + '.json', handoff.encoded(value))


def sync_path(path, directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else os.O_NONBLOCK)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sync_bundle(path):
    for directory, _, files in os.walk(path, topdown=False, followlinks=False):
        for name in files:
            sync_path(Path(directory) / name)
        sync_path(directory, directory=True)


def prepare_source(root, operation, previous, expected):
    if previous.parent != root or bundle_identity(previous) != expected:
        raise ValueError('qualified original source changed before copying')
    capacity = os.statvfs(root)
    if capacity.f_bavail * capacity.f_frsize < expected['bytes'] * 2 + 128 * 1024 * 1024:
        raise ValueError('insufficient free space to preserve and reconcile source')
    candidate = operation / 'server.candidate'
    absent(candidate)
    # Source and candidate are inside protected deployment ancestry. Never
    # follow a symlink or install a copy that differs from the non-following
    # bundle identity, including every relative path and mode.
    shutil.copytree(previous, candidate, symlinks=True)
    if bundle_identity(candidate) != expected or bundle_identity(previous) != expected:
        raise ValueError('copied legacy source differs from its qualified original')
    sync_bundle(candidate)
    return candidate


def metadata(raw, mode):
    return {'sha256': handoff.digest(raw), 'mode': mode, 'bytes': len(raw)}


def live_inventory(root):
    result = {}
    for name in FILES:
        try:
            raw, mode = read_configuration(root, name)
        except FileNotFoundError:
            result[name] = None
        else:
            result[name] = metadata(raw, mode)
    return result


def stage_files(operation, files, compose):
    original = operation / 'original-files'
    staged = operation / 'staged-files'
    original.mkdir(mode=0o700)
    staged.mkdir(mode=0o700)
    for name, (raw, _) in files.items():
        save(original, name, raw)
    save(operation, 'qualified-compose.json', compose)
    selected = {**files, 'compose.yml': (compose, 0o600)}
    result = {}
    for name in FILES:
        if name not in selected:
            result[name] = None
            continue
        raw, mode = selected[name]
        save(staged, name, raw)
        (staged / name).chmod(mode)
        sync_path(staged / name)
        result[name] = metadata(raw, mode)
    verify_live_files(staged, result)
    sync_path(staged, directory=True)
    sync_path(operation, directory=True)
    return staged, result


def move(source, destination, operation, name):
    absent(destination)
    record(operation, name + '-issued', {'source': str(source), 'destination': str(destination)})
    os.rename(source, destination)
    sync_path(source.parent, directory=True)
    if destination.parent != source.parent:
        sync_path(destination.parent, directory=True)
    record(operation, name + '-acknowledged', {'destination': str(destination)})


def install(root, operation, candidate, staged, before_source, after_source, before_files, after_files):
    if bundle_identity(root / 'server') != before_source or bundle_identity(candidate) != after_source:
        raise ValueError('reconciliation source changed before installation')
    verify_live_files(root, before_files)
    verify_live_files(staged, after_files)
    failed = operation / 'failed-files'
    failed.mkdir(mode=0o700)
    move(root / 'server', operation / 'failed-server', operation, 'retain-failed-source')
    move(candidate, root / 'server', operation, 'install-original-source')
    for index, name in enumerate(FILES):
        verify_live_files(root, {name: before_files[name]})
        if before_files[name] == after_files[name]:
            continue
        if before_files[name] is not None:
            move(root / name, failed / name, operation, 'retain-file-' + str(index))
        if after_files[name] is not None:
            verify_live_files(staged, {name: after_files[name]})
            move(staged / name, root / name, operation, 'install-file-' + str(index))
    if bundle_identity(root / 'server') != after_source or bundle_identity(operation / 'failed-server') != before_source:
        raise ValueError('reconciled source read-back differs')
    verify_live_files(root, after_files)
    verify_live_files(failed, {name: expected if expected != after_files[name] else None
                               for name, expected in before_files.items()})
