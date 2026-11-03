"""Run the unchanged full performance workload once, with one target observer."""
import hashlib, json, os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(os.environ['DIAG_TARGET_ROOT']); tool = pathlib.Path(os.environ['DIAG_TOOL_ROOT']); out = pathlib.Path(os.environ['DIAG_OUTPUT'])
files = ('stdout.txt', 'stderr.txt', 'phases.json', 'jest-results.json', 'performance-receipt.json')
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def git(directory, *args):
    return subprocess.run(['git', '-C', str(directory), *args], check=True, capture_output=True, text=True, timeout=10).stdout.strip()
manifest_path = tool / 'scripts/diagnostics/macos-performance/target-manifest.json'
manifest = json.loads(manifest_path.read_text())
def target_state():
    return {'head': git(root, 'rev-parse', 'HEAD'), 'status': git(root, 'status', '--porcelain'),
            'hashes': {name: digest(root / name) for name in manifest['files']}}
def valid(state):
    return state.get('head') == manifest['target_head'] and not state.get('status') and state.get('hashes') == manifest['files']
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
try: before = target_state()
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
    after = target_state()
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
