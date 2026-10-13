"""Owned synthetic Linux Docker witness. Requires an already-built exact-source image.

No build/pull/deploy, ports, database, private inputs, policy update or forced stop.
The fixture command overrides main; default-entrypoint proof is a separate test.
"""
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
IMAGE = sys.argv[1] if len(sys.argv) == 3 else ''
SOURCE = sys.argv[2] if len(sys.argv) == 3 else ''
if not re.fullmatch(r'sha256:[a-f0-9]{64}', IMAGE) or not re.fullmatch(r'[a-f0-9]{40}', SOURCE):
    raise SystemExit('Require immutable tested image ID and exact source SHA')
if sys.platform != 'linux' or any(os.environ.get(k) for k in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY')):
    raise SystemExit('Requires reviewed isolated Linux runner with local Docker socket')
if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() != SOURCE:
    raise SystemExit('Source identity mismatch')

OWNER = '3054-engine-' + secrets.token_hex(8)
LABEL = 'org.dollhousemcp.owned-engine-proof'
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
DEADLINE = time.monotonic() + 180
resources = []
observed = []
completed_cases = []
phase = 'preflight'
case = 'none'
helper_results = []
compiled_modules = None
unsettled_helper = False
HELPER_DIAGNOSTICS = {
    'Docker command failed; replacement refused',
    'Docker command deadline reached; replacement refused',
    'Graceful stop deadline reached; replacement refused',
    'Graceful stop refused or timed out; old process retained, replacement refused',
    'Container boot changed during drain; replacement refused',
    'Verified memory drain or clean closure unavailable; replacement refused',
}


def command(args, limit=10, check=True):
    remaining = DEADLINE - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('Owned engine proof deadline reached; retain unsettled resources')
    result = subprocess.run(args, capture_output=True, text=True,
                            timeout=min(limit, remaining), check=False)
    if check and result.returncode:
        raise RuntimeError('Owned engine command failed')
    return result


def docker(*args, check=True):
    return command([*DOCKER, *args], check=check)


def inspect(cid):
    value = json.loads(docker('inspect', cid).stdout)[0]
    if value['Id'] != cid or value['Config']['Labels'].get(LABEL) != OWNER:
        raise RuntimeError('Owned container identity changed')
    if value['Image'] != IMAGE or value['HostConfig']['RestartPolicy']['Name'] != 'unless-stopped':
        raise RuntimeError('Image or restart policy changed')
    return value


def poll(body):
    until = min(DEADLINE, time.monotonic() + 15)
    while time.monotonic() < until:
        value = body()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError('Owned engine observation deadline reached')


def exec_js(cid, text):
    inspect(cid)
    return docker('exec', '--user', '1001:1001', cid, 'node', '-e', text)


def crash(cid):
    inspect(cid)
    result = docker('exec', '--user', '1001:1001', cid, 'node', '-e', "process.kill(1,'SIGUSR2')", check=False)
    # This intentional fault can interrupt its own exec process. The required
    # same-ID restart/newboot/latched-start checks remain the actual oracle.
    observed.append({'case': case, 'phase': 'intentional-crash-command', 'returncode': result.returncode})


def boots(cid):
    result = docker('exec', '--user', '1001:1001', cid, 'node', '-e',
                    "require('fs').readFile('/app/tmp/engine-observations.jsonl','utf8',(e,s)=>{if(e)process.exit(1);else process.stdout.write(s)})", check=False)
    if result.returncode:
        return []
    return [json.loads(line) for line in result.stdout.splitlines()]


def helper(cid, expected, gap=False):
    global unsettled_helper
    inspect(cid)
    env = {k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ}
    # Helper selects the same local socket; no ambient Docker endpoint is inherited.
    env['DOCKER_HOST'] = 'unix:///var/run/docker.sock'
    with tempfile.TemporaryDirectory(prefix='owned-3054-gap-') as directory:
        receipt = pathlib.Path(directory) / 'gap.json'
        if gap:
            real = shutil.which('docker')
            if not real:
                raise RuntimeError('Real Docker unavailable')
            shim = pathlib.Path(directory) / 'docker'
            shim.write_text('#!' + sys.executable + '\n' + (ROOT / 'tests/scripts/fixtures/memory-upgrade-engine-docker.py').read_text())
            shim.chmod(0o700)
            env.update(PATH=directory + os.pathsep + env['PATH'], OWNED_REAL_DOCKER=real,
                OWNED_ENGINE_GAP_CID=cid, OWNED_ENGINE_GAP_OWNER=OWNER, OWNED_ENGINE_GAP_IMAGE=IMAGE,
                OWNED_ENGINE_GAP_DEADLINE=str(time.monotonic()+3), OWNED_ENGINE_GAP_RECEIPT=str(receipt))
        try:
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/hosted-graceful-stop.py'), cid, '3'],
                                    env=env, capture_output=True, text=True, timeout=8, check=False)
        except subprocess.TimeoutExpired:
            unsettled_helper = True
            raise
        helper_results.append({'case': case, 'returncode': result.returncode,
            'fixedDiagnostic': result.stderr.strip() if result.stderr.strip() in HELPER_DIAGNOSTICS else 'none-or-unrecognized'})
        if gap:
            if not receipt.exists():
                raise RuntimeError('Deterministic gap was not observed')
            proof = json.loads(receipt.read_text())
            if proof.get('phase') != 'ack-term-gap-restarted' or proof.get('successorAdmissionClosed') is not True or proof.get('originalBootId') == proof.get('successorBootId'):
                raise RuntimeError('Deterministic gap evidence unavailable')
            observed.append({'case': 'ack-term-gap', 'receipt': proof})
    if result.returncode != expected:
        raise RuntimeError('Unexpected actual helper outcome')


def create(mode):
    global compiled_modules
    name = OWNER + '-' + mode
    if docker('container', 'inspect', name, check=False).returncode == 0:
        raise RuntimeError('Owned namespace collision')
    cid = docker('create', '--name', name, '--label', LABEL + '=' + OWNER,
                 '--restart', 'unless-stopped', '--network', network,
                 '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64',
                 '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                 '--no-healthcheck', '--user', '1001:1001', '--workdir', '/app',
                 '--env', 'DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR=/app/.memory-upgrade-control',
                 '--env', 'OWNED_ENGINE_MODE=' + mode,
                 '--mount', 'type=bind,src=' + str(ROOT / 'tests/scripts/fixtures/memory-upgrade-engine.mjs') + ',dst=/fixture/owner.mjs,readonly',
                 IMAGE, 'node', '/fixture/owner.mjs').stdout.strip()
    if not re.fullmatch(r'[a-f0-9]{64}', cid):
        raise RuntimeError('Created container identity unavailable')
    resources.append(cid)
    inspect(cid)
    docker('start', cid)
    poll(lambda: boots(cid))
    if compiled_modules is None:
        compiled_modules = json.loads(exec_js(cid, "const f=require('fs'),c=require('crypto');const names=['MemoryUpgradeControlState','MemoryUpgradeOperator','requestMemoryDrain','MemoryUpgradeLifecycle'];const out={};for(const name of names)out[name]=c.createHash('sha256').update(f.readFileSync('/app/dist/lifecycle/'+name+'.js')).digest('hex');process.stdout.write(JSON.stringify(out));").stdout)
        if len(compiled_modules) != 4 or any(not re.fullmatch(r'[a-f0-9]{64}', digest) for digest in compiled_modules.values()):
            raise RuntimeError('Compiled module identity unavailable')
    return cid


def stopped(cid):
    state = inspect(cid)['State']
    return not state['Running'] and not state['Restarting'] and state['ExitCode'] == 0 and not state['OOMKilled']


network = None
network_removed = False
failure = None
try:
    image = json.loads(docker('image', 'inspect', IMAGE).stdout)[0]
    if image['Id'] != IMAGE or image['Config']['Labels'].get('org.dollhousemcp.memory-upgrade-drain') != 'v2' or image['Config']['Labels'].get('org.dollhousemcp.engine-proof-source') != SOURCE:
        raise RuntimeError('V2 immutable image unavailable')
    phase = 'network-create'
    network = docker('network', 'create', '--internal', '--label', LABEL + '=' + OWNER, OWNER).stdout.strip()
    net = json.loads(docker('network', 'inspect', network).stdout)[0]
    if net['Id'] != network or not net['Internal'] or net['Labels'].get(LABEL) != OWNER:
        raise RuntimeError('Owned internal network unavailable')

    case = 'requested-restart-refuses'
    phase = 'create'
    cid = create('retained')
    before = inspect(cid)
    phase = 'initial-helper-refusal'
    helper(cid, 1)
    after = inspect(cid)
    if not after['State']['Running'] or after['RestartCount'] != before['RestartCount'] or after['State']['StartedAt'] != before['State']['StartedAt']:
        raise RuntimeError('Refusal changed original running process')
    phase = 'requested-real-restart'
    crash(cid)
    rows = poll(lambda: (r if len(r := boots(cid)) == 2 else None))
    if rows[1]['startup'] != 'requested' or not rows[1]['controlOnly'] or rows[1]['syntheticRootConstructed']:
        raise RuntimeError('Requested successor admitted an artificial owner')
    helper(cid, 1)
    observed.append({'case': 'requested-restart-refuses', 'bootCount': len(rows), 'restartCount': inspect(cid)['RestartCount']})
    completed_cases.append(case)

    case = 'known-drain-stable-stop'
    phase = 'create'
    cid = create('empty')
    phase = 'actual-helper-stop'
    helper(cid, 0)
    if not stopped(cid):
        raise RuntimeError('Known drain did not stop cleanly')
    count = inspect(cid)['RestartCount']
    time.sleep(1)
    if not stopped(cid) or inspect(cid)['RestartCount'] != count:
        raise RuntimeError('Successful manual stop restarted unexpectedly')
    observed.append({'case': 'known-drain-stable-stop', 'restartCount': count})
    completed_cases.append(case)

    case = 'lost-ack-drained-successor'
    phase = 'create'
    cid = create('successor')
    # Deliberately drop the ACK: the same socket still requests the actual drain.
    phase = 'drop-ack'
    exec_js(cid, "const n=require('net'),c=require('crypto'),s=n.createConnection('/app/.memory-upgrade-control/control.sock');const nonce=c.randomBytes(32).toString('hex');s.on('connect',()=>s.write(JSON.stringify({protocol:2,phase:'hello',nonce})+'\\n'));s.once('data',b=>{const hello=JSON.parse(b);s.write(JSON.stringify({protocol:2,phase:'drain',nonce,bootId:hello.bootId,containerId:'" + cid + "',remainingMs:3000})+'\\n',()=>s.destroy());});")
    poll(lambda: docker('exec', '--user', '1001:1001', cid, 'node', '-e',
         "const f=require('fs');process.exit(JSON.parse(f.readFileSync('/app/.memory-upgrade-control/state.json')).phase==='drained'?0:1)", check=False).returncode == 0)
    crash(cid)
    rows = poll(lambda: (r if len(r := boots(cid)) == 2 else None))
    if rows[1]['startup'] != 'drained' or not rows[1]['controlOnly'] or rows[1]['syntheticRootConstructed']:
        raise RuntimeError('Known-drained successor admitted an artificial owner')
    helper(cid, 0)
    if not stopped(cid):
        raise RuntimeError('Drained successor did not close cleanly')
    observed.append({'case': 'lost-ack-drained-successor', 'bootCount': len(rows), 'restartCount': inspect(cid)['RestartCount']})
    completed_cases.append(case)
    case = 'ack-term-gap'
    phase = 'create'
    cid = create('gap')
    phase = 'actual-helper-intercepted-final-term'
    helper(cid, 0, gap=True)
    if not stopped(cid):
        raise RuntimeError('Gap successor did not stop cleanly')
    completed_cases.append(case)
    phase = 'complete'
except Exception as error:
    failure = type(error).__name__
finally:
    # Separate settlement-only buffer; no acceptance command is retried here.
    DEADLINE = time.monotonic() + 30
    cleanup = []
    for cid in ([] if unsettled_helper else reversed(resources)):
        try:
            current = inspect(cid)
            if current['State']['Running']:
                # This witness contains no accepted app payload. Fixture-only
                # destruction is explicit and cannot qualify a product drain.
                exec_js(cid, "require('fs').writeFileSync('/app/tmp/engine-disposable-cleanup','1')")
                docker('kill', '--signal=TERM', cid)
                poll(lambda: stopped(cid))
            if not stopped(cid):
                raise RuntimeError('Owned child unsettled; retain resource')
            docker('rm', cid)
            if docker('container', 'ls', '-aq', '--filter', 'id=' + cid).stdout.strip():
                raise RuntimeError('Owned child absence unproved')
            cleanup.append(cid)
        except Exception:
            failure = failure or 'OwnedCleanupRefused'
    if network and not unsettled_helper and len(cleanup) == len(resources):
        try:
            net = json.loads(docker('network', 'inspect', network).stdout)[0]
            if net['Id'] != network or net['Labels'].get(LABEL) != OWNER:
                raise RuntimeError('Owned network identity changed')
            docker('network', 'rm', network)
            if docker('network', 'ls', '-q', '--filter', 'id=' + network).stdout.strip():
                raise RuntimeError('Owned network absence unproved')
            network_removed = True
        except Exception:
            failure = failure or 'OwnedNetworkCleanupRefused'
    print(json.dumps({'success': failure is None, 'source': SOURCE, 'image': IMAGE, 'owner': OWNER,
                      'case': case, 'phase': phase, 'helperResults': helper_results,
                      'compiledControlModules': compiled_modules,
                      'completedCases': completed_cases,
                      'networkId': network, 'networkRemoved': network_removed,
                      'unsettledHelperResourcesRetained': unsettled_helper,
                      'observations': observed, 'closedAndRemoved': cleanup, 'failureClass': failure,
                      'scope': 'synthetic operator/lifecycle and real Docker; no default app/bootstrap or durable payload proof'}))
sys.exit(1 if failure else 0)
