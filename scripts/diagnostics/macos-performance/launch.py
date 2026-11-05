"""Run the unchanged full performance workload once, with one target observer."""
import datetime, hashlib, json, math, os, pathlib, re, signal, stat, subprocess, sys, time
root = pathlib.Path(os.environ['DIAG_TARGET_ROOT']); tool = pathlib.Path(os.environ['DIAG_TOOL_ROOT']); out = pathlib.Path(os.environ['DIAG_OUTPUT'])
files = ('stdout.txt', 'stderr.txt', 'phases.json', 'jest-results.json', 'performance-receipt.json')
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def git(directory, *args):
    return subprocess.run(['git', '-C', str(directory), *args], check=True, capture_output=True, text=True, timeout=10).stdout.rstrip('\n')
manifest_path = tool / 'scripts/diagnostics/macos-performance/target-manifest.json'
manifest = json.loads(manifest_path.read_text())
def read_regular(base, name, limit):
    path = base / name
    root_info = base.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.getuid(): raise ValueError('Unowned or unsafe root')
    current = base
    for part in pathlib.PurePosixPath(name).parts[:-1]:
        current = current / part; info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid(): raise ValueError('Unowned or unsafe parent: ' + name)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) != 0o644 or before.st_size > limit:
        raise ValueError('Unsafe or oversized regular file: ' + name)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        def identity(value): return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if identity(before) != identity(opened): raise ValueError('File changed during open: ' + name)
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        if len(data) > limit or len(data) != opened.st_size or identity(opened) != identity(os.fstat(fd)) or identity(opened) != identity(path.lstat()):
            raise ValueError('File changed during read: ' + name)
        return bytes(data), {'sha256': hashlib.sha256(data).hexdigest(), 'identity': list(identity(opened))}
    finally: os.close(fd)

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate JSON key')
        result[key] = value
    return result

def timestamp(value, window):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z', value):
        raise ValueError('Invalid generator timestamp')
    instant = datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    if not window[0] <= instant <= window[1]: raise ValueError('Generator timestamp outside admitted build window')
    return value

def verify_generated(base, policy, window, build_type):
    if build_type not in ('git', 'npm'): raise ValueError('Unsupported BUILD_TYPE')
    expected_paths = set(policy['data_inputs']) | {'data/HASHES.json'}
    expected_dirs = {parent.as_posix() for name in expected_paths for parent in pathlib.PurePosixPath(name).parents if parent.as_posix() not in ('.', 'data')}
    found = set(); found_dirs = set()
    for directory, dirs, files in os.walk(base / 'data', followlinks=False):
        for name in dirs:
            entry = pathlib.Path(directory) / name
            info = entry.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid(): raise ValueError('Unowned or unsafe data directory')
            found_dirs.add(entry.relative_to(base).as_posix())
        for name in files:
            entry = pathlib.Path(directory) / name
            found.add(entry.relative_to(base).as_posix())
    if found != expected_paths or found_dirs != expected_dirs: raise ValueError('Data input path set mismatch')
    for name, record in {**policy['generators'], **policy['data_inputs']}.items():
        data, actual = read_regular(base, name, record['bytes'])
        if len(data) != record['bytes'] or actual['sha256'] != record['sha256'] or record['mode'] != '100644':
            raise ValueError('Pinned generator or data input differs: ' + name)
    package, _ = read_regular(base, 'package.json', 1024 * 1024)
    pkg = json.loads(package, object_pairs_hook=unique_object)
    version_bytes, version_identity = read_regular(base, 'src/generated/version.ts', 4096)
    text = version_bytes.decode('utf-8')
    pattern = r"/\*\*\n \* Auto-generated file - DO NOT EDIT\n \* Generated at build time by scripts/generate-version[.]js\n \*/\n\nexport const PACKAGE_VERSION = '([^']*)';\nexport const BUILD_TIMESTAMP = '([^']*)';\nexport const BUILD_TYPE: 'npm' [|] 'git' = '([^']*)';\nexport const PACKAGE_NAME = '([^']*)';\n"
    match = re.fullmatch(pattern, text)
    if not match or (match[1], match[3], match[4]) != (pkg['version'], build_type, pkg['name']): raise ValueError('Generated version template or fields mismatch')
    version_time = timestamp(match[2], window)
    hashes_bytes, hashes_identity = read_regular(base, 'data/HASHES.json', 1024 * 1024)
    document = json.loads(hashes_bytes, object_pairs_hook=unique_object)
    if not isinstance(document, dict) or set(document) != {'generated', 'files'} or document['files'] != {name.removeprefix('data/'): item['sha256'] for name, item in policy['data_inputs'].items()}:
        raise ValueError('Generated data hash map or schema mismatch')
    hashes_time = timestamp(document['generated'], window)
    return {'data/HASHES.json': {**hashes_identity, 'generated': hashes_time},
            'src/generated/version.ts': {**version_identity, 'generated': version_time, 'build_type': build_type,
                                         'package_version': pkg['version'], 'package_name': pkg['name']}}

def target_state(window, build_type):
    status = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
    entries = [entry for entry in status.split('\0') if entry]
    allowed = {' M data/HASHES.json', ' M src/generated/version.ts'}
    if len(entries) != len(set(entries)) or any(entry not in allowed for entry in entries): raise ValueError('Unexpected source status: ' + repr(entries))
    source = {name: digest(root / name) for name in manifest['files']}
    head = git(root, 'rev-parse', 'HEAD')
    if head != manifest['target_head'] or source != manifest['files']: raise ValueError('Immutable source identity mismatch')
    for name, expected in manifest['generated_source'].items():
        source_bytes = subprocess.run(['git', '-C', str(root), 'show', head + ':' + name], check=True, capture_output=True, timeout=10).stdout
        mode = git(root, 'ls-tree', head, '--', name).split()[0]
        if mode != expected['mode'] or len(source_bytes) != expected['bytes'] or hashlib.sha256(source_bytes).hexdigest() != expected['sha256']:
            raise ValueError('Committed generated-source identity mismatch')
    generated = verify_generated(root, manifest, window, build_type)
    return {'head': head, 'status': entries, 'hashes': source, 'generators': manifest['generators'],
            'data_inputs': manifest['data_inputs'], 'committed_generated_source': manifest['generated_source'],
            'generated_runtime': generated, 'build_type': build_type, 'build_window': list(window)}

def admission_window():
    admission_bytes, _ = read_regular(out, 'admission.json', 1024 * 1024)
    admission = json.loads(admission_bytes, object_pairs_hook=unique_object)
    if (admission.get('status') != 'admitted' or admission.get('diagnostic_head') != os.environ.get('GITHUB_SHA') or
        admission.get('tool_head') != os.environ.get('GITHUB_SHA') or admission.get('job') != os.environ.get('GITHUB_JOB') or
        admission.get('target_source_head') != manifest['target_head'] or admission.get('run_id') != os.environ.get('GITHUB_RUN_ID') or
        admission.get('run_attempt') != '1' or admission.get('ref') != os.environ.get('GITHUB_REF') or
        admission.get('target_hashes') != manifest['files']): raise ValueError('Same-run admission receipt mismatch')
    start = admission['host']['timestamp']; end = time.time()
    if type(start) not in (int, float) or not math.isfinite(start) or start > end: raise ValueError('Invalid admitted build window')
    return (start, end)

def valid(state): return 'error' not in state
tool_files = ['.github/workflows/core-build-test.yml', 'scripts/diagnostics/macos-performance/host.py',
              'scripts/diagnostics/macos-performance/launch.py', 'scripts/diagnostics/macos-performance/probe.mjs',
              'scripts/diagnostics/macos-performance/target-manifest.json', 'scripts/diagnostics/macos-performance/README.md']
binding = {'diagnostic_head': os.environ.get('GITHUB_SHA'), 'target_source_head': manifest['target_head'],
           'run_id': os.environ.get('GITHUB_RUN_ID'), 'attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
           'job': os.environ.get('GITHUB_JOB'), 'ref': os.environ.get('GITHUB_REF'),
           'tool_head': git(tool, 'rev-parse', 'HEAD'), 'tool_hashes': {name: digest(tool / name) for name in tool_files}}
if any((out / name).exists() for name in files): raise SystemExit('Prior output exists; refusing another attempt')
argv = ['npm', 'run', 'test:performance', '--', '--setupFilesAfterEnv', str(root / 'tests/jest.setup.mjs'), str(tool / 'scripts/diagnostics/macos-performance/probe.mjs'), '--json', '--outputFile=' + str(out / 'jest-results.json')]
env = dict(os.environ); env.pop('TEST_GITHUB_TOKEN', None)
receipt_start = time.monotonic(); child_start = None; child_elapsed = None; timed_out = False; code = None; error = None
try:
    window = admission_window(); build_type = os.environ.get('BUILD_TYPE') or 'git'
    before = target_state(window, build_type)
except Exception as exc: before = {'error': repr(exc)}
with (out / 'stdout.txt').open('wb') as stdout, (out / 'stderr.txt').open('wb') as stderr:
    try:
        if not valid(before) or binding['tool_head'] != binding['diagnostic_head'] or git(tool, 'status', '--porcelain'):
            raise ValueError('Source identity changed before performance')
        child_start = time.monotonic()
        child = subprocess.Popen(argv, cwd=root, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        try: code = child.wait(timeout=115)
        except subprocess.TimeoutExpired:
            timed_out = True; os.killpg(child.pid, signal.SIGTERM)
            try: code = child.wait(timeout=max(0.01, 120 - (time.monotonic() - child_start)))
            except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); code = child.poll()
    except Exception as exc: error = repr(exc)
    finally:
        if child_start is not None: child_elapsed = time.monotonic() - child_start
reasons = []
if timed_out or error: reasons.append('performance process timed out or could not launch')
performance_outcome = 'unavailable'
try:
    phases = json.loads((out / 'phases.json').read_text()); records = phases['records']
    counts = {name: sum(r['method'] == name for r in records) for name in ('query', 'search', 'build')}
    if phases['incomplete'] or phases['overlap'] or phases['active'] or counts != {'query':11,'search':11,'build':7}: reasons.append('incomplete or unexpected observer coverage')
    if sorted(r['buildLength'] for r in records if r['method'] == 'build') != [100,1000,1000,1000,1000,1000,5000]: reasons.append('unexpected build sizes')
    warm = [r for r in records if r['method'] == 'query' and r['query'] == 'engineering' and 'index build time is fast' in (r['test'] or '')]
    if len(warm) != 1: reasons.append('warm query missing')
    else:
        q = warm[0]
        if any(r['method'] == 'build' and r['queryId'] == q['queryId'] for r in records) or not q['before'] or not q['after'] or not q['before']['hasIndex'] or not q['before']['entries'] or q['before'] != q['after']: reasons.append('warm reuse not established')
    results = json.loads((out / 'jest-results.json').read_text())
    if (results.get('numTotalTests') != 120 or results.get('numPendingTests') != 0 or
        results.get('numTodoTests') != 0 or results.get('numTotalTestSuites') != 10):
        reasons.append('full suite coverage incomplete')
    performance_outcome = ('passed' if code == 0 and results.get('success') and
        results.get('numPassedTests') == 120 and results.get('numFailedTests') == 0 and
        results.get('numPendingTests') == 0 and results.get('numTodoTests') == 0 else 'failed')
except Exception as exc: reasons.append('missing or malformed result: ' + repr(exc))
try:
    after = target_state(window, build_type)
    if not valid(after) or after != before: reasons.append('target source drift')
except Exception as exc:
    after = {'error': repr(exc)}; reasons.append('target source verification failed')
receipt = {**binding, 'target_before': before, 'target_after': after, 'argv': argv, 'exit_code': code, 'timed_out': timed_out, 'error': error, 'child_wall_seconds': child_elapsed, 'receipt_elapsed_seconds': time.monotonic() - receipt_start,
           'diagnostic_coverage': 'inconclusive' if reasons else 'observed', 'coverage_reasons': reasons,
           'performance_outcome': performance_outcome,
           'observer_effects': 'Path check for all suites; target wrappers and CPU samples add overhead; async Promise continuation changes promise identity. CPU is process-wide; spans are inclusive and nested. GC event timing UNKNOWN.',
           'context': 'Full performance suite without prior ordinary unit shard; not a historical CI replay or qualification.'}
(out / 'performance-receipt.json').write_text(json.dumps(receipt, indent=2))
if reasons or performance_outcome != 'passed': sys.exit(1)
