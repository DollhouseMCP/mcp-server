#!/usr/bin/env python3
"""Capture facts from a never-started target; never certify security closure."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid
from image_archive_identity import verify_saved_image
from image_applicability import GIB, MAX_REPORT, inventory_export, validate_never_started

spec = importlib.util.spec_from_file_location('reviewed_image_scanner', Path(__file__).with_name('scan-built-image.py'))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)

# Trusted host Python only sets resource/env boundaries, then replaces itself
# with trusted /usr/bin/readelf. No target executable, loader or ldd is run.
READELF_LAUNCHER = """import os,resource,sys
resource.setrlimit(resource.RLIMIT_AS,(536870912,536870912))
resource.setrlimit(resource.RLIMIT_CPU,(5,5))
resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
os.execve('/usr/bin/readelf',['/usr/bin/readelf']+sys.argv[2:],{'PATH':'/usr/bin:/bin','HOME':sys.argv[1],'LC_ALL':'C','DEBUGINFOD_URLS':''})
"""


def create_command(name, store_id):
    return ['docker', 'create', '--name', name, '--pull', 'never', '--platform', 'linux/amd64',
            '--network', 'none', '--read-only', '--no-healthcheck', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges=true', '--user', '65532:65532',
            '--entrypoint', '/bin/false', store_id, 'capture-not-executed']


def main():
    root = Path(sys.argv[1]).resolve()
    reports = root / 'reports/applicability'; reports.mkdir(parents=True, exist_ok=False)
    private = root / 'applicability-inputs'; private.mkdir(mode=0o700, exist_ok=False)
    deadline = time.monotonic() + 140  # Leave 30 seconds cleanup plus 10 seconds terminal receipt margin.
    raw_budget = MAX_REPORT - 1024 * 1024  # Reserve terminal facts even on output exhaustion.
    summary = {'schema': 'image-applicability-capture-v1', 'status': 'incomplete',
               'finding_closure': False, 'runtime_execution': False, 'receipts': {}}
    def write(name, value):
        data = json.dumps(value, indent=2).encode()
        if sum(p.stat().st_size for p in reports.iterdir() if p.is_file()) + len(data) > raw_budget:
            raise ValueError('Complete capture report budget exhausted')
        (reports / name).write_bytes(data)
    def run(command, label, timeout=30, maximum=1024 * 1024, stream=None, cleanup=False, retain_stdout=True):
        remaining = deadline - time.monotonic()
        if not cleanup and remaining <= 0: raise ValueError('Capture overall deadline exceeded')
        actual_timeout = timeout if cleanup else min(timeout, max(0.1, remaining))
        start = datetime.datetime.now(datetime.timezone.utc).isoformat()
        status, stdout, stderr, error = scanner.bounded_process(command, actual_timeout, maximum, stream, stderr_maximum=1024 * 1024)
        receipt = {'command': command, 'started_utc': start,
                   'finished_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'exit_code': status, 'capture_error': error, 'timeout_seconds': actual_timeout,
                   'maximum_combined_bytes': maximum}
        summary['receipts'][label] = {'file': label + '-receipt.json', 'exit_code': status, 'capture_error': error}
        for suffix, data in [('stdout', stdout), ('stderr', stderr)]:
            if suffix == 'stdout' and not retain_stdout: continue
            if sum(p.stat().st_size for p in reports.iterdir() if p.is_file()) + len(data) > raw_budget:
                raise ValueError('Capture raw report budget exhausted')
            (reports / (label + '.' + suffix)).write_bytes(data)
        write(label + '-receipt.json', receipt)
        return status, stdout
    try:
        original = json.loads((root / 'reports/target-archive-identity.json').read_text())
        status, raw = run(['docker', 'version', '--format', '{{json .Server}}'], 'engine-source-identity')
        if status != 0: raise ValueError('Docker source identity unavailable')
        engine = json.loads(raw)
        if (engine.get('Version') != '29.4.2' or engine.get('GitCommit') not in
                ['d329809', 'd3298094ac5111e5d67517a252d291d27543e408'] or
                (engine.get('Os'), engine.get('Arch')) != ('linux', 'amd64')):
            raise ValueError('Docker exporter source is not the exact reviewed engine; capture unavailable')

        status, raw = run(['docker', 'image', 'inspect', original['store_id']], 'image-inspect', retain_stdout=False)
        if status != 0: raise ValueError('Exact target is unavailable')
        # Keep no image Env values. Full inspect bytes are private, not reported.
        image = json.loads(raw)[0]
        if image['Id'] != original['store_id'] or image.get('Config', {}).get('Volumes'):
            raise ValueError('Image identity or declared-volume scope is unsupported')
        source_label = image.get('Config', {}).get('Labels', {}).get('org.dollhousemcp.engine-proof-source')
        if os.environ.get('GITHUB_SHA') and source_label != os.environ['GITHUB_SHA']:
            raise ValueError('Target image source label differs from current qualification head')
        archive = root / 'inputs/image.tar'
        graph = verify_saved_image(archive, image['Id'], GIB, image.get('Descriptor'))
        if graph != original: raise ValueError('Typed archive identity changed before capture')
        with archive.open('rb') as source:
            archive_hash = hashlib.file_digest(source, 'sha256').hexdigest()
        write('target-binding.json', {'graph': graph, 'image_archive_sha256': archive_hash,
             'architecture': image.get('Architecture'), 'os': image.get('Os'),
             'original_image_user': image.get('Config', {}).get('User'),
             'source_label': image.get('Config', {}).get('Labels', {}).get('org.dollhousemcp.engine-proof-source'),
             'job': {key: os.environ.get(key) for key in ['GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']}})
        if (image.get('Architecture'), image.get('Os')) != ('amd64', 'linux'):
            raise ValueError('Capture is qualified only for linux/amd64 target')
        container = None
        try:
            status, raw = run(create_command('beta-applicability-' + uuid.uuid4().hex[:12], graph['store_id']), 'container-create')
            identifier = raw.decode().strip()
            if len(identifier) != 64 or any(c not in '0123456789abcdef' for c in identifier):
                raise ValueError('Invalid exact container ID; cleanup identity unavailable')
            container = identifier
            if status != 0: raise ValueError('Create returned an exact owned ID but unsuccessful receipt; cleanup required')
            for phase in ['before-export', 'after-export']:
                status, raw = run(['docker', 'inspect', container], phase, maximum=1024 * 1024, retain_stdout=False)
                if status != 0: raise ValueError('Never-started container inspect failed')
                value = json.loads(raw)[0]
                if value['Id'] != container: raise ValueError('Container inspect identity mismatch')
                write(phase + '-selected.json', validate_never_started(value, graph))
                if phase == 'before-export':
                    exported = private / 'final-rootfs.tar'
                    status, _ = run(['docker', 'export', container], 'container-export', 60,
                                    GIB + 128 * 1024 ** 2, exported)
                    if status != 0: raise ValueError('Bounded final-rootfs export failed')
                    exported.chmod(0o400)
        finally:
            if container:
                status, _ = run(['docker', 'rm', '--volumes', container], 'container-cleanup', 30, cleanup=True)
                if status != 0: raise ValueError('Exact capture container cleanup failed')
        with exported.open('rb') as source:
            export_hash = hashlib.file_digest(source, 'sha256').hexdigest()
        inventory = inventory_export(exported, private / 'selected-data', deadline=deadline)
        write('filesystem-inventory.json', inventory)
        entries = inventory['entries']
        write('export-binding.json', {'sha256': export_hash, 'bytes': exported.stat().st_size,
              'typed_target_store_id': graph['store_id'], 'container_id': container,
              'trust_boundary': 'Reviewed Docker daemon materializes selected image filesystem; no candidate process started'})
        write('predicate-surfaces.json', {
            'privileged_metadata': [e for e in entries if e['mode'] & 0o6000 or e.get('capability_base64') is not None],
            'named_tool_variants': [e for e in entries if any(Path(e['path']).name.startswith(name) for name in
                ['infocmp', 'nsenter', 'mount', 'umount', 'getfacl', 'setfacl', 'chacl'])],
            'perl_and_package_data': [e for e in entries if e.get('scratch_data') and e.get('format') != 'elf'],
            'native_module_paths': [e for e in entries if e['path'].endswith('.node')],
            'aliases': inventory['aliases'],
            'limits': 'Names identify candidate surfaces only; full file hashes support independent renamed-copy/reference comparison. Missing caps, unparsed archives, modified/compiled copies and actual runtime callers stay UNKNOWN.'})
        elf = [e for e in entries if e.get('format') == 'elf']
        if len(elf) > 256: raise ValueError('Selected ELF object count exceeds 256 bound')
        archives = [e for e in entries if e.get('format', '').endswith('archive-candidate')]
        write('unresolved-archive-locations.json', {'archives': archives, 'status': 'UNKNOWN nested/packed contents not inspected'})
        tool = Path('/usr/bin/readelf')
        if not tool.exists() or not tool.is_file() or tool.stat().st_size > 16 * 1024 ** 2 or tool.stat().st_uid != 0 or tool.stat().st_mode & 0o022:
            raise ValueError('Existing trusted host readelf is unavailable or unexpectedly writable')
        tool_hash = hashlib.sha256(tool.read_bytes()).hexdigest()
        home = private / 'empty-home'; home.mkdir(mode=0o700)
        command = ['/usr/bin/python3', '-I', '-c', READELF_LAUNCHER, str(home)]
        for label, args in [('tool-version', ['--version']), ('tool-help', ['--help'])]:
            status, _ = run(command + args, label, 5)
            if status != 0: raise ValueError('Host readelf tool metadata unavailable')
        write('readelf-tool.json', {'path': str(tool), 'resolved_path': str(tool.resolve()), 'sha256': tool_hash,
              'launcher_sha256': hashlib.sha256(READELF_LAUNCHER.encode()).hexdigest(),
              'limits': {'address_space_bytes': 536870912, 'cpu_seconds': 5, 'open_files': 64},
              'source_adoption': False, 'candidate_execution': False})
        elf_deadline = min(deadline, time.monotonic() + 60)
        results = []
        for number, entry in enumerate(elf):
            if time.monotonic() >= elf_deadline: raise ValueError('Total ELF phase deadline exceeded')
            path = Path(entry['scratch_data'])
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
                raise ValueError('Selected ELF data hash changed')
            status, _ = run(command + ['--file-header', '--program-headers', '--dynamic', '--notes', '--dyn-syms', '--wide', '--no-demangle', '--debug-dump=no-follow-links', '--debug-dump=do-not-use-debuginfod', str(path)],
                            'elf-' + str(number), min(5, elf_deadline - time.monotonic()), 8 * 1024 ** 2)
            results.append({'path': entry['path'], 'sha256': entry['sha256'], 'receipt': 'elf-' + str(number) + '-receipt.json',
                            'status': 'parsed-data' if status == 0 else 'UNKNOWN-parser-failed-or-bounded'})
        write('elf-index.json', {'objects': results, 'boundary': 'No ldd/loader execution. Dynamic symbols/DT_NEEDED do not prove static code absence or runtime resolution.'})
        # Only exact whitelisted public package/module data; never upload rootfs,
        # ELF binaries, arbitrary application contents, image Env or credentials.
        for entry in entries:
            if entry.get('scratch_data') and entry.get('format') != 'elf':
                path = Path(entry['scratch_data'])
                if path.stat().st_size > raw_budget: raise ValueError('Raw metadata report exceeds cap')
                data = path.read_bytes()
                if sum(p.stat().st_size for p in reports.iterdir() if p.is_file()) + len(data) > raw_budget:
                    raise ValueError('Raw metadata aggregate exceeds report cap')
                (reports / ('data-' + entry['sha256'] + '.raw')).write_bytes(data)
        summary.update(status='facts-captured-with-explicit-unresolved-boundaries', export_sha256=export_hash,
                       entry_count=len(entries), elf_count=len(elf), archive_candidate_count=len(archives),
                       elf_parse_unknown_count=sum(x['status'] != 'parsed-data' for x in results))
        return 0
    except Exception as error:
        summary['failure'] = str(error)
        return 1
    finally:
        # Reserve a small terminal receipt even when raw evidence fills the cap.
        (reports / 'capture-summary.json').write_text(json.dumps(summary, indent=2))


if __name__ == '__main__':
    sys.exit(main())
