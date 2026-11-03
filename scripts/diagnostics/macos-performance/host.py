"""Record allowlisted host facts and refuse mismatched diagnostic hosts."""
import hashlib, json, os, pathlib, platform, resource, subprocess, sys, time
out = pathlib.Path(os.environ['DIAG_OUTPUT']); out.mkdir(parents=True, exist_ok=True)
target = pathlib.Path(os.environ['DIAG_TARGET_ROOT']); tool = pathlib.Path(os.environ['DIAG_TOOL_ROOT'])
def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=10).stdout.strip()
def git(root, *args): return command('git', '-C', str(root), *args)
def snapshot():
    limits = {name: list(resource.getrlimit(getattr(resource, name))) for name in ('RLIMIT_NOFILE', 'RLIMIT_CPU', 'RLIMIT_AS')}
    return {'timestamp': time.time(), 'uname': command('uname', '-a'), 'sw_vers': command('sw_vers'),
            'cpu_count': os.cpu_count(), 'load': os.getloadavg(), 'uptime': command('sysctl', '-n', 'kern.boottime'),
            'memory_bytes': command('sysctl', '-n', 'hw.memsize'), 'cpu': command('sysctl', '-n', 'machdep.cpu.brand_string'),
            'limits': limits}
def node_facts():
    data = command('node', '-p', 'JSON.stringify({execPath:process.execPath,versions:process.versions,arch:process.arch,platform:process.platform})')
    return json.loads(data)
phase = sys.argv[1]
if phase == 'after':
    (out / 'host-after.json').write_text(json.dumps(snapshot(), indent=2)); sys.exit(0)
receipt = {'status': 'refused', 'diagnostic_head': os.environ.get('GITHUB_SHA'), 'target_source_head': None,
           'run_id': os.environ.get('GITHUB_RUN_ID'), 'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
           'job': os.environ.get('GITHUB_JOB'), 'ref': os.environ.get('GITHUB_REF'),
           'runner_os': os.environ.get('RUNNER_OS'), 'runner_arch': os.environ.get('RUNNER_ARCH'),
           'image_os': os.environ.get('ImageOS'), 'image_version': os.environ.get('ImageVersion'),
           'image_id': 'UNKNOWN', 'runner_version': 'UNKNOWN', 'gc_timing': 'UNKNOWN'}
try:
    manifest = json.loads((tool / 'scripts/diagnostics/macos-performance/target-manifest.json').read_text())
    receipt['target_source_head'] = git(target, 'rev-parse', 'HEAD')
    receipt['tool_head'] = git(tool, 'rev-parse', 'HEAD')
    receipt['host'] = snapshot(); receipt['node'] = node_facts(); receipt['npm_version'] = command('npm', '--version')
    receipt['npm_path'] = command('which', 'npm')
    actual = {name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in manifest['files']}
    receipt['target_hashes'] = actual
    version = command('sw_vers', '-productVersion'); build = command('sw_vers', '-buildVersion'); arch = command('uname', '-m')
    if (os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or os.environ.get('GITHUB_RUN_ATTEMPT') != '1' or
        os.environ.get('GITHUB_REF') != 'refs/heads/fix/beta3-macos-performance-diagnostic-20261103' or
        receipt['tool_head'] != receipt['diagnostic_head'] or receipt['target_source_head'] != manifest['target_head'] or
        git(target, 'status', '--porcelain') or git(tool, 'status', '--porcelain') or actual != manifest['files'] or
        receipt['runner_os'] != 'macOS' or receipt['runner_arch'] != 'ARM64' or not receipt['image_os'] or
        receipt['image_version'] != '20261026.0455.2' or version != '26.6.2' or build != '25G83' or
        arch != 'arm64' or receipt['node']['versions']['node'] != '20.20.2' or receipt['node']['arch'] != 'arm64' or
        receipt['npm_version'] != '10.8.2'):
        raise ValueError('Source, run, or conditional host admission mismatch')
    receipt['status'] = 'admitted'
except Exception as error:
    receipt['reason'] = str(error)
(out / 'admission.json').write_text(json.dumps(receipt, indent=2))
if receipt['status'] != 'admitted': sys.exit(1)
