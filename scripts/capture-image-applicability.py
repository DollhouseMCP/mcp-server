#!/usr/bin/env python3
"""Capture facts from a never-started target; never certify security closure."""
import datetime
import argparse
import sys
# Keep imports from creating untracked files in the validated scanner checkout.
sys.dont_write_bytecode = True
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time
import uuid
from image_scan_intake import validate_intake, trusted_work_root, verify_trusted_image, prepare_capture_output, read_scanner_provenance
from image_applicability import GIB, MAX_REPORT, inventory_export, validate_never_started

spec = importlib.util.spec_from_file_location('reviewed_image_scanner', Path(__file__).with_name('scan-built-image.py'))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)

# Hosted193d inventory:663 ELF files/196,374,524 bytes within existing scratch.
# Admission count only; all process/time/output/scratch bounds remain unchanged.
MAX_ELF_OBJECTS = 1024
DEFAULT_PLATFORM = 'linux/amd64'
RECEIPT_SUFFIX = '-receipt.json'
ELF_INDEX = 'elf-index.json'

# Trusted host Python only sets resource/env boundaries, then replaces itself
# with trusted /usr/bin/readelf. No target executable, loader or ldd is run.
READELF_LAUNCHER = """import os,resource,sys
resource.setrlimit(resource.RLIMIT_AS,(536870912,536870912))
resource.setrlimit(resource.RLIMIT_CPU,(5,5))
resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
os.execve('/usr/bin/readelf',['/usr/bin/readelf']+sys.argv[2:],{'PATH':'/usr/bin:/bin','HOME':sys.argv[1],'LC_ALL':'C','DEBUGINFOD_URLS':''})
"""


def create_command(name, store_id, nonce, platform=DEFAULT_PLATFORM):
    return ['docker', 'create', '--name', name, '--label', 'org.dollhousemcp.applicability-owner=' + nonce, '--pull', 'never', '--platform', platform,
            '--network', 'none', '--read-only', '--no-healthcheck', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges=true', '--user', '65532:65532',
            '--entrypoint', '/bin/false', store_id, 'capture-not-executed']


def cleanup_owned_capture(owner, graph, expected_id=None):
    """Resolve lost create receipts without guessing ownership or requiring disk I/O."""
    report = {'status': 'UNKNOWN', 'owned_name': owner['name'], 'expected_id': expected_id,
              'receipts': [], 'removal_invoked': False}
    def call(command, timeout):
        start = datetime.datetime.now(datetime.timezone.utc).isoformat()
        status, out, err, error = scanner.bounded_process(command, timeout, 1024 * 1024,
                                                        stderr_maximum=32768)
        report['receipts'].append({'command': command, 'started_utc': start,
            'finished_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'timeout_seconds': timeout, 'exit_code': status, 'capture_error': error,
            'stdout_sha256': hashlib.sha256(out).hexdigest(), 'stdout_bytes': len(out),
            'stderr': err.decode('utf-8', 'replace')})
        return status, out
    try:
        # One bounded read only: absent/late/ambiguous create remains UNKNOWN.
        # No retry, prefix match, force removal or candidate execution.
        status, raw = call(['docker', 'inspect', owner['name']], 10)
        if status != 0: raise ValueError('Exact owned-name resolve failed; late/missing create cannot be declared clean')
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != 1: raise ValueError('Owned name did not resolve exactly once')
        value = values[0]; resolved_id = value.get('Id', '')
        if len(resolved_id) != 64 or any(c not in '0123456789abcdef' for c in resolved_id):
            raise ValueError('Owned-name resolve lacks exact full container ID')
        if expected_id and resolved_id != expected_id: raise ValueError('Owned-name ID differs from successful create receipt')
        report['verified_identity'] = validate_never_started(value, graph, owner)
        report['resolved_id'] = resolved_id
        report['removal_invoked'] = True
        status, _ = call(['docker', 'rm', '--volumes', resolved_id], 20)
        if status != 0: raise ValueError('Exact verified-ID removal failed')
        report['status'] = 'verified-owned-container-removed'
    except Exception as error:
        report['reason'] = str(error)
    return report


def persist_terminal_summary(path, summary):
    try:
        path.write_text(json.dumps(summary, indent=2))
    except OSError as error:
        cleanup = summary.get('cleanup', {})
        # Keep a bounded terminal record in CI logs if the artifact filesystem
        # fails. Never print image Env/raw inspect or pretend reporting succeeded.
        fallback = {'schema': summary['schema'], 'status': 'incomplete-summary-persistence',
                    'finding_closure': False, 'cleanup': {key: cleanup.get(key) for key in
                    ['status', 'owned_name', 'resolved_id', 'removal_invoked', 'reason']}}
        print(json.dumps(fallback), file=sys.stderr, flush=True)
        raise RuntimeError('Capture summary persistence failed; bounded terminal state emitted to stderr') from error



def capture_elf_facts(elf, private, run, write, deadline):
    """Retain conservative coverage even if optional trusted data parsing fails."""
    elf_deadline = min(deadline, time.monotonic() + 60)
    def remaining():
        value = elf_deadline - time.monotonic()
        if value <= 0: raise ValueError('Total ELF phase deadline exceeded; unprocessed coverage UNKNOWN')
        return value
    results = [{'path': entry['path'], 'sha256': entry['sha256'],
                'receipt': 'elf-' + str(number) + RECEIPT_SUFFIX,
                'status': 'UNKNOWN-not-processed-or-bounded'}
               for number, entry in enumerate(elf[:MAX_ELF_OBJECTS])]
    index = {'objects': results, 'object_count': len(elf),
             'overlimit_unknown_count': max(0, len(elf) - MAX_ELF_OBJECTS),
             'processed_count': 0, 'unknown_count': len(elf),
             'phase_status': 'UNKNOWN-not-completed',
             'limits': {'object_count': MAX_ELF_OBJECTS, 'seconds': 60,
                        'child_seconds': 5, 'child_output_bytes': 8 * 1024 ** 2},
             'coverage': 'All paths/hashes remain in filesystem-inventory.json. Objects omitted by count or unprocessed after failure remain UNKNOWN.',
             'boundary': 'No ldd/loader execution. Dynamic symbols/DT_NEEDED do not prove static code absence or runtime resolution.'}
    # Persist before count/tool/deadline checks. A killed phase leaves a safe
    # UNKNOWN ledger; the earlier package/alias/archive facts stay independent.
    write(ELF_INDEX, index)
    try:
        if len(elf) > MAX_ELF_OBJECTS:
            raise ValueError('Selected ELF object count exceeds ' + str(MAX_ELF_OBJECTS) + ' bound; unprocessed coverage UNKNOWN')
        remaining()
        tool = Path('/usr/bin/readelf')
        if not tool.exists() or not tool.is_file() or tool.stat().st_size > 16 * 1024 ** 2 or tool.stat().st_uid != 0 or tool.stat().st_mode & 0o022:
            raise ValueError('Existing trusted host readelf is unavailable or unexpectedly writable')
        tool_hash = hashlib.sha256(tool.read_bytes()).hexdigest()
        remaining()
        home = private / 'empty-home'; home.mkdir(mode=0o700)
        command = ['/usr/bin/python3', '-I', '-c', READELF_LAUNCHER, str(home)]
        for label, args in [('tool-version', ['--version']), ('tool-help', ['--help'])]:
            status, _ = run(command + args, label, min(5, remaining()))
            if status != 0: raise ValueError('Host readelf tool metadata unavailable')
        remaining()
        write('readelf-tool.json', {'path': str(tool), 'resolved_path': str(tool.resolve()), 'sha256': tool_hash,
              'launcher_sha256': hashlib.sha256(READELF_LAUNCHER.encode()).hexdigest(),
              'limits': {'address_space_bytes': 536870912, 'cpu_seconds': 5, 'open_files': 64},
              'source_adoption': False, 'candidate_execution': False})
        remaining()
        for number, entry in enumerate(elf):
            remaining()
            path = Path(entry['scratch_data'])
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
                raise ValueError('Selected ELF data hash changed')
            status, _ = run(command + ['--file-header', '--program-headers', '--dynamic', '--notes', '--dyn-syms', '--wide', '--no-demangle', '--debug-dump=no-follow-links', '--debug-dump=do-not-use-debuginfod', str(path)],
                            'elf-' + str(number), min(5, remaining()), 8 * 1024 ** 2)
            results[number]['status'] = 'parsed-data' if status == 0 else 'UNKNOWN-parser-failed-or-bounded'
            index['processed_count'] += 1
        remaining()
        if any(row['status'] != 'parsed-data' for row in results):
            raise ValueError('ELF parser failed or reached a child bound; affected objects UNKNOWN')
        index['phase_status'] = 'all-admitted-parsed'
    finally:
        index['unknown_count'] = len(elf) - sum(row['status'] == 'parsed-data' for row in results)
        # Replacement can fail closed on report exhaustion. The initial UNKNOWN
        # ledger is already retained; never overwrite a prior scan or hide gaps.
        write(ELF_INDEX, index)
    return index


def validate_capture_engine(run):
    status, raw = run(['docker', 'version', '--format', '{{json .Server}}'], 'engine-source-identity')
    if status != 0: raise ValueError('Docker source identity unavailable')
    engine = json.loads(raw)
    if (engine.get('Version') != '29.4.2' or engine.get('GitCommit') not in
            ['d329809', 'd3298094ac5111e5d67517a252d291d27543e408'] or
            (engine.get('Os'), engine.get('Arch')) != ('linux', 'amd64')):
        raise ValueError('Docker exporter source is not the exact reviewed engine; capture unavailable')


def validate_capture_provenance(root, graph, archive_hash):
    provenance = read_scanner_provenance(root)
    if (not isinstance(provenance, dict) or provenance.get('target') != graph or
            provenance.get('image_archive_sha256') != archive_hash):
        raise ValueError('Target archive differs from scanner provenance')


def validate_capture_image(image, original, record):
    if image['Id'] != original['store_id'] or image.get('Config', {}).get('Volumes'):
        raise ValueError('Image identity or declared-volume scope is unsupported')
    source_label = image.get('Config', {}).get('Labels', {}).get('org.dollhousemcp.engine-proof-source')
    if record and source_label != record['source']:
        raise ValueError('Target source label differs from retained intake')
    if not record and os.environ.get('GITHUB_SHA') and source_label != os.environ['GITHUB_SHA']:
        raise ValueError('Target image source label differs from current qualification head')
    return source_label

def admit_capture_target(root, supplied, args, approved_target, run, write):
    original = json.loads((root / 'reports/target-archive-identity.json').read_text())
    if 'admission_descriptor' not in original: raise ValueError('Original archive admission descriptor unavailable')
    archive = root / 'inputs/image.tar'
    record = None
    if all(supplied):
        record, admitted_graph = validate_intake(args.retained_intake, args.intake_sha256, archive,
                                                   args.scanner_head, args.scanner_tree, os.environ.get('GITHUB_SHA'), Path(__file__).resolve().parent.parent, approved_target, staged=True)
        if original != admitted_graph: raise ValueError('Stored archive identity differs from admitted graph')
    validate_capture_engine(run)

    status, raw = run(['docker', 'image', 'inspect', original['store_id']], 'image-inspect', retain_stdout=False)
    if status != 0: raise ValueError('Exact target is unavailable')
    # Keep no image Env values. Full inspect bytes are private, not reported.
    image = json.loads(raw)[0]
    source_label = validate_capture_image(image, original, record)
    archive = root / 'inputs/image.tar'
    if record:
        record, graph = validate_intake(args.retained_intake, args.intake_sha256, archive,
                                        args.scanner_head, args.scanner_tree, os.environ.get('GITHUB_SHA'),
                                        Path(__file__).resolve().parent.parent, approved_target, staged=True,
                                        inspect_descriptor=image.get('Descriptor'))
        archive_hash = record['archive_sha256']
    else:
        graph, archive_hash = verify_trusted_image(root, 'target', image['Id'], GIB, original['admission_descriptor'],
                                                   include_hash=True, inspection_descriptor=image.get('Descriptor'))
    if graph != original: raise ValueError('Typed archive identity changed before capture')
    validate_capture_provenance(root, graph, archive_hash)
    write('target-binding.json', {'graph': graph, 'image_archive_sha256': archive_hash,
         'architecture': image.get('Architecture'), 'os': image.get('Os'),
         'original_image_user': image.get('Config', {}).get('User'),
         'source_label': image.get('Config', {}).get('Labels', {}).get('org.dollhousemcp.engine-proof-source'),
         'job': {key: os.environ.get(key) for key in ['GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']}})
    if (image.get('Architecture'), image.get('Os')) != ((record['platform'].split('/')[1] if record else 'amd64'), 'linux'):
        raise ValueError('Capture is qualified only for linux/amd64 target')
    return record, graph, source_label

def capture_export(container, graph, owner, private, run, write):
    for phase in ['before-export', 'after-export']:
        status, raw = run(['docker', 'inspect', container], phase, maximum=1024 * 1024, retain_stdout=False)
        if status != 0: raise ValueError('Never-started container inspect failed')
        value = json.loads(raw)[0]
        if value['Id'] != container: raise ValueError('Container inspect identity mismatch')
        write(phase + '-selected.json', validate_never_started(value, graph, owner))
        if phase == 'before-export':
            exported = private / 'final-rootfs.tar'
            status, _ = run(['docker', 'export', container], 'container-export', 60,
                            GIB + 128 * 1024 ** 2, exported)
            if status != 0: raise ValueError('Bounded final-rootfs export failed')
            exported.chmod(0o400)
    return exported

def export_owned_capture(private, graph, record, source_label, run, write, summary):
    container = None
    token = uuid.uuid4().hex
    owner = {'name': 'beta-applicability-' + token[:12], 'nonce': token, 'source_label': source_label}
    write('ownership-intent.json', {**owner, 'typed_store_id': graph['store_id'], 'creation_state': 'about-to-attempt',
          'note': 'Persisted before create; not authority to remove without exact identity verification'})
    create_attempted = False
    try:
        create_attempted = True  # Before child or receipt persistence can fail.
        summary['create_attempted'] = True
        status, raw = run(create_command(owner['name'], graph['store_id'], token, record['platform'] if record else DEFAULT_PLATFORM), 'container-create')
        identifier = raw.decode().strip()
        if len(identifier) != 64 or any(c not in '0123456789abcdef' for c in identifier):
            raise ValueError('Invalid exact container ID; cleanup identity unavailable')
        container = identifier
        if status != 0: raise ValueError('Create returned an exact owned ID but unsuccessful receipt; cleanup required')
        exported = capture_export(container, graph, owner, private, run, write)
    finally:
        if create_attempted:
            # Inspect/validate/remove happens BEFORE any diagnostics write.
            # A full disk or lost/malformed create output cannot bypass it.
            cleanup = cleanup_owned_capture(owner, graph, container)
            summary['cleanup'] = cleanup
            write('container-cleanup.json', cleanup)
            if cleanup['status'] != 'verified-owned-container-removed':
                raise ValueError('Capture cleanup UNKNOWN; inspect retained exact ownership intent')
    return exported, container

def capture_inventory_facts(exported, private, graph, container, deadline, reports, raw_budget, summary, run, write):
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
    archives = [e for e in entries if e.get('format', '').endswith('archive-candidate')]
    write('unresolved-archive-locations.json', {'archives': archives, 'status': 'UNKNOWN nested/packed contents not inspected'})
    summary.update(export_sha256=export_hash, entry_count=len(entries), elf_count=len(elf),
                   archive_candidate_count=len(archives))
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
    summary['public_metadata_capture'] = 'retained-before-ELF-phase'
    summary['elf_coverage_file'] = ELF_INDEX
    elf_index = capture_elf_facts(elf, private, run, write, deadline)
    summary.update(status='facts-captured-with-explicit-unresolved-boundaries',
                   elf_parse_unknown_count=elf_index['unknown_count'])

def persist_raw_capture(reports, raw_budget, label, stdout, stderr, retain_stdout):
    for suffix, data in [('stdout', stdout), ('stderr', stderr)]:
        if suffix == 'stdout' and not retain_stdout: continue
        if sum(p.stat().st_size for p in reports.iterdir() if p.is_file()) + len(data) > raw_budget:
            raise ValueError('Capture raw report budget exhausted')
        (reports / (label + '.' + suffix)).write_bytes(data)


def capture_report_functions(reports, raw_budget, deadline, summary):
    def write(name, value):
        data = json.dumps(value, indent=2).encode()
        if sum(p.stat().st_size for p in reports.iterdir() if p.is_file() and p.name != name) + len(data) > raw_budget:
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
        summary['receipts'][label] = {'file': label + RECEIPT_SUFFIX, 'exit_code': status, 'capture_error': error}
        persist_raw_capture(reports, raw_budget, label, stdout, stderr, retain_stdout)
        write(label + RECEIPT_SUFFIX, receipt)
        return status, stdout
    return write, run

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root')
    parser.add_argument('--retained-intake')
    parser.add_argument('--intake-sha256')
    parser.add_argument('--scanner-head')
    parser.add_argument('--scanner-tree')
    parser.add_argument('--target-source')
    parser.add_argument('--target-tree')
    parser.add_argument('--target-run-id')
    parser.add_argument('--target-attempt', type=int)
    parser.add_argument('--runtime-receipt-sha256')
    args = parser.parse_args()
    supplied = [args.retained_intake, args.intake_sha256, args.scanner_head, args.scanner_tree, args.target_source, args.target_tree, args.target_run_id, args.target_attempt, args.runtime_receipt_sha256]
    if any(supplied) and not all(supplied): raise ValueError('Complete retained intake arguments required')
    approved_target = {'source': args.target_source, 'tree': args.target_tree, 'run_id': args.target_run_id, 'attempt': args.target_attempt, 'runtime_receipt_sha256': args.runtime_receipt_sha256}
    root = trusted_work_root(args.root, create=True)
    reports, private = prepare_capture_output(root)
    deadline = time.monotonic() + 140  # Leave 30 seconds cleanup plus 10 seconds terminal receipt margin.
    raw_budget = MAX_REPORT - 1024 * 1024  # Reserve terminal facts even on output exhaustion.
    summary = {'schema': 'image-applicability-capture-v1', 'status': 'incomplete',
               'finding_closure': False, 'runtime_execution': False, 'receipts': {}}
    write, run = capture_report_functions(reports, raw_budget, deadline, summary)
    try:
        record, graph, source_label = admit_capture_target(root, supplied, args, approved_target, run, write)
        exported, container = export_owned_capture(private, graph, record, source_label, run, write, summary)
        capture_inventory_facts(exported, private, graph, container, deadline, reports, raw_budget, summary, run, write)
        return 0
    except Exception as error:
        summary['failure'] = str(error)
        return 1
    finally:
        # Reserve a small terminal receipt even when raw evidence fills the cap.
        persist_terminal_summary(reports / 'capture-summary.json', summary)


if __name__ == '__main__':
    sys.exit(main())
